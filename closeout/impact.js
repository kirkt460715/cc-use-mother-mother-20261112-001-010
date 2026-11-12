import { Registers, TABLES } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';
import { changePlan, applyOperations } from '../ledger/events.js';
import { reconcile } from '../matching/reconcile.js';
import { byProject, byCounty } from '../portfolio/metrics.js';
import { digest, fields, id, integer, Invalid } from '../ledger/values.js';

export function compareVersions(beforeRegisters, afterRegisters, beforeMatches, afterMatches) {
  const registerChanges = changePlan(beforeRegisters, afterRegisters);
  const oldMatch = new Map(beforeMatches.active().map(row => [row.id, row]));
  const newMatch = new Map(afterMatches.active().map(row => [row.id, row]));
  const changedMatches = [];
  for (const key of [...new Set([...oldMatch.keys(), ...newMatch.keys()])].sort()) {
    if (digest(oldMatch.get(key) ?? null) !== digest(newMatch.get(key) ?? null)) {
      changedMatches.push({ id: key, before: oldMatch.get(key) ?? null, after: newMatch.get(key) ?? null });
    }
  }
  const projects = new Set(registerChanges.affected_projects);
  for (const row of changedMatches) {
    for (const match of [row.before, row.after]) {
      if (!match) {
        continue;
      }
      if (match.source_ledger === 'disbursement') {
        const disbursement = (match === row.before ? beforeRegisters : afterRegisters).disbursements.get(match.source_id);
        if (disbursement) {
          const appropriation = (match === row.before ? beforeRegisters : afterRegisters).appropriations.get(disbursement.appropriation);
          if (appropriation) projects.add(appropriation.project);
        }
      }
      if (match.target_ledger === 'expense') {
        const expense = (match === row.before ? beforeRegisters : afterRegisters).expenses.get(match.target_id);
        if (expense) projects.add(expense.project);
      }
    }
  }
  return { before_register_digest: beforeRegisters.fingerprint, after_register_digest: afterRegisters.fingerprint,
    before_match_digest: beforeMatches.fingerprint, after_match_digest: afterMatches.fingerprint,
    register_changes: registerChanges.changes, changed_matches: changedMatches,
    affected_projects: [...projects].sort(),
    county_rollups_affected: [...new Set([...beforeRegisters.projects.values(), ...afterRegisters.projects.values()].filter(row => projects.has(row.id)).map(row => row.county))].sort(),
    all_aggregates_require_recomputation: registerChanges.changes.length > 0 || changedMatches.length > 0 };
}

export function patch(base, operations) {
  const after = applyOperations(base, operations);
  return { operations, before_digest: base.fingerprint, after_digest: after.fingerprint,
    affected_projects: changePlan(base, after).affected_projects,
    full_register_validation: true };
}

export function closeoutDelta(beforeRegisters, afterRegisters, beforeMatches, afterMatches, period, cutoff) {
  integer(cutoff, 'cutoff', 20000101, 21001231);
  const before = reconcile(beforeRegisters, beforeMatches, { date_cutoff: cutoff });
  const after = reconcile(afterRegisters, afterMatches, { date_cutoff: cutoff });
  const keys = ['disbursed_cents', 'spent_cents', 'matched_cents', 'disbursed_minus_spent_cents'];
  return { period, prior_report: before, revised_report: after,
    delta: Object.fromEntries(keys.map(key => [key, after.totals[key] - before.totals[key]])),
    prior_snapshot_mutated: false,
    note: 'restatement_recomputed_from_complete_versioned_sources' };
}

export function traceRegisterEntity(registers, table, key) {
  if (!TABLES.includes(table)) {
    throw new Invalid('unknown register table');
  }
  id(key);
  const entity = registers[table].get(key);
  if (!entity) {
    throw new Invalid('entity missing');
  }
  const related = { project: new Set(), appropriation: new Set(), disbursement: new Set(), expense: new Set(), milestone: new Set(), deliverable: new Set(), reversal: new Set() };
  related[table === 'projects' ? 'project' : table === 'appropriations' ? 'appropriation' : table === 'disbursements' ? 'disbursement' : table === 'expenses' ? 'expense' : table === 'milestones' ? 'milestone' : table === 'deliverables' ? 'deliverable' : 'reversal'].add(key);
  if (table === 'projects') {
    for (const row of registers.appropriations.values()) if (row.project === key) related.appropriation.add(row.id);
    for (const row of registers.expenses.values()) if (row.project === key) related.expense.add(row.id);
    for (const row of registers.milestones.values()) if (row.project === key) related.milestone.add(row.id);
  }
  if (table === 'appropriations') {
    for (const row of registers.disbursements.values()) if (row.appropriation === key) related.disbursement.add(row.id);
  }
  if (table === 'milestones') {
    for (const row of registers.deliverables.values()) if (row.milestone === key) related.deliverable.add(row.id);
  }
  if (table === 'disbursements') {
    for (const row of registers.reversals.values()) if (row.disbursement === key || row.reversal_of === key) related.reversal.add(row.id);
  }
  return { table, id: key, record: entity, record_digest: digest(entity),
    related: Object.fromEntries(Object.entries(related).map(([name, values]) => [name, [...values].sort()])),
    synthetic_account_data_only: true };
}

export function auditReplayedImpact(before, after, matchesBefore, matchesAfter, claimed) {
  const expected = compareVersions(before, after, matchesBefore, matchesAfter);
  if (digest(expected) !== digest(claimed)) {
    throw new Invalid('impact report differs from source replay');
  }
  return { valid: true, projects: expected.affected_projects.length,
    matches: expected.changed_matches.length };
}
