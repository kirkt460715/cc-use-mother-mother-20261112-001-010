import { Registers, cashEffect } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';
import { balances, reconcile } from '../matching/reconcile.js';
import { byProject, byCounty, byFiscalYear, projectDetail, sensitivity } from './metrics.js';
import { money, integer, ratio, id, Invalid } from '../ledger/values.js';

export function comparePrograms(registers, ledger, leftProgram, rightProgram, cutoff = 21001231) {
  id(leftProgram, 'left program');
  id(rightProgram, 'right program');
  if (leftProgram === rightProgram) {
    throw new Invalid('programs must differ');
  }
  const rows = byProject(registers, ledger, cutoff);
  const summarize = program => {
    const projects = rows.filter(row => row.program === program);
    const authorized = projects.reduce((sum, row) => sum + row.authorized_cents, 0);
    const net = projects.reduce((sum, row) => sum + row.net_disbursed_cents, 0);
    const expenses = projects.reduce((sum, row) => sum + row.expenses_cents, 0);
    const units = projects.reduce((sum, row) => sum + row.committed_units, 0);
    const milestones = projects.reduce((sum, row) => sum + row.required_milestones, 0);
    const accepted = projects.reduce((sum, row) => sum + row.accepted_required_milestones, 0);
    return { program, projects: projects.length, authorized_cents: authorized,
      net_disbursed_cents: net, expenses_cents: expenses, units,
      milestone_completion: ratio(accepted, milestones), utilization: ratio(net, authorized) };
  };
  const left = summarize(leftProgram);
  const right = summarize(rightProgram);
  return { left, right, difference: {
    projects: right.projects - left.projects,
    authorized_cents: right.authorized_cents - left.authorized_cents,
    net_disbursed_cents: right.net_disbursed_cents - left.net_disbursed_cents,
    expenses_cents: right.expenses_cents - left.expenses_cents,
    units: right.units - left.units
  }, interpretation: 'descriptive_portfolio_comparison_not_causal_effect' };
}

export function quarterly(registers, ledger, year, cutoff = 21001231) {
  integer(year, 'year', 2000, 2100);
  const rows = [];
  for (let quarter = 1; quarter <= 4; quarter += 1) {
    const lowerMonth = (quarter - 1) * 3 + 1;
    const upperMonth = lowerMonth + 3;
    const first = year * 10000 + lowerMonth * 100 + 1;
    const last = upperMonth === 13 ? (year + 1) * 10000 + 101 : year * 10000 + upperMonth * 100 + 1;
    const effectiveCutoff = Math.min(cutoff, last - 1);
    const disbursements = [...registers.disbursements.values()].filter(row => row.date >= first && row.date < last && row.date <= effectiveCutoff);
    const expenses = [...registers.expenses.values()].filter(row => row.date >= first && row.date < last && row.date <= effectiveCutoff);
    const accepted = [...registers.deliverables.values()].filter(row => row.accepted_date !== null && row.accepted_date >= first && row.accepted_date < last && row.accepted_date <= effectiveCutoff);
    rows.push({ quarter, start: first, end_exclusive: last,
      gross_disbursed_cents: disbursements.reduce((sum, row) => sum + (row.kind === 'payment' ? money(row.amount) : 0), 0),
      refund_cents: disbursements.reduce((sum, row) => sum + (row.kind === 'refund' ? money(row.amount) : 0), 0),
      expenses_cents: expenses.reduce((sum, row) => sum + money(row.amount), 0),
      accepted_units: accepted.reduce((sum, row) => sum + row.units, 0),
      activity: disbursements.length + expenses.length + accepted.length > 0 });
  }
  return { year, rows, assignment: 'event_date_quarter_not_cash_to_expense_match_period', cutoff };
}

