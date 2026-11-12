import { createHash } from 'node:crypto';
import { copyFileSync, constants, existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from './journal.js';
import { digest, canonical, load, Invalid } from '../ledger/values.js';

function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function backupDatabase(source, destination) {
  if (existsSync(destination)) {
    throw new Invalid('backup destination already exists');
  }
  mkdirSync(dirname(destination), { recursive: true });
  const database = new DatabaseSync(source);
  try {
    const escaped = destination.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    database.close();
  }
  try {
    const journal = new Journal(destination);
    const audit = journal.audit();
    journal.close();
    const path = destination + '.manifest.json';
    const manifest = { version: 1, database_sha256: fileDigest(destination), bytes: lstatSync(destination).size };
    writeFileSync(path, canonical(manifest), { flag: 'wx' });
    return { manifest, manifest_digest: digest(manifest), audit };
  } catch (error) {
    rmSync(destination, { force: true });
    rmSync(destination + '.manifest.json', { force: true });
    throw error;
  }
}

export function restoreDatabase(source, destination, expectedManifestDigest) {
  const manifestPath = source + '.manifest.json';
  const manifest = load(manifestPath);
  if (manifest.version !== 1 || digest(manifest) !== expectedManifestDigest || fileDigest(source) !== manifest.database_sha256) {
    throw new Invalid('backup manifest or database checksum mismatch');
  }
  if (existsSync(destination)) {
    throw new Invalid('restore destination already exists');
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  try {
    const journal = new Journal(destination);
    const audit = journal.audit();
    journal.close();
    return { restored: true, audit };
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

export function replayDatabase(source, destination) {
  if (existsSync(destination)) {
    throw new Invalid('replay destination already exists');
  }
  const sourceJournal = new Journal(source);
  const sourceAudit = sourceJournal.audit();
  mkdirSync(dirname(destination), { recursive: true });
  const target = new Journal(destination);
  try {
    for (const row of sourceJournal.database.prepare('SELECT id,body FROM import_batches ORDER BY revision').all()) {
      const request = JSON.parse(row.body);
      target.import(row.id, request.base_revision, request.operations);
    }
    for (const row of sourceJournal.database.prepare('SELECT id,body FROM match_batches ORDER BY revision').all()) {
      const request = JSON.parse(row.body);
      target.matchBatch(row.id, request.base_revision, request.operation);
    }
    for (const closeout of sourceJournal.database.prepare('SELECT period,register_revision,match_revision,report FROM closeouts ORDER BY period').all()) {
      let current = target.database.prepare('SELECT * FROM closeouts WHERE period=?').get(closeout.period);
      const sourceEvents = sourceJournal.database.prepare('SELECT * FROM closeout_events WHERE period=? ORDER BY revision').all(closeout.period);
      if (!sourceEvents.length) {
        throw new Invalid('source closeout has no events');
      }
      const last = sourceEvents.at(-1);
      if (last.kind === 'frozen') {
        if (current?.state === 'frozen') {
          target.reopen(closeout.period, current.revision, 'replay source closeout history');
        }
        target.closePeriod(closeout.period, closeout.register_revision, closeout.match_revision, JSON.parse(closeout.report).cutoff);
      } else if (last.kind === 'reopened' && current?.state === 'frozen') {
        target.reopen(closeout.period, current.revision, JSON.parse(last.body).reason);
      }
    }
    for (const row of sourceJournal.database.prepare('SELECT id,report FROM snapshots ORDER BY id').all()) {
      const body = JSON.parse(row.report);
      if (target.closeout(body.period).state === 'open') {
        throw new Invalid('source snapshot references open period');
      }
      target.snapshot(row.id, body.period);
    }
    const audit = target.audit();
    if (audit.register_revision !== sourceAudit.register_revision || audit.match_revision !== sourceAudit.match_revision) {
      throw new Invalid('replayed revision heads differ from source');
    }
    target.close();
    sourceJournal.close();
    return { replayed: true, audit };
  } catch (error) {
    target.close();
    sourceJournal.close();
    rmSync(destination, { force: true });
    rmSync(destination + '-wal', { force: true });
    rmSync(destination + '-shm', { force: true });
    throw error;
  }
}
