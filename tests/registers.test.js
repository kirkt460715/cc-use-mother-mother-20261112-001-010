import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Registers, appropriationBalance, cashEffect, fiscalYear } from '../ledger/registers.js';
import { Invalid, digest } from '../ledger/values.js';
import { sampleRegisters } from './support.js';

test('fixture exposes independent project, authorization, payment and expense ledgers', () => {
  const registers = sampleRegisters();
  assert.equal(registers.projects.size, 2);
  assert.equal(registers.appropriations.size, 2);
  assert.equal(registers.disbursements.size, 2);
  assert.equal(registers.expenses.size, 2);
  assert.notEqual(registers.fingerprint, digest({ version: 1 }));
});

test('register construction canonicalizes entity order without mutating input', () => {
  const source = sampleRegisters().export();
  const shuffled = structuredClone(source);
  shuffled.projects.reverse();
  shuffled.disbursements.reverse();
  const before = structuredClone(shuffled);
  const registers = new Registers(shuffled);
  assert.equal(registers.fingerprint, sampleRegisters().fingerprint);
  assert.deepEqual(shuffled, before);
  assert.deepEqual(registers.export().projects.map(row => row.id), ['care-north', 'care-river']);
});

test('unknown fields are rejected instead of silently entering a frozen ledger', () => {
  const rows = sampleRegisters().export();
  rows.projects[0].extra = 'unexpected';
  assert.throws(() => new Registers(rows), Invalid);
});

test('duplicate identifiers are rejected within an entity register', () => {
  const rows = sampleRegisters().export();
  rows.projects.push(structuredClone(rows.projects[0]));
  assert.throws(() => new Registers(rows), /duplicate/);
});

test('approvals must point to existing projects and payments to existing approvals', () => {
  const missingProject = sampleRegisters().export();
  missingProject.appropriations[0].project = 'ghost';
  assert.throws(() => new Registers(missingProject), /project missing/);
  const missingApproval = sampleRegisters().export();
  missingApproval.disbursements[0].appropriation = 'ghost';
  assert.throws(() => new Registers(missingApproval), /appropriation missing/);
});

test('deliverables cannot cross project milestone boundaries', () => {
  const rows = sampleRegisters().export();
  rows.deliverables[0].milestone = 'milestone-r-1';
  assert.throws(() => new Registers(rows), /reference mismatch/);
});

test('unaccepted outputs cannot contribute units', () => {
  const rows = sampleRegisters().export();
  rows.deliverables[0].accepted_date = null;
  assert.throws(() => new Registers(rows), /cannot count units/);
});

test('appropriation balances use integer cents and report remaining authorization', () => {
  const registers = sampleRegisters();
  const north = appropriationBalance(registers, 'auth-n-26');
  assert.equal(north.authorized_cents, 500000);
  assert.equal(north.net_disbursed_cents, 200000);
  assert.equal(north.remaining_cents, 300000);
  assert.equal(north.overdrawn, false);
  assert.equal(north.remaining, '3000.00');
});

test('unknown appropriation cannot be treated as a zero balance', () => {
  assert.throws(() => appropriationBalance(sampleRegisters(), 'missing'), /unknown appropriation/);
});

test('cash effects preserve voids and require a linked reversal for refunds', () => {
  const registers = sampleRegisters();
  const payment = registers.disbursements.get('pay-n-01');
  const voidRow = { ...payment, kind: 'void' };
  assert.equal(cashEffect(registers, payment), 200000);
  assert.equal(cashEffect(registers, voidRow), 0);
  const refund = { ...payment, id: 'refund-n', kind: 'refund' };
  assert.throws(() => cashEffect(registers, refund), /without reversal/);
});

test('refund records must reverse a payment in the same authorization', () => {
  const rows = sampleRegisters().export();
  rows.disbursements.push({ id: 'refund-n', appropriation: 'auth-n-26', date: 20260701,
    amount: '100.00', kind: 'refund', external_ref: 'REF-1' });
  rows.reversals.push({ id: 'rev-n', disbursement: 'refund-n', reversal_of: 'pay-n-01',
    date: 20260701, amount: '100.00', reason: 'duplicate payment recovery' });
  assert.equal(new Registers(rows).reversals.size, 1);
  const wrong = structuredClone(rows);
  wrong.reversals[0].reversal_of = 'pay-r-01';
  assert.throws(() => new Registers(wrong), /same appropriation/);
});

