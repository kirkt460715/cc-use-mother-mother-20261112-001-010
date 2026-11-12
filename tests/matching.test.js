import test from 'node:test';
import assert from 'node:assert/strict';
import { proportional, automaticMatch, validateAmountSources, planMatch } from '../matching/allocator.js';
import { activeAllocations, MatchLedger } from '../matching/ledger.js';
import { balances, reconcile, verifyReconciliation } from '../matching/reconcile.js';
import { Conflict, Invalid } from '../ledger/values.js';
import { allocationLedger, paymentMatch, sampleRegisters } from './support.js';

test('proportional allocation distributes every cent using exact rational weights', () => {
  const rows = proportional(101, [
    { id: 'north', weight: { numerator: 1, denominator: 2 } },
    { id: 'south', weight: { numerator: 1, denominator: 2 } }
  ]);
  assert.deepEqual(rows, [{ id: 'north', amount_cents: 51 }, { id: 'south', amount_cents: 50 }]);
  assert.equal(rows.reduce((sum, row) => sum + row.amount_cents, 0), 101);
});

test('proportional allocation resolves equal remainders by stable recipient identity', () => {
  const rows = proportional(2, [
    { id: 'c', weight: { numerator: 1, denominator: 1 } },
    { id: 'a', weight: { numerator: 1, denominator: 1 } },
    { id: 'b', weight: { numerator: 1, denominator: 1 } }
  ]);
  assert.deepEqual(rows, [{ id: 'a', amount_cents: 1 }, { id: 'b', amount_cents: 1 }, { id: 'c', amount_cents: 0 }]);
});

test('fractional ratios with unlike denominators normalize without floating point drift', () => {
  const rows = proportional(10000, [
    { id: 'a', weight: { numerator: 2, denominator: 3 } },
    { id: 'b', weight: { numerator: 5, denominator: 7 } }
  ]);
  assert.equal(rows.reduce((sum, row) => sum + row.amount_cents, 0), 10000);
  assert.ok(rows.every(row => Number.isSafeInteger(row.amount_cents)));
  assert.ok(rows.find(row => row.id === 'a').amount_cents > 0);
});

test('a zero total can have no recipients while positive money cannot disappear', () => {
  assert.deepEqual(proportional(0, []), []);
  assert.throws(() => proportional(1, []), /requires recipients/);
});

test('recipient identities must be unique even when their weights differ', () => {
  assert.throws(() => proportional(100, [
    { id: 'same', weight: { numerator: 1, denominator: 1 } },
    { id: 'same', weight: { numerator: 2, denominator: 1 } }
  ]), /duplicate allocation recipient/);
});

test('rational allocation rejects zero and negative weights', () => {
  assert.throws(() => proportional(10, [{ id: 'a', weight: { numerator: 0, denominator: 1 } }]), Invalid);
  assert.throws(() => proportional(10, [{ id: 'a', weight: { numerator: -1, denominator: 1 } }]), Invalid);
});

test('automatic matching selects a minimal exact subset and has stable tie-breaking', () => {
  const candidates = [
    { id: 'b', available_cents: 60 },
    { id: 'c', available_cents: 40 },
    { id: 'a', available_cents: 60 }
  ];
  const result = automaticMatch(100, candidates);
  assert.deepEqual(result.selected, ['a', 'c']);
  assert.equal(result.excess_cents, 0);
  assert.equal(result.method, 'exact_bounded_subset_search');
});

test('automatic matching reports the smallest unavoidable excess when exact sum is unavailable', () => {
  const result = automaticMatch(90, [
    { id: 'part-a', available_cents: 55 },
    { id: 'part-b', available_cents: 50 },
    { id: 'large', available_cents: 120 }
  ]);
  assert.deepEqual(result.selected, ['part-a', 'part-b']);
  assert.equal(result.excess_cents, 15);
});

test('automatic matching rejects a candidate set that cannot cover the obligation', () => {
  assert.throws(() => automaticMatch(100, [{ id: 'short', available_cents: 99 }]), Conflict);
});

test('automatic matching refuses exponential candidate sets beyond its configured cap', () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({ id: `c${index}`, available_cents: 50 }));
  assert.throws(() => automaticMatch(100, rows, 3), /candidate limit/);
});

test('candidate total is checked with safe integer arithmetic', () => {
  assert.throws(() => validateAmountSources(5, [
    { id: 'a', available_cents: Number.MAX_SAFE_INTEGER },
    { id: 'b', available_cents: 1 }
  ]), Invalid);
});

test('matching plan proves both sides retain the same remaining balance', () => {
  const plan = planMatch('disbursement', 'pay-n-01', 'expense', 'exp-n-01', 50000,
    [{ id: 'pay-n-01', available_cents: 120000 }],
    [{ id: 'exp-n-01', available_cents: 70000 }]);
  assert.equal(plan.after_source_available, 70000);
  assert.equal(plan.after_target_available, 20000);
  assert.equal(plan.source_conserved, true);
  assert.equal(plan.target_conserved, true);
});

test('a match cannot exceed either its source or target unmatched balance', () => {
  assert.throws(() => planMatch('disbursement', 'pay-n-01', 'expense', 'exp-n-01', 80000,
    [{ id: 'pay-n-01', available_cents: 70000 }],
    [{ id: 'exp-n-01', available_cents: 90000 }]), Conflict);
});

test('match append is idempotent by identity when its canonical content is unchanged', () => {
  const registers = sampleRegisters();
  const balancesFor = type => balances(registers, new MatchLedger(), type);
  const first = new MatchLedger().append(paymentMatch('match-1', 'pay-n-01', 'exp-n-01', 10000), balancesFor).ledger;
  const duplicate = first.append(paymentMatch('match-1', 'pay-n-01', 'exp-n-01', 10000), balancesFor);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ledger.fingerprint, first.fingerprint);
});

