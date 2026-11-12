import { cashEffect, appropriationBalance } from '../ledger/registers.js';
import { money, ratio, integer, id, digest, Invalid } from '../ledger/values.js';

const PRIORITY = { critical: 0, warning: 1, information: 2 };

function issue(code, severity, entity, amount, detail) {
  return { code, severity, entity, amount_cents: amount, detail };
}

function amountOf(row) {
  return money(row.amount);
}

function addSafe(target, key, value) {
  const next = target[key] + value;
  if (!Number.isSafeInteger(next)) {
    throw new Invalid('control aggregation exceeds safe integer');
  }
  target[key] = next;
}

function addMapSafe(target, key, value) {
  const next = (target.get(key) ?? 0) + value;
  if (!Number.isSafeInteger(next)) {
    throw new Invalid('control allocation exceeds safe integer');
  }
  target.set(key, next);
}

export function controlReport(registers, matches, asOf, policy = {}) {
  integer(asOf, 'as of date', 20000101, 21001231);
  const lateDays = policy.milestone_grace_days ?? 0;
  const materiality = policy.materiality_cents ?? 0;
  if (!Number.isSafeInteger(lateDays) || lateDays < 0 || lateDays > 3650) {
    throw new Invalid('milestone grace days out of range');
  }
  if (!Number.isSafeInteger(materiality) || materiality < 0) {
    throw new Invalid('materiality must be a non-negative integer');
  }

  const issues = [];
  const validSources = new Map([
    ['disbursement', registers.disbursements],
    ['expense', registers.expenses]
  ]);
  const sourceUse = new Map();
  const targetUse = new Map();
  for (const match of matches.active()) {
    const sourceMap = validSources.get(match.source_ledger);
    const targetMap = validSources.get(match.target_ledger);
    const source = sourceMap.get(match.source_id);
    const target = targetMap.get(match.target_id);
    if (!source || !target) {
      issues.push(issue('MATCH_REFERENCE_MISSING', 'critical', match.id, match.amount_cents,
        'active allocation references a missing source row'));
      continue;
    }
    const sourceKey = `${match.source_ledger}:${match.source_id}`;
    const targetKey = `${match.target_ledger}:${match.target_id}`;
    addMapSafe(sourceUse, sourceKey, match.amount_cents);
    addMapSafe(targetUse, targetKey, match.amount_cents);
    if (match.created_at > asOf) {
      issues.push(issue('MATCH_AFTER_CUTOFF', 'warning', match.id, match.amount_cents,
        'active allocation is newer than the control date'));
    }
  }

  for (const [ledgerName, rows] of validSources) {
    for (const row of rows.values()) {
      const date = row.date;
      if (date > asOf) {
        continue;
      }
      const key = `${ledgerName}:${row.id}`;
      const used = (sourceUse.get(key) ?? 0) + (targetUse.get(key) ?? 0);
      const gross = amountOf(row);
      if (ledgerName === 'disbursement' && row.kind !== 'payment') {
        continue;
      }
      if (used > gross) {
        issues.push(issue('ALLOCATION_EXCEEDS_ROW', 'critical', row.id, used - gross,
          `${ledgerName} allocation exceeds its source amount`));
      } else if (gross - used > materiality) {
        issues.push(issue(ledgerName === 'disbursement' ? 'PAYMENT_UNMATCHED' : 'EXPENSE_UNMATCHED',
          'warning', row.id, gross - used, `${ledgerName} amount remains unreconciled`));
      }
      if (ledgerName === 'expense' && used === 0 && gross > materiality) {
        issues.push(issue('EXPENSE_WITHOUT_FUNDING_TRACE', 'warning', row.id, gross,
          'expense has no active disbursement allocation'));
      }
    }
  }

  for (const [id, row] of registers.appropriations) {
    const balance = appropriationBalance(registers, id);
    if (balance.overdrawn && balance.net_disbursed_cents - balance.authorized_cents > materiality) {
      issues.push(issue('APPROPRIATION_OVERDRAWN', 'critical', id,
        balance.net_disbursed_cents - balance.authorized_cents,
        'net disbursement exceeds authorized amount'));
    }
    if (row.fiscal_year * 10000 + 1231 > asOf && balance.remaining_cents > materiality) {
      issues.push(issue('UNSPENT_CURRENT_AUTHORIZATION', 'information', id,
        balance.remaining_cents, 'authorization is still within its fiscal year'));
    }
  }

  const accepted = new Set([...registers.deliverables.values()]
    .filter(row => row.accepted_date !== null && row.accepted_date <= asOf)
    .map(row => row.milestone));
  for (const milestone of registers.milestones.values()) {
    if (!milestone.required || accepted.has(milestone.id)) {
      continue;
    }
    const due = milestone.due_date;
    const date = new Date(Date.UTC(Math.floor(due / 10000), Math.floor(due / 100) % 100 - 1, due % 100));
    date.setUTCDate(date.getUTCDate() + lateDays);
    const adjusted = date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
    if (adjusted <= asOf) {
      issues.push(issue('REQUIRED_MILESTONE_LATE', 'warning', milestone.id, 0,
        `required milestone due ${due} has no accepted deliverable`));
    }
  }

  issues.sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity]
    || a.code.localeCompare(b.code) || a.entity.localeCompare(b.entity));
  const totals = { critical: 0, warning: 0, information: 0, amount_cents: 0 };
  for (const finding of issues) {
    totals[finding.severity] += 1;
    if (finding.severity !== 'information') {
      addSafe(totals, 'amount_cents', finding.amount_cents);
    }
  }
  const payload = { as_of: asOf, policy: { milestone_grace_days: lateDays, materiality_cents: materiality },
    register_fingerprint: registers.fingerprint, match_fingerprint: matches.fingerprint, totals, issues };
  return { ...payload, report_digest: digest(payload) };
}

