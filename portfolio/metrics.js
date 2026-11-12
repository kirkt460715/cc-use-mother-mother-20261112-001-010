import { Registers, appropriationBalance, netCash } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';
import { balances, reconcile } from '../matching/reconcile.js';
import { money, dollars, integer, ratio, Invalid } from '../ledger/values.js';

export function byProject(registers, ledger, cutoff = 21001231) {
  integer(cutoff, 'cutoff', 20000101, 21001231);
  const output = [];
  for (const project of registers.projects.values()) {
    const appropriations = [...registers.appropriations.values()].filter(row => row.project === project.id);
    const appropriationIds = new Set(appropriations.map(row => row.id));
    const disbursements = [...registers.disbursements.values()].filter(row => appropriationIds.has(row.appropriation) && row.date <= cutoff);
    const expenses = [...registers.expenses.values()].filter(row => row.project === project.id && row.date <= cutoff);
    const milestones = [...registers.milestones.values()].filter(row => row.project === project.id);
    const deliverables = [...registers.deliverables.values()].filter(row => row.project === project.id && row.accepted_date !== null && row.accepted_date <= cutoff);
    const authorized = appropriations.reduce((sum, row) => sum + money(row.authorized), 0);
    const disbursed = disbursements.reduce((sum, row) => sum + (row.kind === 'payment' ? money(row.amount) : 0), 0);
    const refunds = disbursements.reduce((sum, row) => sum + (row.kind === 'refund' ? money(row.amount) : 0), 0);
    const grossExpense = expenses.reduce((sum, row) => sum + money(row.amount), 0);
    const matchedOut = ledger.active().filter(row => row.source_ledger === 'disbursement' && disbursements.some(item => item.id === row.source_id)).reduce((sum, row) => sum + row.amount_cents, 0);
    const matchedIn = ledger.active().filter(row => row.target_ledger === 'expense' && expenses.some(item => item.id === row.target_id)).reduce((sum, row) => sum + row.amount_cents, 0);
    const acceptedUnits = deliverables.reduce((sum, row) => sum + row.units, 0);
    const requiredMilestones = milestones.filter(row => row.required);
    const acceptedMilestones = new Set(deliverables.map(row => row.milestone));
    output.push({
      project: project.id,
      county: project.county,
      program: project.program,
      status: project.status,
      authorized_cents: authorized,
      gross_disbursed_cents: disbursed,
      refunded_cents: refunds,
      net_disbursed_cents: disbursed - refunds,
      expenses_cents: grossExpense,
      match_cents_out: matchedOut,
      match_cents_in: matchedIn,
      disbursement_unmatched_cents: disbursed - refunds - matchedOut,
      expense_unmatched_cents: grossExpense - matchedIn,
      remaining_authorized_cents: authorized - disbursed + refunds,
      committed_units: acceptedUnits,
      required_milestones: requiredMilestones.length,
      accepted_required_milestones: requiredMilestones.filter(row => acceptedMilestones.has(row.id)).length,
      authorization_utilization: ratio(disbursed - refunds, authorized),
      accepted_milestone_completion: ratio(requiredMilestones.filter(row => acceptedMilestones.has(row.id)).length, requiredMilestones.length),
      synthetic_name: project.name
    });
  }
  return output.sort((a, b) => a.project.localeCompare(b.project));
}

