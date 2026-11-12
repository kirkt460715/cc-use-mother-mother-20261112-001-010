import { fields, integer, id, Invalid } from '../ledger/values.js';
import { byProject, byCounty, byFiscalYear, projectDetail, sensitivity } from './metrics.js';
import { comparePrograms, quarterly, exceptions, dashboard } from './indicators.js';
import { reconcile } from '../matching/reconcile.js';
import { cashJournal } from '../ledger/events.js';

export function dispatch(registers, ledger, kind, options = {}) {
  if (kind === 'dashboard') {
    fields(options, [], ['cutoff']);
    return dashboard(registers, ledger, options.cutoff);
  }
  if (kind === 'projects') {
    fields(options, [], ['cutoff']);
    return byProject(registers, ledger, options.cutoff);
  }
  if (kind === 'counties') {
    fields(options, [], ['cutoff']);
    return byCounty(registers, ledger, options.cutoff);
  }
  if (kind === 'fiscal-years') {
    fields(options, ['start', 'end']);
    return byFiscalYear(registers, options.start, options.end);
  }
  if (kind === 'project') {
    fields(options, ['id'], ['cutoff']);
    return projectDetail(registers, ledger, options.id, options.cutoff);
  }
  if (kind === 'sensitivity') {
    fields(options, ['excluded_projects'], ['cutoff']);
    return sensitivity(registers, ledger, options.cutoff ?? 21001231, options.excluded_projects);
  }
  if (kind === 'program-compare') {
    fields(options, ['left', 'right'], ['cutoff']);
    return comparePrograms(registers, ledger, options.left, options.right, options.cutoff);
  }
  if (kind === 'quarterly') {
    fields(options, ['year'], ['cutoff']);
    return quarterly(registers, ledger, options.year, options.cutoff);
  }
  if (kind === 'exceptions') {
    fields(options, [], ['cutoff']);
    return exceptions(registers, ledger, options.cutoff);
  }
  if (kind === 'cash-journal') {
    fields(options, []);
    return cashJournal(registers);
  }
  if (kind === 'reconcile') {
    fields(options, [], ['cutoff']);
    return reconcile(registers, ledger, { date_cutoff: options.cutoff });
  }
  throw new Invalid('unknown portfolio query');
}

export function page(registers, ledger, table, after = null, limit = 100) {
  if (!['projects', 'appropriations', 'disbursements', 'expenses', 'milestones', 'deliverables', 'reversals'].includes(table)) {
    throw new Invalid('unknown source ledger table');
  }
  integer(limit, 'limit', 1, 1000);
  if (after !== null) {
    id(after, 'after');
  }
  const rows = [...registers[table].values()].filter(row => after === null || row.id > after).sort((a, b) => a.id.localeCompare(b.id));
  const selected = rows.slice(0, limit);
  return { table, rows: selected, next_after: rows.length > limit ? selected.at(-1).id : null,
    register_digest: registers.fingerprint, consistent_with_snapshot_only: true };
}

export function auditDashboard(registers, ledger, report) {
  const expected = dashboard(registers, ledger, report.cutoff);
  if (JSON.stringify(expected) !== JSON.stringify(report.portfolio)) {
    throw new Invalid('portfolio report differs from current snapshot replay');
  }
  return { valid: true, projects: expected.projects.length, counties: expected.counties.length };
}
