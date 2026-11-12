import test from 'node:test';
import assert from 'node:assert/strict';
import { controlReport, verifyControlReport, exposureByProgram, explainControlFinding, compareExposureDates, verifyExposureComparison } from '../portfolio/controls.js';
import { MatchLedger } from '../matching/ledger.js';
import { sampleRegisters, paymentMatch } from './support.js';

test('control report identifies unreconciled source and destination amounts', () => {
  const report = controlReport(sampleRegisters(), new MatchLedger(), 20261231);
  const codes = new Set(report.issues.map(row => row.code));
  assert.ok(codes.has('PAYMENT_UNMATCHED'));
  assert.ok(codes.has('EXPENSE_UNMATCHED'));
  assert.ok(report.totals.warning >= 4);
});

test('control report is deterministic and bound to both source fingerprints', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  const first = controlReport(registers, matches, 20261231);
  const second = controlReport(registers, matches, 20261231);
  assert.equal(first.report_digest, second.report_digest);
  assert.equal(verifyControlReport(registers, matches, first).valid, true);
  assert.equal(first.register_fingerprint, registers.fingerprint);
  assert.equal(first.match_fingerprint, matches.fingerprint);
});

test('control digest detects modified findings even when the summary count is untouched', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  const report = controlReport(registers, matches, 20261231);
  report.issues[0].detail = 'edited explanation';
  assert.throws(() => verifyControlReport(registers, matches, report), /stale or altered/);
});

test('a match that exceeds either side creates a critical amount control', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger({ version: 1, reversals: [], matches: [
    paymentMatch('over-allocation', 'pay-n-01', 'exp-n-01', 250000)
  ] });
  const report = controlReport(registers, matches, 20261231);
  assert.ok(report.issues.some(row => row.code === 'ALLOCATION_EXCEEDS_ROW' && row.severity === 'critical'));
});

test('active match references missing ledger rows are not dropped from the audit output', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger({ version: 1, reversals: [], matches: [
    paymentMatch('dangling', 'missing-payment', 'exp-n-01', 100)
  ] });
  const report = controlReport(registers, matches, 20261231);
  assert.ok(report.issues.some(row => row.code === 'MATCH_REFERENCE_MISSING' && row.entity === 'dangling'));
});

test('materiality suppresses small unmatched line findings without changing source balances', () => {
  const registers = sampleRegisters();
  const report = controlReport(registers, new MatchLedger(), 20261231, { materiality_cents: 999999 });
  assert.equal(report.issues.filter(row => row.code.endsWith('_UNMATCHED')).length, 0);
  assert.equal(registers.disbursements.size, 2);
});

test('date cutoff ignores future allocations and source rows consistently', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger({ version: 1, reversals: [], matches: [
    paymentMatch('future-match', 'pay-r-01', 'exp-r-01', 1000, 20270101)
  ] });
  const earlier = controlReport(registers, matches, 20261231);
  assert.ok(earlier.issues.some(row => row.code === 'MATCH_AFTER_CUTOFF'));
  const later = controlReport(registers, matches, 20271231);
  assert.equal(later.issues.some(row => row.code === 'MATCH_AFTER_CUTOFF'), false);
});

test('required milestones past due are warned on only after the reporting date reaches them', () => {
  const source = sampleRegisters().export();
  source.deliverables = [];
  const registers = new (sampleRegisters().constructor)(source);
  const early = controlReport(registers, new MatchLedger(), 20260629);
  const due = controlReport(registers, new MatchLedger(), 20260630);
  assert.equal(early.issues.some(row => row.entity === 'milestone-n-1'), false);
  assert.ok(due.issues.some(row => row.code === 'REQUIRED_MILESTONE_LATE' && row.entity === 'milestone-n-1'));
});

test('a grace period applies as a calendar-day extension to milestone due dates', () => {
  const source = sampleRegisters().export();
  source.deliverables = [];
  const registers = new (sampleRegisters().constructor)(source);
  const withinGrace = controlReport(registers, new MatchLedger(), 20260702, { milestone_grace_days: 3 });
  const outsideGrace = controlReport(registers, new MatchLedger(), 20260704, { milestone_grace_days: 3 });
  assert.equal(withinGrace.issues.some(row => row.entity === 'milestone-n-1'), false);
  assert.ok(outsideGrace.issues.some(row => row.entity === 'milestone-n-1'));
});