test('match identity cannot be reused for a different amount or target', () => {
  const registers = sampleRegisters();
  const balancesFor = type => balances(registers, new MatchLedger(), type);
  const first = new MatchLedger().append(paymentMatch('match-2', 'pay-n-01', 'exp-n-01', 10000), balancesFor).ledger;
  assert.throws(() => first.append(paymentMatch('match-2', 'pay-n-01', 'exp-n-01', 20000), balancesFor), Conflict);
});

test('active allocation query returns both ledger perspectives in stable order', () => {
  const ledger = allocationLedger([
    paymentMatch('m-2', 'pay-n-01', 'exp-n-01', 20000),
    paymentMatch('m-1', 'pay-n-01', 'exp-r-01', 10000)
  ]);
  const rows = activeAllocations(ledger, 'disbursement', 'pay-n-01');
  assert.deepEqual(rows.map(row => row.match), ['m-1', 'm-2']);
  assert.equal(rows.reduce((sum, row) => sum + row.amount_cents, 0), 30000);
  assert.equal(activeAllocations(ledger, 'expense', 'exp-r-01')[0].side, 'target');
});

test('full match reversal preserves both the match and a linked reversal record', () => {
  const original = paymentMatch('match-reversal', 'pay-n-01', 'exp-n-01', 12000);
  const ledger = allocationLedger([original]);
  const reversed = ledger.reverse({ id: 'reverse-1', match: original.id, date: 20260701,
    reason: 'duplicate invoice allocation', amount_cents: 12000 });
  assert.equal(reversed.matches.get(original.id).state, 'reversed');
  assert.equal(reversed.reversals.get('reverse-1').match, original.id);
  assert.equal(ledger.matches.get(original.id).state, 'active');
});

test('partial reversal is rejected because allocation amounts must remain conserved', () => {
  const original = paymentMatch('match-partial', 'pay-n-01', 'exp-n-01', 12000);
  assert.throws(() => allocationLedger([original]).reverse({ id: 'reverse-2', match: original.id,
    date: 20260701, reason: 'partial', amount_cents: 11999 }), Conflict);
});

test('reversal cannot precede the match date or reuse an existing reversal identity', () => {
  const original = paymentMatch('match-date', 'pay-n-01', 'exp-n-01', 12000, 20260701);
  const ledger = allocationLedger([original]);
  assert.throws(() => ledger.reverse({ id: 'reverse-date', match: original.id, date: 20260630,
    reason: 'bad date', amount_cents: 12000 }), Conflict);
  const done = ledger.reverse({ id: 'reverse-date', match: original.id, date: 20260702,
    reason: 'valid reversal', amount_cents: 12000 });
  assert.throws(() => done.reverse({ id: 'reverse-date', match: original.id, date: 20260703,
    reason: 'second reversal', amount_cents: 12000 }), Conflict);
});

test('reconciliation reports unmatched amounts without treating them as proof of misuse', () => {
  const registers = sampleRegisters();
  const ledger = allocationLedger([paymentMatch('match-3', 'pay-n-01', 'exp-n-01', 100000)]);
  const report = reconcile(registers, ledger);
  assert.equal(report.totals.disbursed_cents, 300000);
  assert.equal(report.totals.spent_cents, 205000);
  assert.equal(report.totals.matched_cents, 100000);
  assert.equal(report.unmatched.disbursement_cents, 200000);
  assert.equal(report.disposition, 'unmatched_is_difference_not_proof_of_misuse');
  assert.equal(verifyReconciliation(registers, ledger, report, true).valid, true);
});

test('refunds reduce the amount available for matching while keeping source history intact', () => {
  const source = sampleRegisters().export();
  source.disbursements.push({ id: 'refund-n', appropriation: 'auth-n-26', date: 20260601,
    amount: '500.00', kind: 'refund', external_ref: 'REF-X' });
  source.reversals.push({ id: 'rev-x', disbursement: 'refund-n', reversal_of: 'pay-n-01',
    date: 20260601, amount: '500.00', reason: 'returned materials' });
  const registers = new (sampleRegisters().constructor)(source);
  const rows = balances(registers, new MatchLedger(), 'disbursement');
  assert.equal(rows.find(row => row.id === 'pay-n-01').gross_cents, 150000);
});

test('date cutoff excludes future rows from balancing and from match eligibility', () => {
  const registers = sampleRegisters();
  const rows = balances(registers, new MatchLedger(), 'expense', 20260430);
  assert.deepEqual(rows.map(row => row.id), ['exp-n-01']);
  const report = reconcile(registers, new MatchLedger(), { date_cutoff: 20260430 });
  assert.equal(report.totals.spent_cents, 125000);
});

test('overallocated source balances fail closed before a report can be accepted', () => {
  const registers = sampleRegisters();
  const ledger = allocationLedger([paymentMatch('too-large', 'pay-n-01', 'exp-n-01', 200001)]);
  assert.throws(() => reconcile(registers, ledger), /overallocated/);
});

test('match ledger rejects an active record carrying reversal metadata', () => {
  const row = { ...paymentMatch('bad-state', 'pay-n-01', 'exp-n-01', 1000), reversed_by: 'r-1' };
  assert.throws(() => allocationLedger([row]), Invalid);
});

test('match ledger rejects a reversal event inconsistent with its parent state', () => {
  const row = { ...paymentMatch('bad-link', 'pay-n-01', 'exp-n-01', 1000), state: 'reversed', reversed_by: 'r-1' };
  assert.throws(() => allocationLedger([row], [{ id: 'r-1', match: row.id, date: 20260602,
    reason: 'wrong cents', amount_cents: 999 }]), Invalid);
});