export function byCounty(registers, ledger, cutoff = 21001231) {
  const rows = new Map();
  for (const project of byProject(registers, ledger, cutoff)) {
    if (!rows.has(project.county)) {
      rows.set(project.county, { county: project.county, projects: 0, authorized_cents: 0,
        net_disbursed_cents: 0, expenses_cents: 0, disbursement_unmatched_cents: 0,
        expense_unmatched_cents: 0, committed_units: 0 });
    }
    const group = rows.get(project.county);
    group.projects += 1;
    for (const key of ['authorized_cents', 'net_disbursed_cents', 'expenses_cents',
      'disbursement_unmatched_cents', 'expense_unmatched_cents', 'committed_units']) {
      group[key] += project[key];
      if (!Number.isSafeInteger(group[key])) {
        throw new Invalid('county aggregate exceeds safe integer');
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.county.localeCompare(b.county));
}

export function byFiscalYear(registers, start, end) {
  integer(start, 'start', 2000, 2100);
  integer(end, 'end', start, 2100);
  const years = new Map();
  for (let year = start; year <= end; year += 1) {
    years.set(year, { fiscal_year: year, authorized_cents: 0, disbursed_cents: 0,
      refunds_cents: 0, expenses_cents: 0, accepted_units: 0, first_time_projects: 0 });
  }
  const firstYear = new Map();
  for (const project of registers.projects.values()) {
    const current = firstYear.get(project.id);
    if (current === undefined || project.start < current) {
      firstYear.set(project.id, project.start);
    }
  }
  for (const appropriation of registers.appropriations.values()) {
    if (years.has(appropriation.fiscal_year)) {
      years.get(appropriation.fiscal_year).authorized_cents += money(appropriation.authorized);
    }
  }
  for (const row of registers.disbursements.values()) {
    const year = Math.floor(row.date / 10000);
    if (years.has(year)) {
      years.get(year)[row.kind === 'refund' ? 'refunds_cents' : 'disbursed_cents'] += row.kind === 'void' ? 0 : money(row.amount);
    }
  }
  for (const row of registers.expenses.values()) {
    const year = Math.floor(row.date / 10000);
    if (years.has(year)) {
      years.get(year).expenses_cents += money(row.amount);
    }
  }
  for (const row of registers.deliverables.values()) {
    if (row.accepted_date === null) {
      continue;
    }
    const year = Math.floor(row.accepted_date / 10000);
    if (years.has(year)) {
      years.get(year).accepted_units += row.units;
    }
  }
  for (const year of years.values()) {
    year.net_disbursed_cents = year.disbursed_cents - year.refunds_cents;
    year.cumulative_net_disbursed_cents = [...years.values()].filter(row => row.fiscal_year <= year.fiscal_year).reduce((sum, row) => sum + row.disbursed_cents - row.refunds_cents, 0);
  }
  return [...years.values()];
}

export function projectDetail(registers, ledger, projectId, cutoff = 21001231) {
  const project = registers.projects.get(projectId);
  if (!project) {
    throw new Invalid('unknown project');
  }
  const appropriationIds = [...registers.appropriations.values()].filter(row => row.project === projectId).map(row => row.id);
  const disbursementIds = new Set([...registers.disbursements.values()].filter(row => appropriationIds.includes(row.appropriation) && row.date <= cutoff).map(row => row.id));
  const expenseIds = new Set([...registers.expenses.values()].filter(row => row.project === projectId && row.date <= cutoff).map(row => row.id));
  return {
    project,
    appropriations: [...registers.appropriations.values()].filter(row => row.project === projectId),
    disbursements: [...registers.disbursements.values()].filter(row => disbursementIds.has(row.id)),
    expenses: [...registers.expenses.values()].filter(row => expenseIds.has(row.id)),
    milestones: [...registers.milestones.values()].filter(row => row.project === projectId),
    deliverables: [...registers.deliverables.values()].filter(row => row.project === projectId),
    matches: ledger.active().filter(row => (row.source_ledger === 'disbursement' && disbursementIds.has(row.source_id)) || (row.target_ledger === 'expense' && expenseIds.has(row.target_id))),
    metrics: byProject(registers, ledger, cutoff).find(row => row.project === projectId),
    access: 'restricted_project_records'
  };
}

export function sensitivity(registers, ledger, cutoff, excludedProjects) {
  if (!Array.isArray(excludedProjects) || new Set(excludedProjects).size !== excludedProjects.length) {
    throw new Invalid('unique excluded project list required');
  }
  const excluded = new Set(excludedProjects);
  for (const key of excluded) {
    if (!registers.projects.has(key)) {
      throw new Invalid('unknown sensitivity project');
    }
  }
  const result = byProject(registers, ledger, cutoff).filter(row => !excluded.has(row.project));
  return { excluded_projects: [...excluded].sort(), remaining_projects: result.length,
           authorized_cents: result.reduce((sum, row) => sum + row.authorized_cents, 0),
           net_disbursed_cents: result.reduce((sum, row) => sum + row.net_disbursed_cents, 0),
           expenses_cents: result.reduce((sum, row) => sum + row.expenses_cents, 0),
           recomputed_from_source_rows: true };
}