test('unaccepted milestones with null-delivery records remain open business obligations', () => {
  const source = sampleRegisters().export();
  source.deliverables = [];
  const registers = new (sampleRegisters().constructor)(source);
  const report = controlReport(registers, new MatchLedger(), 20261231);
  assert.ok(report.issues.some(row => row.code === 'REQUIRED_MILESTONE_LATE' && row.entity === 'milestone-n-1'));
});

test('completed optional milestones do not affect required-work warning totals', () => {
  const source = sampleRegisters().export();
  source.milestones[1].required = false;
  const registers = new (sampleRegisters().constructor)(source);
  const report = controlReport(registers, new MatchLedger(), 20261231);
  assert.equal(report.issues.some(row => row.entity === 'milestone-r-1'), false);
});

test('overdrawn authorizations appear as critical exceptions with exact cents', () => {
  const source = sampleRegisters().export();
  source.disbursements[0].amount = '6000.00';
  const registers = new (sampleRegisters().constructor)(source);
  const report = controlReport(registers, new MatchLedger(), 20261231);
  const warning = report.issues.find(row => row.code === 'APPROPRIATION_OVERDRAWN');
  assert.equal(warning.amount_cents, 100000);
  assert.equal(warning.severity, 'critical');
});

test('unspent authorization remains informational while its fiscal year is current', () => {
  const report = controlReport(sampleRegisters(), new MatchLedger(), 20260630);
  const row = report.issues.find(item => item.code === 'UNSPENT_CURRENT_AUTHORIZATION');
  assert.equal(row.severity, 'information');
  assert.equal(row.entity, 'auth-n-26');
});

test('past-year unspent authorizations do not retain current-period informational status', () => {
  const report = controlReport(sampleRegisters(), new MatchLedger(), 20270101);
  assert.equal(report.issues.some(item => item.code === 'UNSPENT_CURRENT_AUTHORIZATION'), false);
});

test('program exposure totals reconcile project appropriations, refunds, expenses and accepted units', () => {
  const groups = exposureByProgram(sampleRegisters(), 20261231);
  const north = groups.find(row => row.program === 'home-care');
  assert.equal(north.projects, 1);
  assert.equal(north.authorized_cents, 500000);
  assert.equal(north.net_cash_cents, 200000);
  assert.equal(north.expenses_cents, 125000);
  assert.equal(north.accepted_units, 18);
  assert.equal(north.open_milestones, 0);
});

test('program exposure observes date cutoffs and does not count future spend or outputs', () => {
  const source = sampleRegisters().export();
  source.deliverables[0].accepted_date = 20261231;
  const registers = new (sampleRegisters().constructor)(source);
  const groups = exposureByProgram(registers, 20260630);
  const north = groups.find(row => row.program === 'home-care');
  assert.equal(north.accepted_units, 0);
  assert.equal(north.expenses_cents, 125000);
});

test('program exposure retains programs that have no activity and avoids division by zero', () => {
  const groups = exposureByProgram(sampleRegisters(), 20261231);
  const north = groups.find(row => row.program === 'home-care');
  assert.deepEqual(north.cash_to_authorization, { numerator: 2, denominator: 5 });
  const empty = exposureByProgram(new (sampleRegisters().constructor)({ version: 1, projects: [],
    appropriations: [], disbursements: [], expenses: [], milestones: [], deliverables: [], reversals: [] }), 20261231);
  assert.deepEqual(empty, []);
});

test('invalid control dates and negative policies fail before analysis', () => {
  const registers = sampleRegisters();
  assert.throws(() => controlReport(registers, new MatchLedger(), 19000101), /as of date/);
  assert.throws(() => controlReport(registers, new MatchLedger(), 20261231, { materiality_cents: -1 }), /materiality/);
  assert.throws(() => controlReport(registers, new MatchLedger(), 20261231, { milestone_grace_days: -2 }), /grace days/);
});

