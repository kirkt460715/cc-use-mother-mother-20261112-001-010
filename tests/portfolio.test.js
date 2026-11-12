import test from 'node:test';
import assert from 'node:assert/strict';
import { byProject, byCounty, byFiscalYear, projectDetail, sensitivity } from '../portfolio/metrics.js';
import { comparePrograms, quarterly, exceptions, dashboard, validatePortfolio, costPerAcceptedUnit } from '../portfolio/indicators.js';
import { dispatch, page, auditDashboard } from '../portfolio/query.js';
import { MatchLedger } from '../matching/ledger.js';
import { Invalid } from '../ledger/values.js';
import { sampleRegisters } from './support.js';

test('project metrics distinguish gross cash, refunds, expenditure and active allocation', () => {
  const registers = sampleRegisters();
  const rows = byProject(registers, new MatchLedger(), 20261231);
  const north = rows.find(row => row.project === 'care-north');
  assert.equal(north.authorized_cents, 500000);
  assert.equal(north.gross_disbursed_cents, 200000);
  assert.equal(north.net_disbursed_cents, 200000);
  assert.equal(north.expenses_cents, 125000);
  assert.equal(north.disbursement_unmatched_cents, 200000);
});

test('project output is sorted by stable project ID regardless of source ordering', () => {
  const rows = byProject(sampleRegisters(), new MatchLedger());
  assert.deepEqual(rows.map(row => row.project), ['care-north', 'care-river']);
});

test('project metrics cutoff excludes future dated source rows from spend totals', () => {
  const source = sampleRegisters().export();
  source.expenses[0].date = 20270101;
  const registers = new (sampleRegisters().constructor)(source);
  const row = byProject(registers, new MatchLedger(), 20261231).find(item => item.project === 'care-north');
  assert.equal(row.expenses_cents, 0);
});

test('county aggregation equals the sum of its underlying projects', () => {
  const registers = sampleRegisters();
  const counties = byCounty(registers, new MatchLedger());
  const projects = byProject(registers, new MatchLedger());
  for (const county of counties) {
    const group = projects.filter(row => row.county === county.county);
    assert.equal(county.authorized_cents, group.reduce((sum, row) => sum + row.authorized_cents, 0));
    assert.equal(county.expenses_cents, group.reduce((sum, row) => sum + row.expenses_cents, 0));
    assert.equal(county.projects, group.length);
  }
});

test('fiscal-year report includes empty years and assigns each dated event once', () => {
  const rows = byFiscalYear(sampleRegisters(), 2025, 2027);
  assert.deepEqual(rows.map(row => row.fiscal_year), [2025, 2026, 2027]);
  assert.equal(rows[0].authorized_cents, 0);
  assert.equal(rows[1].authorized_cents, 800000);
  assert.equal(rows[1].disbursed_cents, 300000);
  assert.equal(rows[1].expenses_cents, 205000);
  assert.equal(rows[2].cumulative_net_disbursed_cents, 300000);
});

test('fiscal-year periods reject reversed endpoints instead of returning an empty report', () => {
  assert.throws(() => byFiscalYear(sampleRegisters(), 2028, 2027), Invalid);
});

test('project detail explicitly marks its restricted record scope', () => {
  const result = projectDetail(sampleRegisters(), new MatchLedger(), 'care-north');
  assert.equal(result.access, 'restricted_project_records');
  assert.equal(result.metrics.project, 'care-north');
  assert.equal(result.appropriations.length, 1);
  assert.throws(() => projectDetail(sampleRegisters(), new MatchLedger(), 'missing'), Invalid);
});

test('sensitivity analysis recomputes totals after excluding a known project', () => {
  const registers = sampleRegisters();
  const result = sensitivity(registers, new MatchLedger(), 20261231, ['care-north']);
  assert.equal(result.remaining_projects, 1);
  assert.equal(result.authorized_cents, 300000);
  assert.equal(result.expenses_cents, 80000);
  assert.equal(result.recomputed_from_source_rows, true);
});

test('sensitivity analysis rejects duplicate or unknown exclusions', () => {
  const registers = sampleRegisters();
  assert.throws(() => sensitivity(registers, new MatchLedger(), 20261231, ['care-north', 'care-north']), Invalid);
  assert.throws(() => sensitivity(registers, new MatchLedger(), 20261231, ['missing']), Invalid);
});

test('program comparison carries a non-causal interpretation with separate denominators', () => {
  const result = comparePrograms(sampleRegisters(), new MatchLedger(), 'home-care', 'community-care');
  assert.equal(result.left.authorized_cents, 500000);
  assert.equal(result.right.authorized_cents, 300000);
  assert.deepEqual(result.difference, { projects: 0, authorized_cents: -200000,
    net_disbursed_cents: -100000, expenses_cents: -45000, units: -18 });
  assert.match(result.interpretation, /not_causal/);
});

test('program comparison refuses identical groups that would hide a zero denominator choice', () => {
  assert.throws(() => comparePrograms(sampleRegisters(), new MatchLedger(), 'home-care', 'home-care'), Invalid);
});

test('quarterly metrics assign cash and expenses by event date rather than allocation date', () => {
  const result = quarterly(sampleRegisters(), new MatchLedger(), 2026);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[1].gross_disbursed_cents, 300000);
  assert.equal(result.rows[1].expenses_cents, 205000);
  assert.equal(result.assignment, 'event_date_quarter_not_cash_to_expense_match_period');
});

