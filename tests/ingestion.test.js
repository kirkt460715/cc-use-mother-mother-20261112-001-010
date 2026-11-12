import test from 'node:test';
import assert from 'node:assert/strict';
import { fromRows, fromCSV, mergeRecords, validateImportPreview, oneEntityPatch } from '../ingestion/operations.js';
import { parseCSV, translate, requireComplete } from '../ingestion/mapping.js';
import { mappingFor, SCHEMAS } from '../ingestion/schemas.js';
import { Conflict, Invalid } from '../ledger/values.js';
import { sampleRegisters } from './support.js';

const projectHeaders = ['id', 'county', 'program', 'name', 'start', 'end', 'status'];

function validProject(id = 'new-care') {
  return { id, county: 'county-n', program: 'home-care', name: 'New care site',
    start: 2027, end: 2029, status: 'planned' };
}

function projectCsv(row = validProject()) {
  return [projectHeaders.join(','), projectHeaders.map(key => row[key]).join(',')].join('\n');
}

test('RFC-style CSV parser preserves quoted commas and escaped quotes', () => {
  const rows = parseCSV('id,name,note\n1,"Care, north","said ""ready"""');
  assert.deepEqual(rows, [['id', 'name', 'note'], ['1', 'Care, north', 'said "ready"']]);
});

test('CSV parser handles CRLF and a final newline without inventing an empty row', () => {
  const rows = parseCSV('id,name\r\n1,North\r\n');
  assert.deepEqual(rows, [['id', 'name'], ['1', 'North']]);
});

test('CSV parser rejects an unterminated quoted field instead of shifting later cells', () => {
  assert.throws(() => parseCSV('id,name\n1,"North'), Invalid);
});

test('CSV parser rejects quote placement inside an unquoted field', () => {
  assert.throws(() => parseCSV('id,name\n1,No"rth'), Invalid);
});

test('CSV parser accepts a quoted newline as one field value', () => {
  const rows = parseCSV('id,note\n1,"line one\nline two"');
  assert.equal(rows[1][1], 'line one\nline two');
});

test('CSV parser enforces equal row width before any records are translated', () => {
  const malformed = 'id,county,program,name,start,end,status\nn,c,p,Name,2027,2028,planned,extra';
  const result = translate(malformed, mappingFor('projects', projectHeaders), SCHEMAS, false);
  assert.equal(result.complete, false);
  assert.equal(result.rejected[0].error, 'record width mismatch');
});

test('schema mappings expose every canonical project column exactly once', () => {
  const mapping = mappingFor('projects', projectHeaders, {});
  assert.equal(Object.keys(mapping.columns).length, projectHeaders.length);
  assert.deepEqual(new Set(Object.keys(mapping.columns)), new Set(projectHeaders));
});

test('CSV import translates integer years and keeps the original register immutable', () => {
  const registers = sampleRegisters();
  const before = registers.fingerprint;
  const preview = fromCSV(registers, projectCsv(), mappingFor('projects', projectHeaders), SCHEMAS);
  assert.equal(preview.translation.accepted, 1);
  assert.equal(preview.operations[0].after.start, 2027);
  assert.equal(registers.fingerprint, before);
  assert.equal(preview.atomic_batch_required, true);
});

test('strict CSV mapping rejects unknown headers that have no canonical destination', () => {
  const csv = 'id,county,program,name,start,end,status,free_text\nn,c,p,Name,2027,2028,planned,x';
  const headers = [...projectHeaders, 'free_text'];
  assert.throws(() => fromCSV(sampleRegisters(), csv,
    mappingFor('projects', headers), SCHEMAS), Invalid);
});

test('non-strict translation returns rejected rows and does not call them accepted', () => {
  const rows = translate('id,county,program,name,start,end,status\nn,c,p,N,not-a-year,2027,planned',
    mappingFor('projects', projectHeaders), SCHEMAS, false);
  assert.equal(rows.accepted.length, 0);
  assert.equal(rows.rejected.length, 1);
  assert.throws(() => requireComplete(rows), Invalid);
});

test('row-level import validates identifiers before calculating operations', () => {
  const operations = fromRows(sampleRegisters(), 'projects', [validProject()]);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].before_digest, null);
  assert.equal(operations[0].after.id, 'new-care');
});

test('identical imports are represented as no change while conflicting rows remain visible', () => {
  const registers = sampleRegisters();
  assert.deepEqual(fromRows(registers, 'projects', [registers.projects.get('care-north')]), []);
  const changed = { ...registers.projects.get('care-north'), name: 'Corrected title' };
  const operations = fromRows(registers, 'projects', [changed]);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].before_digest.length, 64);
  assert.equal(operations[0].after.name, 'Corrected title');
});

test('duplicate row identity in one import is rejected before applying operations', () => {
  assert.throws(() => fromRows(sampleRegisters(), 'projects', [validProject(), validProject()]), Invalid);
});

test('unknown register table is rejected consistently by row import and patch planning', () => {
  assert.throws(() => fromRows(sampleRegisters(), 'districts', []), Invalid);
  assert.throws(() => oneEntityPatch(sampleRegisters(), 'districts', 'n', null), Invalid);
});

test('entity patch uses optimistic digest and cannot change the entity identity', () => {
  const registers = sampleRegisters();
  const current = registers.projects.get('care-north');
  const replacement = { ...current, name: 'Verified title' };
  const operation = oneEntityPatch(registers, 'projects', current.id, replacement);
  assert.equal(operation.before_digest.length, 64);
  assert.equal(operation.after.name, 'Verified title');
  assert.throws(() => oneEntityPatch(registers, 'projects', current.id,
    { ...replacement, id: 'another-project' }), /identity/);
});