test('critical issue ordering is stable ahead of warnings and information', () => {
  const source = sampleRegisters().export();
  source.disbursements[0].amount = '6000.00';
  const report = controlReport(new (sampleRegisters().constructor)(source), new MatchLedger(), 20261231);
  assert.equal(report.issues[0].severity, 'critical');
  for (let index = 1; index < report.issues.length; index += 1) {
    const rank = { critical: 0, warning: 1, information: 2 };
    assert.ok(rank[report.issues[index - 1].severity] <= rank[report.issues[index].severity]);
  }
});

test('payment control explanation cites the exact payment, reversals and active allocations', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger({ version: 1, reversals: [], matches: [
    paymentMatch('trace-payment', 'pay-n-01', 'exp-n-01', 50000)
  ] });
  const report = controlReport(registers, matches, 20261231);
  const trace = explainControlFinding(registers, matches, report, 'PAYMENT_UNMATCHED', 'pay-n-01');
  assert.ok(trace.evidence.some(row => row.table === 'disbursement' && row.id === 'pay-n-01'));
  assert.ok(trace.evidence.some(row => row.table === 'match' && row.id === 'trace-payment'));
  assert.equal(trace.report_digest, report.report_digest);
  assert.equal(trace.trace_digest.length, 64);
});

test('milestone control explanation retains both the due record and any unaccepted evidence', () => {
  const source = sampleRegisters().export();
  source.deliverables[0].accepted_date = null;
  source.deliverables[0].units = 0;
  const registers = new (sampleRegisters().constructor)(source);
  const matches = new MatchLedger();
  const report = controlReport(registers, matches, 20261231);
  const trace = explainControlFinding(registers, matches, report, 'REQUIRED_MILESTONE_LATE', 'milestone-n-1');
  assert.ok(trace.evidence.some(row => row.table === 'milestone'));
  assert.ok(trace.evidence.some(row => row.table === 'deliverable'));
});

test('control evidence is stable and rejects findings from another report snapshot', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  const report = controlReport(registers, matches, 20261231);
  const first = explainControlFinding(registers, matches, report, 'PAYMENT_UNMATCHED', 'pay-n-01');
  const second = explainControlFinding(registers, matches, report, 'PAYMENT_UNMATCHED', 'pay-n-01');
  assert.equal(first.trace_digest, second.trace_digest);
  assert.throws(() => explainControlFinding(registers, matches, report, 'PAYMENT_UNMATCHED', 'missing'), /does not exist/);
});

test('control evidence detects a source edit before returning a stale audit trace', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  const report = controlReport(registers, matches, 20261231);
  const changed = registers.export();
  changed.projects[0].name = 'Edited evidence source';
  const edited = new (sampleRegisters().constructor)(changed);
  assert.throws(() => explainControlFinding(edited, matches, report, 'PAYMENT_UNMATCHED', 'pay-n-01'), /stale or altered/);
});

test('cutoff comparison isolates accepted-output changes without claiming causal impact', () => {
  const report = compareExposureDates(sampleRegisters(), 20260627, 20261231);
  const north = report.programs.find(row => row.program === 'home-care');
  assert.equal(north.before.accepted_units, 0);
  assert.equal(north.after.accepted_units, 18);
  assert.equal(north.change.accepted_units, 18);
  assert.match(report.interpretation, /not_causal/);
  assert.equal(report.digest.length, 64);
  assert.equal(verifyExposureComparison(sampleRegisters(), report).valid, true);
});

test('cutoff comparison rejects reverse time and impossible observation dates', () => {
  assert.throws(() => compareExposureDates(sampleRegisters(), 20270101, 20261231), /later date/);
  assert.throws(() => compareExposureDates(sampleRegisters(), 19000101, 20261231), /earlier date/);
});

test('exposure comparison verification detects altered values and stale source records', () => {
  const registers = sampleRegisters();
  const report = compareExposureDates(registers, 20260627, 20261231);
  report.programs[0].change.expenses_cents += 1;
  assert.throws(() => verifyExposureComparison(registers, report), /digest mismatch/);
  const original = compareExposureDates(registers, 20260627, 20261231);
  const source = registers.export();
  source.expenses[0].amount = '1251.00';
  const changed = new (registers.constructor)(source);
  assert.throws(() => verifyExposureComparison(changed, original), /stale/);
});