test('quarterly cutoff prevents later activity from appearing in a frozen period report', () => {
  const result = quarterly(sampleRegisters(), new MatchLedger(), 2026, 20260630);
  assert.equal(result.rows[1].gross_disbursed_cents, 300000);
  assert.equal(result.rows[1].expenses_cents, 205000);
  assert.equal(result.rows[2].activity, false);
});

test('exception report separates unmatched money and required-output gaps', () => {
  const report = exceptions(sampleRegisters(), new MatchLedger(), 20261231);
  assert.ok(report.rows.some(row => row.code === 'unmatched_disbursement'));
  assert.ok(report.rows.some(row => row.code === 'unmatched_expense'));
  assert.ok(report.rows.some(row => row.code === 'required_milestone_not_accepted'));
  assert.equal(report.report_noncausal_exceptions_only, true);
});

test('dashboard totals roll up from projects and preserve interpretation caveats', () => {
  const registers = sampleRegisters();
  const report = dashboard(registers, new MatchLedger(), 20261231);
  assert.equal(report.totals.projects, 2);
  assert.equal(report.totals.authorized_cents, 800000);
  assert.equal(report.totals.net_disbursed_cents, 300000);
  assert.equal(report.totals.expenses_cents, 205000);
  assert.ok(report.caveats.includes('no_causal_outcome_claim'));
  assert.equal(validatePortfolio(registers, new MatchLedger(), report).valid, true);
  assert.equal(auditDashboard(registers, new MatchLedger(), { cutoff: report.cutoff, portfolio: report }).valid, true);
});

test('dashboard audit rejects a changed aggregate even if the source digest is still available', () => {
  const registers = sampleRegisters();
  const report = dashboard(registers, new MatchLedger());
  report.totals.expenses_cents += 1;
  assert.throws(() => auditDashboard(registers, new MatchLedger(), { portfolio: report, cutoff: report.cutoff }), /differs/);
});

test('accepted-unit cost ratio reports exact cents and refuses an invented zero denominator', () => {
  const rows = costPerAcceptedUnit(sampleRegisters(), 20261231);
  const north = rows.find(row => row.project === 'care-north');
  const river = rows.find(row => row.project === 'care-river');
  assert.equal(north.expense_cents, 125000);
  assert.equal(north.accepted_units, 18);
  assert.deepEqual(north.expense_per_accepted_unit, { numerator: 62500, denominator: 9 });
  assert.equal(river.expense_per_accepted_unit, null);
  assert.equal(river.interpretation, 'no_accepted_unit_denominator');
});

test('paged ledger results are stable, bounded and linked to a source snapshot', () => {
  const registers = sampleRegisters();
  const first = page(registers, new MatchLedger(), 'projects', null, 1);
  assert.equal(first.rows.length, 1);
  assert.equal(first.next_after, first.rows[0].id);
  assert.equal(first.consistent_with_snapshot_only, true);
  const second = page(registers, new MatchLedger(), 'projects', first.next_after, 1);
  assert.equal(second.rows.length, 1);
  assert.notEqual(second.rows[0].id, first.rows[0].id);
});

test('paged ledger rejects invalid tables, cursors and page sizes', () => {
  const registers = sampleRegisters();
  assert.throws(() => page(registers, new MatchLedger(), 'unknown'), Invalid);
  assert.throws(() => page(registers, new MatchLedger(), 'projects', null, 0), Invalid);
  assert.throws(() => page(registers, new MatchLedger(), 'projects', 'bad id space', 5), Invalid);
});

test('dispatch routes business query names to their matching reporting functions', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  assert.equal(dispatch(registers, matches, 'projects').length, 2);
  assert.equal(dispatch(registers, matches, 'counties').length, 2);
  assert.equal(dispatch(registers, matches, 'quarterly', { year: 2026 }).rows.length, 4);
  assert.equal(dispatch(registers, matches, 'reconcile').totals.matched_cents, 0);
  assert.throws(() => dispatch(registers, matches, 'unknown'), Invalid);
});

test('query argument schemas reject accidental extra fields and incomplete requests', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  assert.throws(() => dispatch(registers, matches, 'project', { id: 'care-north', extra: 1 }), Invalid);
  assert.throws(() => dispatch(registers, matches, 'fiscal-years', { start: 2026 }), Invalid);
  assert.throws(() => dispatch(registers, matches, 'dashboard', { cutoff: 20261231, debug: true }), Invalid);
});

test('valid portfolio aggregate leaves report evidence unchanged during queries', () => {
  const registers = sampleRegisters();
  const before = registers.fingerprint;
  byProject(registers, new MatchLedger());
  byCounty(registers, new MatchLedger());
  byFiscalYear(registers, 2025, 2026);
  dashboard(registers, new MatchLedger());
  assert.equal(registers.fingerprint, before);
});

test('project query preserves accepted units only within the observation cutoff', () => {
  const registers = sampleRegisters();
  const before = projectDetail(registers, new MatchLedger(), 'care-north', 20260627);
  const after = projectDetail(registers, new MatchLedger(), 'care-north', 20260628);
  assert.equal(before.metrics.committed_units, 0);
  assert.equal(after.metrics.committed_units, 18);
});

test('yearly output has no negative cash amounts for the synthetic no-refund case', () => {
  const years = byFiscalYear(sampleRegisters(), 2026, 2026);
  assert.ok(years.every(row => row.disbursed_cents >= 0));
  assert.equal(years[0].net_disbursed_cents, years[0].disbursed_cents - years[0].refunds_cents);
});
