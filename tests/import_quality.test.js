import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTranslation, auditImportPreview } from '../ingestion/quality.js';
import { fromRows, oneEntityPatch } from '../ingestion/operations.js';
import { Invalid } from '../ledger/values.js';
import { sampleRegisters } from './support.js';

function translation(accepted = [], rejected = [], extras = []) {
  return { table: 'projects', accepted, rejected, complete: rejected.length === 0,
    unmapped_columns: extras };
}

function project(id, name = 'Home-care upgrade') {
  return { id, county: 'county-n', program: 'home-care', name, start: 2027, end: 2029, status: 'planned' };
}

test('translation quality gate distinguishes a clean import from an incomplete one', () => {
  const clean = assessTranslation(translation([project('clean') ]));
  const broken = assessTranslation(translation([project('partial')], [{ line: 3, error: 'bad year' }]));
  assert.equal(clean.ready_for_preview, true);
  assert.equal(clean.rejected_basis_points, 0);
  assert.equal(broken.ready_for_preview, false);
  assert.equal(broken.rejected_basis_points, 5000);
  assert.ok(broken.findings.some(row => row.code === 'ROWS_REJECTED'));
});

test('translation quality reports unknown columns and duplicate business identities', () => {
  const rows = [project('repeat'), project('repeat', 'Second source line')];
  const result = assessTranslation(translation(rows, [], ['vendor_note']));
  assert.equal(result.ready_for_preview, false);
  assert.equal(result.duplicate_identities[0].identity, 'repeat');
  assert.ok(result.findings.some(row => row.code === 'UNMAPPED_COLUMNS'));
  assert.ok(result.findings.some(row => row.code === 'DUPLICATE_IDENTITIES'));
});

test('translation rejection threshold is computed with integer basis points', () => {
  const result = assessTranslation(translation([project('valid')], [{ line: 3, error: 'invalid' }]),
    { max_rejected_basis_points: 5000 });
  assert.equal(result.rejected_basis_points, 5000);
  assert.equal(result.ready_for_preview, true);
  const blocked = assessTranslation(translation([project('valid')], [{ line: 3, error: 'invalid' }]),
    { max_rejected_basis_points: 4999 });
  assert.equal(blocked.ready_for_preview, false);
});

test('empty translation requires explicit policy acknowledgement', () => {
  assert.equal(assessTranslation(translation()).ready_for_preview, false);
  assert.equal(assessTranslation(translation(), { allow_empty: true }).ready_for_preview, true);
});

test('translation assessment validates shape and policy rather than trusting imported metadata', () => {
  assert.throws(() => assessTranslation({}), Invalid);
  assert.throws(() => assessTranslation(translation(), { max_rejected_basis_points: 10001 }), Invalid);
  assert.throws(() => assessTranslation(translation(), { allow_empty: 'yes' }), Invalid);
});

test('an import preview summarizes amount changes by table and retains the underlying snapshot digests', () => {
  const registers = sampleRegisters();
  const updated = { ...registers.projects.get('care-north'), name: 'North home-care renewal' };
  const operation = oneEntityPatch(registers, 'projects', updated.id, updated);
  const report = auditImportPreview(registers, [operation]);
  assert.equal(report.changed_count, 1);
  assert.equal(report.before_digest, registers.fingerprint);
  assert.notEqual(report.after_digest, registers.fingerprint);
  assert.deepEqual(report.by_table_and_change, { 'projects:revised': 1 });
  assert.equal(report.requires_human_review, true);
  assert.equal(report.review_permitted, true);
});

test('approval amount changes remain visible as deltas, not just row counts', () => {
  const registers = sampleRegisters();
  const current = registers.appropriations.get('auth-n-26');
  const operation = oneEntityPatch(registers, 'appropriations', current.id,
    { ...current, authorized: '5100.00' });
  const report = auditImportPreview(registers, [operation]);
  assert.equal(report.before_amount_cents, 500000);
  assert.equal(report.after_amount_cents, 510000);
  assert.equal(report.amount_delta_cents, 10000);
  assert.ok(report.findings.some(row => row.code === 'REGISTERED_AMOUNT_DELTA'));
});

test('import review policy blocks large batches and excessive deletions', () => {
  const registers = sampleRegisters();
  const operation = oneEntityPatch(registers, 'expenses', 'exp-r-01', null);
  const defaultPolicy = auditImportPreview(registers, [operation]);
  assert.equal(defaultPolicy.review_permitted, false);
  assert.ok(defaultPolicy.findings.some(row => row.code === 'DELETION_LIMIT_EXCEEDED'));
  const allowed = auditImportPreview(registers, [operation], { max_deletions: 1 });
  assert.equal(allowed.review_permitted, true);
});

test('deletion previews include their amount and entity effects while leaving source state untouched', () => {
  const registers = sampleRegisters();
  const revision = registers.fingerprint;
  const operation = oneEntityPatch(registers, 'expenses', 'exp-n-01', null);
  const report = auditImportPreview(registers, [operation], { max_deletions: 1 });
  assert.equal(report.deletion_count, 1);
  assert.equal(report.before_amount_cents, 125000);
  assert.equal(report.after_amount_cents, 0);
  assert.equal(registers.fingerprint, revision);
});

test('cross-table import preview allows a project and its appropriation as one business unit', () => {
  const registers = sampleRegisters();
  const newProject = project('new-clinic');
  const projectOperation = fromRows(registers, 'projects', [newProject])[0];
  const staged = new (registers.constructor)({ ...registers.export(),
    projects: [...registers.projects.values(), newProject] });
  const appropriationOperation = fromRows(staged, 'appropriations', [{ id: 'new-clinic-auth',
    project: newProject.id, fiscal_year: 2027, authorized: '250.00', source: 'county grant' }])[0];
  const report = auditImportPreview(registers, [projectOperation, appropriationOperation]);
  assert.equal(report.changed_count, 2);
  assert.equal(report.by_table_and_change['projects:added'], 1);
  assert.equal(report.by_table_and_change['appropriations:added'], 1);
  assert.equal(report.after_amount_cents, 25000);
});

test('a preview digest changes when its approved operations change even for the same entity', () => {
  const registers = sampleRegisters();
  const first = oneEntityPatch(registers, 'projects', 'care-north',
    { ...registers.projects.get('care-north'), name: 'Draft A' });
  const second = oneEntityPatch(registers, 'projects', 'care-north',
    { ...registers.projects.get('care-north'), name: 'Draft B' });
  const reportA = auditImportPreview(registers, [first]);
  const reportB = auditImportPreview(registers, [second]);
  assert.notEqual(reportA.after_digest, reportB.after_digest);
  assert.notEqual(reportA.digest, reportB.digest);
});

test('review limit values reject unbounded or zero change thresholds', () => {
  const registers = sampleRegisters();
  const operation = fromRows(registers, 'projects', [project('one')])[0];
  assert.throws(() => auditImportPreview(registers, [operation], { max_changed_rows: 0 }), Invalid);
  assert.throws(() => auditImportPreview(registers, [operation], { max_deletions: -1 }), Invalid);
  assert.throws(() => auditImportPreview(registers, [operation], { unknown: true }), Invalid);
});