test('refund amount and event dates cannot drift from their immutable cash row', () => {
  const rows = sampleRegisters().export();
  rows.disbursements.push({ id: 'refund-n', appropriation: 'auth-n-26', date: 20260701,
    amount: '100.00', kind: 'refund', external_ref: 'REF-1' });
  rows.reversals.push({ id: 'rev-n', disbursement: 'refund-n', reversal_of: 'pay-n-01',
    date: 20260701, amount: '99.99', reason: 'recovery' });
  assert.throws(() => new Registers(rows), /fields mismatch/);
  rows.reversals[0].amount = '100.00';
  rows.reversals[0].date = 20260601;
  assert.throws(() => new Registers(rows), /fields mismatch/);
});

test('cash refund balance is netted without deleting the original payment', () => {
  const rows = sampleRegisters().export();
  rows.disbursements.push({ id: 'refund-n', appropriation: 'auth-n-26', date: 20260701,
    amount: '500.00', kind: 'refund', external_ref: 'REF-2' });
  rows.reversals.push({ id: 'rev-n', disbursement: 'refund-n', reversal_of: 'pay-n-01',
    date: 20260701, amount: '500.00', reason: 'returned equipment' });
  const registers = new Registers(rows);
  assert.equal(registers.disbursements.size, 3);
  assert.equal(appropriationBalance(registers, 'auth-n-26').net_disbursed_cents, 150000);
});

test('a void does not change cash while remaining visible in the source history', () => {
  const rows = sampleRegisters().export();
  rows.disbursements.push({ id: 'void-n', appropriation: 'auth-n-26', date: 20260701,
    amount: '125.00', kind: 'void', external_ref: 'VOID-1' });
  const registers = new Registers(rows);
  assert.equal(registers.disbursements.size, 3);
  assert.equal(appropriationBalance(registers, 'auth-n-26').net_disbursed_cents, 200000);
});

test('fiscal year uses the calendar-year boundary represented by the source date', () => {
  assert.equal(fiscalYear(20261231), 2026);
  assert.equal(fiscalYear(20270101), 2027);
  assert.throws(() => fiscalYear(19000101), Invalid);
});

test('empty registers remain a valid zero-state snapshot', () => {
  const blank = new Registers({ version: 1, projects: [], appropriations: [], disbursements: [],
    expenses: [], milestones: [], deliverables: [], reversals: [] });
  assert.equal(blank.projects.size, 0);
  assert.equal(blank.disbursements.size, 0);
  assert.equal(blank.fingerprint.length, 64);
});

test('large but bounded amount strings retain cent exactness', () => {
  const source = readFileSync(new URL('../fixtures/accounts.json', import.meta.url), 'utf8');
  assert.match(source, /"5000\.00"/);
  const rows = sampleRegisters().export();
  rows.appropriations[0].authorized = '90071992547409.92';
  assert.throws(() => new Registers(rows), Invalid);
});

test('all fixture identifiers remain stable after an independent clone', () => {
  const first = sampleRegisters();
  const second = new Registers(first.export());
  for (const table of ['projects', 'appropriations', 'disbursements', 'expenses', 'milestones', 'deliverables']) {
    assert.deepEqual([...first[table].keys()], [...second[table].keys()]);
  }
});

test('register export cannot mutate the originating snapshot', () => {
  const registers = sampleRegisters();
  const output = registers.export();
  output.projects[0].name = 'edited caller copy';
  assert.equal(registers.projects.get('care-north').name, 'North home care retrofit');
});

test('unknown register version is rejected before rows can be interpreted', () => {
  const rows = sampleRegisters().export();
  rows.version = 2;
  assert.throws(() => new Registers(rows), /unsupported register version/);
});

test('malformed amount syntax fails rather than rounding floating values', () => {
  const rows = sampleRegisters().export();
  rows.expenses[0].amount = '1250.001';
  assert.throws(() => new Registers(rows), Invalid);
});

test('non-required milestones do not create overdue required-output controls', () => {
  const rows = sampleRegisters().export();
  rows.milestones[0].required = false;
  rows.deliverables = [];
  const registers = new Registers(rows);
  assert.equal(registers.milestones.get('milestone-n-1').required, false);
});

test('dates and statuses are validated when constructing source snapshots', () => {
  const rows = sampleRegisters().export();
  rows.projects[0].status = 'closed-ish';
  assert.throws(() => new Registers(rows), /unknown project status/);
  rows.projects[0].status = 'active';
  rows.disbursements[0].date = 19990101;
  assert.throws(() => new Registers(rows), Invalid);
});
