import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from '../closeout/journal.js';
import { backupDatabase, restoreDatabase, replayDatabase } from '../closeout/recovery.js';
import { exportArchive, inspectArchive } from '../closeout/archive.js';
import { buildCloseout, verifyCloseout, revisionImpact } from '../closeout/periods.js';
import { fromRows } from '../ingestion/operations.js';
import { TABLES } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';
import { Conflict, Invalid } from '../ledger/values.js';
import { paymentMatch, sampleRegisters, temporaryDirectory } from './support.js';

function initialize(directory) {
  const journal = new Journal(join(directory, 'register.sqlite'));
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/accounts.json', import.meta.url), 'utf8'));
  let registers = journal.registers();
  for (const table of TABLES) {
    const operations = fromRows(registers, table, fixture[table]);
    if (operations.length) {
      journal.import(`seed-${table}`, journal.registerRevision(), operations);
      registers = journal.registers();
    }
  }
  return journal;
}

function addMatch(journal, id = 'match-north', cents = 125000) {
  const match = paymentMatch(id, 'pay-n-01', 'exp-n-01', cents);
  return journal.matchBatch(`batch-${id}`, journal.matchRevision(), { action: 'append', match });
}

test('journal commits each source import as a version and recognizes exact batch retries', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    const revision = journal.registerRevision();
    assert.equal(revision, 6);
    const projects = journal.registers().projects.size;
    const empty = journal.registers(0);
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/accounts.json', import.meta.url), 'utf8'));
    const retry = journal.import('seed-projects', 0, fromRows(empty, 'projects', fixture.projects));
    assert.equal(retry.duplicate, true);
    assert.equal(journal.registers().projects.size, projects);
    assert.equal(journal.audit().valid, true);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('batch identities reject changed content and stale bases', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    assert.throws(() => journal.import('seed-projects', 0, [{ table: 'projects', id: 'different' }]), Conflict);
    assert.throws(() => journal.import('later-batch', 0, []), Conflict);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('register import rejects invalid foreign references atomically', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    const base = journal.registerRevision();
    const registers = journal.registers();
    const operations = fromRows(registers, 'appropriations', [{ id: 'auth-invalid', project: 'absent',
      fiscal_year: 2027, authorized: '10.00', source: 'grant' }]);
    assert.throws(() => journal.import('bad-auth', base, operations), /project missing/);
    assert.equal(journal.registerRevision(), base);
    assert.equal(journal.registers().appropriations.has('auth-invalid'), false);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('match batches bind money once and return a duplicate response on retry', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    const first = addMatch(journal);
    const again = journal.matchBatch('batch-match-north', 0,
      { action: 'append', match: paymentMatch('match-north', 'pay-n-01', 'exp-n-01', 125000) });
    assert.equal(first.revision, 1);
    assert.equal(again.duplicate, true);
    assert.equal(journal.matches().active().length, 1);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('stale match revision cannot overwrite an allocation written by another caller', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    addMatch(journal);
    assert.throws(() => journal.matchBatch('stale-match', 0,
      { action: 'append', match: paymentMatch('match-second', 'pay-n-01', 'exp-n-01', 1000) }), Conflict);
    assert.equal(journal.matches().active().length, 1);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('frozen closeout binds source revisions and refuses silent replacement', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    addMatch(journal);
    const first = journal.closePeriod('FY2026', journal.registerRevision(), journal.matchRevision(), 20261231);
    const duplicate = journal.closePeriod('FY2026', journal.registerRevision(), journal.matchRevision(), 20261231);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(journal.closeout('FY2026').state, 'frozen');
    assert.throws(() => journal.closePeriod('FY2026', journal.registerRevision(), 0, 20261231), Conflict);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('closeout report replays its indicators and rejects any changed total', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    addMatch(journal);
    const report = buildCloseout(journal.registers(), journal.matches(), 'FY26', { date_cutoff: 20261231 });
    assert.equal(verifyCloseout(journal.registers(), journal.matches(), report, true).valid, true);
    const edited = structuredClone(report);
    edited.portfolio.projects[0].expenses_cents += 1;
    assert.throws(() => verifyCloseout(journal.registers(), journal.matches(), edited), /checksum/);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('reopen creates a new closeout event while preserving the previous frozen report', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    addMatch(journal);
    const original = journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    const opened = journal.reopen('FY26', original.revision, 'correct an approved expense mapping');
    assert.equal(opened.state, 'open');
    assert.equal(journal.closeout('FY26').history.map(row => row.kind).join(','), 'frozen,reopened');
    const revised = journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    assert.equal(revised.revision, 3);
    assert.equal(journal.closeout('FY26').state, 'frozen');
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('reopen requires the latest revision and a meaningful audit reason', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    const frozen = journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    assert.throws(() => journal.reopen('FY26', 2, 'reason'), Conflict);
    assert.throws(() => journal.reopen('FY26', frozen.revision, '  '), Invalid);
    assert.equal(journal.closeout('FY26').state, 'frozen');
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('snapshot stays bound to the exact frozen report after a later revision', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    const frozen = journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    journal.snapshot('public-report-v1', 'FY26');
    assert.equal(journal.verifySnapshot('public-report-v1').snapshot_revision, frozen.revision);
    journal.reopen('FY26', frozen.revision, 'correct delivery evidence');
    journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    assert.equal(journal.verifySnapshot('public-report-v1').immutable, true);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('snapshot identity cannot be redirected to a changed period revision', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    journal.snapshot('annual-report', 'FY26');
    journal.reopen('FY26', 1, 'correction');
    journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    assert.throws(() => journal.snapshot('annual-report', 'FY26'), Conflict);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('signed archive contains a reproducible report and detects edited files', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    addMatch(journal);
    journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    const report = journal.closeout('FY26').report;
    const archivePath = join(temp.path, 'annual-archive');
    assert.equal(exportArchive(journal.registers(), journal.matches(), report, archivePath).valid, true);
    assert.equal(inspectArchive(archivePath).files, 7);
    writeFileSync(join(archivePath, 'projects.csv'), 'tampered');
    assert.throws(() => inspectArchive(archivePath), /checksum/);
    journal.close();
  } finally {
    temp.cleanup();
  }
});

test('backup restore and event replay preserve the audit chain', () => {
  const temp = temporaryDirectory();
  try {
    const journal = initialize(temp.path);
    addMatch(journal);
    journal.closePeriod('FY26', journal.registerRevision(), journal.matchRevision());
    journal.snapshot('annual-report', 'FY26');
    journal.close();
    const source = join(temp.path, 'register.sqlite');
    const backup = backupDatabase(source, join(temp.path, 'backup.sqlite'));
    assert.equal(backup.audit.valid, true);
    const restored = restoreDatabase(join(temp.path, 'backup.sqlite'), join(temp.path, 'restored.sqlite'), backup.manifest_digest);
    assert.equal(restored.audit.valid, true);
    const replayed = replayDatabase(source, join(temp.path, 'replayed.sqlite'));
    assert.equal(replayed.audit.valid, true);
    assert.throws(() => restoreDatabase(join(temp.path, 'backup.sqlite'), join(temp.path, 'again.sqlite'), 'wrong'), /manifest/);
  } finally {
    temp.cleanup();
  }
});

test('closeout revision impact compares business rows and records prior version preservation', () => {
  const registers = sampleRegisters();
  const before = buildCloseout(registers, new MatchLedger(), 'FY26');
  const changedData = registers.export();
  changedData.projects[0].name = 'Changed north project';
  const changed = new (registers.constructor)(changedData);
  const after = buildCloseout(changed, new MatchLedger(), 'FY26');
  const impact = revisionImpact(before, after);
  assert.equal(impact.previous_closeout_preserved, true);
  assert.equal(impact.changed_projects.length, 1);
});

test('closeout revision cannot move its observation cutoff backwards', () => {
  const registers = sampleRegisters();
  const matches = new MatchLedger();
  const before = buildCloseout(registers, matches, 'FY26', { date_cutoff: 20261231 });
  const after = buildCloseout(registers, matches, 'FY26', { date_cutoff: 20260630 });
  assert.throws(() => revisionImpact(before, after), /cannot move backwards/);
});