export function verifyControlReport(registers, matches, report) {
  if (!report || !Array.isArray(report.issues) || !report.totals || !report.policy) {
    throw new Invalid('control report shape invalid');
  }
  const rebuilt = controlReport(registers, matches, report.as_of, report.policy);
  const { report_digest: suppliedDigest, ...payload } = report;
  if (digest(payload) !== suppliedDigest || rebuilt.report_digest !== suppliedDigest
      || rebuilt.register_fingerprint !== report.register_fingerprint
      || rebuilt.match_fingerprint !== report.match_fingerprint) {
    throw new Invalid('control report is stale or altered');
  }
  return { valid: true, report_digest: rebuilt.report_digest, issues: rebuilt.issues.length };
}

export function exposureByProgram(registers, asOf) {
  integer(asOf, 'as of date', 20000101, 21001231);
  const programs = new Map();
  for (const project of registers.projects.values()) {
    if (!programs.has(project.program)) {
      programs.set(project.program, { program: project.program, projects: 0,
        authorized_cents: 0, net_cash_cents: 0, expenses_cents: 0,
        accepted_units: 0, open_milestones: 0 });
    }
    programs.get(project.program).projects += 1;
  }
  for (const appropriation of registers.appropriations.values()) {
    const group = programs.get(registers.projects.get(appropriation.project).program);
    addSafe(group, 'authorized_cents', money(appropriation.authorized));
  }
  for (const row of registers.disbursements.values()) {
    if (row.date > asOf) {
      continue;
    }
    const appropriation = registers.appropriations.get(row.appropriation);
    const group = programs.get(registers.projects.get(appropriation.project).program);
    addSafe(group, 'net_cash_cents', cashEffect(registers, row));
  }
  for (const row of registers.expenses.values()) {
    if (row.date <= asOf) {
      const group = programs.get(registers.projects.get(row.project).program);
      addSafe(group, 'expenses_cents', amountOf(row));
    }
  }
  for (const row of registers.deliverables.values()) {
    if (row.accepted_date !== null && row.accepted_date <= asOf) {
      const group = programs.get(registers.projects.get(row.project).program);
      addSafe(group, 'accepted_units', row.units);
    }
  }
  const acceptedMilestones = new Set([...registers.deliverables.values()]
    .filter(row => row.accepted_date !== null && row.accepted_date <= asOf)
    .map(row => row.milestone));
  for (const row of registers.milestones.values()) {
    if (row.required && !acceptedMilestones.has(row.id)) {
      const group = programs.get(registers.projects.get(row.project).program);
      addSafe(group, 'open_milestones', 1);
    }
  }
  return [...programs.values()].map(group => ({ ...group,
    cash_to_authorization: ratio(group.net_cash_cents, group.authorized_cents),
    expense_to_cash: ratio(group.expenses_cents, group.net_cash_cents)
  })).sort((a, b) => a.program.localeCompare(b.program));
}