test('patch planner rejects deletion of a non-existent entity', () => {
  assert.throws(() => oneEntityPatch(sampleRegisters(), 'projects', 'absent', null), Invalid);
});

test('batch merger rejects the same business identity repeated across separate blocks', () => {
  const registers = sampleRegisters();
  const corrected = { ...registers.projects.get('care-north'), name: 'New name' };
  assert.throws(() => mergeRecords(registers, [
    { table: 'projects', rows: [corrected] },
    { table: 'projects', rows: [corrected] }
  ]), Conflict);
});

test('batch merger supports distinct entity tables in one atomic request', () => {
  const registers = sampleRegisters();
  const operations = mergeRecords(registers, [
    { table: 'projects', rows: [validProject()] },
    { table: 'milestones', rows: [{ id: 'milestone-new', project: 'care-north',
      code: 'inspection', due_date: 20271201, required: true }] }
  ]);
  assert.equal(operations.length, 2);
  assert.equal(new Set(operations.map(row => row.table)).size, 2);
});

test('preview applies a whole import on a cloned cross-table snapshot', () => {
  const registers = sampleRegisters();
  const projectOps = fromRows(registers, 'projects', [validProject()]);
  const operation = projectOps[0];
  const preview = validateImportPreview(registers, [operation]);
  assert.equal(preview.changed_entities.length, 1);
  assert.notEqual(preview.after_digest, registers.fingerprint);
  assert.equal(registers.projects.size, 2);
});

test('preview catches stale before-digests before validating the resulting snapshot', () => {
  const registers = sampleRegisters();
  const operation = fromRows(registers, 'projects', [
    { ...registers.projects.get('care-north'), name: 'New title' }
  ])[0];
  operation.before_digest = '0'.repeat(64);
  assert.throws(() => validateImportPreview(registers, [operation]), Conflict);
});

test('preview validates all foreign keys after applying staged operations', () => {
  const registers = sampleRegisters();
  const operation = fromRows(registers, 'appropriations', [{ id: 'bad-authorization', project: 'missing',
    fiscal_year: 2027, authorized: '100.00', source: 'grant' }])[0];
  assert.throws(() => validateImportPreview(registers, [operation]), /project missing/);
});

test('preview may add a parent and dependent row together when the final set is valid', () => {
  const registers = sampleRegisters();
  const project = validProject('new-parent');
  const projectOp = fromRows(registers, 'projects', [project])[0];
  const staged = new (registers.constructor)({ ...registers.export(), projects: [...registers.projects.values(), project] });
  const appropriation = { id: 'new-auth', project: project.id, fiscal_year: 2027,
    authorized: '120.00', source: 'grant' };
  const appropriationOp = fromRows(staged, 'appropriations', [appropriation])[0];
  const preview = validateImportPreview(registers, [projectOp, appropriationOp]);
  assert.equal(preview.changed_entities.length, 2);
});

test('preview enforces an explicit project-count policy without mutating the source', () => {
  const registers = sampleRegisters();
  const operation = fromRows(registers, 'projects', [validProject()])[0];
  assert.throws(() => validateImportPreview(registers, [operation], 2), /exceeds policy/);
  assert.equal(registers.projects.size, 2);
});

test('preview refuses duplicate entity operations within the same staged transaction', () => {
  const registers = sampleRegisters();
  const operation = fromRows(registers, 'projects', [validProject()])[0];
  assert.throws(() => validateImportPreview(registers, [operation, operation]), Conflict);
});

test('malformed mapping never coerces blank required cells to zero or empty identifiers', () => {
  const csv = 'id,county,program,name,start,end,status\n,c,p,Name,2027,2028,planned';
  const result = translate(csv, mappingFor('projects', projectHeaders), SCHEMAS, false);
  assert.equal(result.accepted.length, 1);
  assert.throws(() => fromRows(sampleRegisters(), 'projects', result.accepted), Invalid);
});

test('header order can change while mapped records retain their canonical field meanings', () => {
  const headers = ['name', 'id', 'status', 'end', 'start', 'program', 'county'];
  const values = ['North extension', 'ext-1', 'planned', '2029', '2027', 'home-care', 'county-n'];
  const result = fromCSV(sampleRegisters(), `${headers.join(',')}\n${values.join(',')}`,
    mappingFor('projects', headers), SCHEMAS);
  assert.equal(result.operations[0].after.id, 'ext-1');
  assert.equal(result.operations[0].after.start, 2027);
  assert.equal(result.operations[0].after.name, 'North extension');
});

test('large row sets remain bounded at the public import boundary', () => {
  const registers = sampleRegisters();
  assert.throws(() => fromRows(registers, 'projects', new Array(100001).fill(validProject())), Invalid);
});

test('invalid status and noncanonical year values stay in the rejected-row report', () => {
  const csv = 'id,county,program,name,start,end,status\nx,c,p,N,20x7,2028,maybe';
  const result = translate(csv, mappingFor('projects', projectHeaders), SCHEMAS, false);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.accepted.length, 0);
});

test('an incomplete strict import produces no partially accepted batch object', () => {
  const csv = 'id,county,program,name,start,end\nx,c,p,N,2027,2028';
  assert.throws(() => fromCSV(sampleRegisters(), csv,
    mappingFor('projects', projectHeaders.slice(0, -1)), SCHEMAS), Invalid);
});