export function exceptions(registers, ledger, cutoff = 21001231) {
  const output = [];
  for (const row of balances(registers, ledger, 'disbursement', cutoff)) {
    if (row.available_cents > 0) {
      output.push({ code: 'unmatched_disbursement', ledger: 'disbursement', id: row.id,
        amount_cents: row.available_cents, project: registers.appropriations.get(row.appropriation).project });
    }
  }
  for (const row of balances(registers, ledger, 'expense', cutoff)) {
    if (row.available_cents > 0) {
      output.push({ code: 'unmatched_expense', ledger: 'expense', id: row.id,
        amount_cents: row.available_cents, project: row.project });
    }
  }
  for (const project of registers.projects.values()) {
    const milestones = [...registers.milestones.values()].filter(row => row.project === project.id && row.required && row.due_date <= cutoff);
    for (const milestone of milestones) {
      const accepted = [...registers.deliverables.values()].some(row => row.milestone === milestone.id && row.accepted_date !== null && row.accepted_date <= cutoff);
      if (!accepted) {
        output.push({ code: 'required_milestone_not_accepted', ledger: 'deliverable', id: milestone.id,
          amount_cents: 0, project: project.id });
      }
    }
  }
  output.sort((a, b) => a.code.localeCompare(b.code) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  return { rows: output, total_amount_cents: output.reduce((sum, row) => sum + row.amount_cents, 0),
    report_noncausal_exceptions_only: true };
}

export function dashboard(registers, ledger, cutoff = 21001231) {
  const projects = byProject(registers, ledger, cutoff);
  const counties = byCounty(registers, ledger, cutoff);
  const years = byFiscalYear(registers, 2000, 2100).filter(row => row.fiscal_year <= Math.floor(cutoff / 10000));
  const allAppropriations = [...registers.appropriations.values()];
  const authorized = allAppropriations.reduce((sum, row) => sum + money(row.authorized), 0);
  const disbursed = projects.reduce((sum, row) => sum + row.net_disbursed_cents, 0);
  const expense = projects.reduce((sum, row) => sum + row.expenses_cents, 0);
  return { cutoff, projects, counties, years,
    totals: { projects: projects.length, counties: counties.length, authorized_cents: authorized,
      net_disbursed_cents: disbursed, expenses_cents: expense,
      remaining_authorized_cents: authorized - disbursed,
      authorization_utilization: ratio(disbursed, authorized),
      expense_to_disbursement: ratio(expense, disbursed) },
    unit_cost: costPerAcceptedUnit(registers, cutoff),
    caveats: ['project_name_is_restricted', 'expenditure_is_not_proof_of_delivered_outcome',
      'unmatched_is_not_proof_of_misuse', 'no_causal_outcome_claim'] };
}

export function costPerAcceptedUnit(registers, cutoff = 21001231) {
  integer(cutoff, 'cutoff', 20000101, 21001231);
  const rows = [];
  for (const project of registers.projects.values()) {
    const expenses = [...registers.expenses.values()].filter(row => row.project === project.id && row.date <= cutoff);
    const outputs = [...registers.deliverables.values()].filter(row => row.project === project.id
      && row.accepted_date !== null && row.accepted_date <= cutoff);
    const expenseCents = expenses.reduce((sum, row) => sum + money(row.amount), 0);
    const units = outputs.reduce((sum, row) => sum + row.units, 0);
    rows.push({ project: project.id, expense_cents: expenseCents, accepted_units: units,
      expense_per_accepted_unit: ratio(expenseCents, units),
      interpretation: units === 0 ? 'no_accepted_unit_denominator' : 'descriptive_cost_ratio_only' });
  }
  return rows.sort((a, b) => a.project.localeCompare(b.project));
}

export function validatePortfolio(registers, ledger, report) {
  const projectRows = byProject(registers, ledger, report.cutoff);
  const countyRows = byCounty(registers, ledger, report.cutoff);
  const projectAuthorized = projectRows.reduce((sum, row) => sum + row.authorized_cents, 0);
  const countyAuthorized = countyRows.reduce((sum, row) => sum + row.authorized_cents, 0);
  if (projectAuthorized !== countyAuthorized) {
    throw new Invalid('county and project authorization aggregates disagree');
  }
  const projectSpent = projectRows.reduce((sum, row) => sum + row.expenses_cents, 0);
  const sourceSpent = [...registers.expenses.values()].filter(row => row.date <= report.cutoff).reduce((sum, row) => sum + money(row.amount), 0);
  if (projectSpent !== sourceSpent) {
    throw new Invalid('project expense aggregate does not conserve source ledger');
  }
  return { valid: true, projects: projectRows.length, counties: countyRows.length,
    authorized_cents: projectAuthorized, expenses_cents: projectSpent };
}