export function explainControlFinding(registers, matches, report, code, entityId) {
  verifyControlReport(registers, matches, report);
  id(entityId, 'finding entity');
  const finding = report.issues.find(row => row.code === code && row.entity === entityId);
  if (!finding) {
    throw new Invalid('control finding does not exist in this report');
  }
  const evidence = [];
  const include = (table, row) => {
    if (row) {
      evidence.push({ table, id: row.id, digest: digest(row) });
    }
  };
  if (code === 'MATCH_REFERENCE_MISSING' || code === 'MATCH_AFTER_CUTOFF') {
    include('match', matches.matches.get(entityId));
  } else if (code === 'PAYMENT_UNMATCHED'
      || (code === 'ALLOCATION_EXCEEDS_ROW' && registers.disbursements.has(entityId))) {
    const payment = registers.disbursements.get(entityId);
    include('disbursement', payment);
    if (payment) {
      const linked = [...registers.reversals.values()].filter(row => row.reversal_of === entityId);
      linked.forEach(row => include('reversal', row));
    }
    for (const match of matches.active().filter(row => row.source_ledger === 'disbursement' && row.source_id === entityId)) {
      include('match', match);
    }
  } else if (code === 'EXPENSE_UNMATCHED' || code === 'EXPENSE_WITHOUT_FUNDING_TRACE'
      || (code === 'ALLOCATION_EXCEEDS_ROW' && registers.expenses.has(entityId))) {
    include('expense', registers.expenses.get(entityId));
    for (const match of matches.active().filter(row => row.target_ledger === 'expense' && row.target_id === entityId)) {
      include('match', match);
    }
  } else if (code === 'APPROPRIATION_OVERDRAWN' || code === 'UNSPENT_CURRENT_AUTHORIZATION') {
    include('appropriation', registers.appropriations.get(entityId));
    const appropriation = registers.appropriations.get(entityId);
    if (appropriation) {
      for (const row of registers.disbursements.values()) {
        if (row.appropriation === entityId && row.date <= report.as_of) {
          include('disbursement', row);
          if (row.kind === 'refund') {
            const reversal = [...registers.reversals.values()].find(item => item.disbursement === row.id);
            include('reversal', reversal);
          }
        }
      }
    }
  } else if (code === 'REQUIRED_MILESTONE_LATE') {
    const milestone = registers.milestones.get(entityId);
    include('milestone', milestone);
    if (milestone) {
      for (const row of registers.deliverables.values()) {
        if (row.milestone === entityId) {
          include('deliverable', row);
        }
      }
    }
  }
  evidence.sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
  const body = { report_digest: report.report_digest, finding: { code, entity: entityId,
    severity: finding.severity, amount_cents: finding.amount_cents }, evidence };
  return { ...body, trace_digest: digest(body) };
}

export function compareExposureDates(registers, earlierDate, laterDate) {
  integer(earlierDate, 'earlier date', 20000101, 21001231);
  integer(laterDate, 'later date', earlierDate, 21001231);
  const before = new Map(exposureByProgram(registers, earlierDate).map(row => [row.program, row]));
  const after = new Map(exposureByProgram(registers, laterDate).map(row => [row.program, row]));
  const numeric = ['projects', 'authorized_cents', 'net_cash_cents', 'expenses_cents', 'accepted_units', 'open_milestones'];
  const programs = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const first = before.get(key);
    const last = after.get(key);
    const changes = Object.fromEntries(numeric.map(field => [field,
      (last?.[field] ?? 0) - (first?.[field] ?? 0)]));
    programs.push({ program: key, before: first ?? null, after: last ?? null, change: changes });
  }
  const body = { earlier_date: earlierDate, later_date: laterDate, programs,
    interpretation: 'descriptive_change_between_source_cutoffs_not_causal_effect' };
  return { ...body, digest: digest(body) };
}

export function verifyExposureComparison(registers, report) {
  if (!report || !Array.isArray(report.programs) || !Number.isSafeInteger(report.earlier_date)
      || !Number.isSafeInteger(report.later_date)) {
    throw new Invalid('exposure comparison shape invalid');
  }
  const { digest: suppliedDigest, ...body } = report;
  if (digest(body) !== suppliedDigest) {
    throw new Invalid('exposure comparison digest mismatch');
  }
  const rebuilt = compareExposureDates(registers, report.earlier_date, report.later_date);
  if (rebuilt.digest !== suppliedDigest) {
    throw new Invalid('exposure comparison is stale');
  }
  return { valid: true, programs: report.programs.length, digest: suppliedDigest };
}
