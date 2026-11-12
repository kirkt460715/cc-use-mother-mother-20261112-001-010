import sqlite3 from 'node:sqlite';
import { TABLES, Registers } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';
import { changePlan, applyOperations, validateCashConservation } from '../ledger/events.js';
import { fields, array, id, integer, digest, canonical, clone, Conflict, Invalid } from '../ledger/values.js';
import { reconcile, verifyReconciliation } from '../matching/reconcile.js';
import { buildCloseout, verifyCloseout } from './periods.js';

export class Journal {
  constructor(path) {
    this.database = new sqlite3.DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys=ON');
    this.database.exec('PRAGMA journal_mode=WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS register_versions(
        revision INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        body TEXT NOT NULL,
        parent INTEGER,
        batch TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS import_batches(
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS register_events(
        revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        before_digest TEXT,
        after_body TEXT,
        PRIMARY KEY(revision,ordinal)
      );
      CREATE TABLE IF NOT EXISTS match_batches(
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_versions(
        revision INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        body TEXT NOT NULL,
        parent INTEGER,
        batch TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS closeouts(
        period TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        register_revision INTEGER NOT NULL,
        match_revision INTEGER NOT NULL,
        report TEXT NOT NULL,
        report_digest TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS closeout_events(
        period TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        digest TEXT NOT NULL,
        previous TEXT,
        PRIMARY KEY(period,revision)
      );
      CREATE TABLE IF NOT EXISTS snapshots(
        id TEXT PRIMARY KEY,
        register_revision INTEGER NOT NULL,
        match_revision INTEGER NOT NULL,
        report TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );
    `);
    const empty = new Registers({ version: 1, ...Object.fromEntries(TABLES.map(table => [table, []])) });
    this.database.prepare('INSERT OR IGNORE INTO register_versions VALUES(0,?,?,NULL,NULL)').run(empty.fingerprint, canonical(empty.document));
    const noMatches = new MatchLedger();
    this.database.prepare('INSERT OR IGNORE INTO match_versions VALUES(0,?,?,NULL,NULL)').run(noMatches.fingerprint, canonical(noMatches.document));
  }

  close() {
    this.database.close();
  }

  transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  registerRevision() {
    return this.database.prepare('SELECT MAX(revision) value FROM register_versions').get().value;
  }

  matchRevision() {
    return this.database.prepare('SELECT MAX(revision) value FROM match_versions').get().value;
  }

  registers(revision = this.registerRevision()) {
    integer(revision, 'register revision');
    const row = this.database.prepare('SELECT * FROM register_versions WHERE revision=?').get(revision);
    if (!row) {
      throw new Invalid('register revision missing');
    }
    const result = new Registers(JSON.parse(row.body));
    if (result.fingerprint !== row.fingerprint) {
      throw new Invalid('register snapshot checksum mismatch');
    }
    return result;
  }

  matches(revision = this.matchRevision()) {
    integer(revision, 'match revision');
    const row = this.database.prepare('SELECT * FROM match_versions WHERE revision=?').get(revision);
    if (!row) {
      throw new Invalid('match revision missing');
    }
    const result = new MatchLedger(JSON.parse(row.body));
    if (result.fingerprint !== row.fingerprint) {
      throw new Invalid('match snapshot checksum mismatch');
    }
    return result;
  }

  import(batchId, baseRevision, operations) {
    id(batchId, 'batch');
    integer(baseRevision, 'base revision');
    array(operations, 'operations', 100000);
    const request = { base_revision: baseRevision, operations: clone(operations) };
    const signature = digest(request);
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM import_batches WHERE id=?').get(batchId);
      if (existing) {
        if (existing.fingerprint !== signature) {
          throw new Conflict('batch identity reused with different content');
        }
        return { batch: batchId, revision: existing.revision, duplicate: true,
                 input_digest: this.registers(existing.revision).fingerprint };
      }
      if (this.registerRevision() !== baseRevision) {
        throw new Conflict('stale register base revision');
      }
      const before = this.registers(baseRevision);
      const after = applyOperations(before, operations);
      const revision = baseRevision + 1;
      this.database.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?)').run(batchId, signature, baseRevision, revision, canonical(request));
      this.database.prepare('INSERT INTO register_versions VALUES(?,?,?,?,?)').run(revision, after.fingerprint, canonical(after.document), baseRevision, batchId);
      const insert = this.database.prepare('INSERT INTO register_events VALUES(?,?,?,?,?,?)');
      operations.forEach((operation, ordinal) => insert.run(revision, ordinal, operation.table, operation.id,
        operation.before_digest, operation.after === null ? null : canonical(operation.after)));
      return { batch: batchId, revision, duplicate: false, input_digest: after.fingerprint };
    });
  }

  replace(batchId, baseRevision, document) {
    const before = this.registers(baseRevision);
    const after = new Registers(document);
    const operations = [];
    for (const table of TABLES) {
      const first = before[table];
      const last = after[table];
      for (const key of [...new Set([...first.keys(), ...last.keys()])].sort()) {
        const left = first.get(key) ?? null;
        const right = last.get(key) ?? null;
        if (digest(left) !== digest(right)) {
          operations.push({ table, id: key, before_digest: left === null ? null : digest(left), after: right });
        }
      }
    }
    return this.import(batchId, baseRevision, operations);
  }

  matchBatch(batchId, baseRevision, operation) {
    id(batchId, 'batch');
    integer(baseRevision, 'base match revision');
    fields(operation, ['action', 'match']);
    const request = { base_revision: baseRevision, operation: clone(operation) };
    const signature = digest(request);
    return this.transaction(() => {
      const old = this.database.prepare('SELECT * FROM match_batches WHERE id=?').get(batchId);
      if (old) {
        if (old.fingerprint !== signature) {
          throw new Conflict('match batch identity reused');
        }
        return { batch: batchId, revision: old.revision, duplicate: true, match_digest: this.matches(old.revision).fingerprint };
      }
      if (baseRevision !== this.matchRevision()) {
        throw new Conflict('stale match ledger revision');
      }
      const previous = this.matches(baseRevision);
      let next;
      if (operation.action === 'append') {
        next = new MatchLedger({ ...previous.export(), matches: [...previous.export().matches, operation.match] });
      } else if (operation.action === 'reverse') {
        next = previous.reverse(operation.match);
      } else {
        throw new Invalid('unknown match operation');
      }
      const revision = baseRevision + 1;
      this.database.prepare('INSERT INTO match_versions VALUES(?,?,?,?,?)').run(revision, next.fingerprint, canonical(next.document), baseRevision, batchId);
      this.database.prepare('INSERT INTO match_batches VALUES(?,?,?,?)').run(batchId, signature, revision, canonical(request));
      return { batch: batchId, revision, duplicate: false, match_digest: next.fingerprint };
    });
  }

  closePeriod(period, registerRevision = this.registerRevision(), matchRevision = this.matchRevision(), dateCutoff = 21001231) {
    id(period, 'period');
    integer(registerRevision, 'register revision');
    integer(matchRevision, 'match revision');
    integer(dateCutoff, 'date cutoff', 20000101, 21001231);
    const registers = this.registers(registerRevision);
    const matches = this.matches(matchRevision);
    const report = buildCloseout(registers, matches, period, { date_cutoff: dateCutoff });
    validateCashConservation(registers);
    verifyCloseout(registers, matches, report, true);
    const signature = digest(report);
    return this.transaction(() => {
      const previous = this.database.prepare('SELECT * FROM closeouts WHERE period=?').get(period);
      if (previous && previous.state === 'frozen') {
        if (previous.report_digest === signature) {
          return { period, revision: previous.revision, duplicate: true, report_digest: signature };
        }
        throw new Conflict('period is frozen; create a new closeout revision');
      }
      const revision = previous ? previous.revision + 1 : 1;
      this.database.prepare('INSERT INTO closeouts VALUES(?,?,?,?,?,?,?) ON CONFLICT(period) DO UPDATE SET revision=excluded.revision,register_revision=excluded.register_revision,match_revision=excluded.match_revision,report=excluded.report,report_digest=excluded.report_digest,state=excluded.state')
        .run(period, revision, registerRevision, matchRevision, canonical(report), signature, 'frozen');
      this.appendCloseoutEvent(period, revision, 'frozen', { report_digest: signature, registerRevision, matchRevision });
      return { period, revision, duplicate: false, report_digest: signature };
    });
  }

  reopen(period, expectedRevision, reason) {
    id(period, 'period');
    integer(expectedRevision, 'expected revision', 1);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
      throw new Invalid('reopen reason required');
    }
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM closeouts WHERE period=?').get(period);
      if (!row || row.revision !== expectedRevision || row.state !== 'frozen') {
        throw new Conflict('closeout changed or is not frozen');
      }
      const revision = expectedRevision + 1;
      this.database.prepare("UPDATE closeouts SET revision=?,state='open' WHERE period=?").run(revision, period);
      this.appendCloseoutEvent(period, revision, 'reopened', { reason, prior_digest: row.report_digest });
      return { period, revision, state: 'open', reason };
    });
  }

  appendCloseoutEvent(period, revision, kind, body) {
    const previous = this.database.prepare('SELECT digest FROM closeout_events WHERE period=? ORDER BY revision DESC LIMIT 1').get(period)?.digest ?? null;
    const event = { period, revision, kind, body, previous };
    this.database.prepare('INSERT INTO closeout_events VALUES(?,?,?,?,?,?)').run(period, revision, kind, canonical(body), digest(event), previous);
  }

  closeout(period) {
    const row = this.database.prepare('SELECT * FROM closeouts WHERE period=?').get(period);
    if (!row) {
      throw new Invalid('closeout missing');
    }
    const report = JSON.parse(row.report);
    if (digest(report) !== row.report_digest) {
      throw new Invalid('closeout report checksum mismatch');
    }
    const history = [];
    let previous = null;
    const events = this.database.prepare('SELECT * FROM closeout_events WHERE period=? ORDER BY revision').all(period);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const body = JSON.parse(event.body);
      const actual = digest({ period, revision: event.revision, kind: event.kind, body, previous: event.previous });
      if (event.previous !== previous || actual !== event.digest || event.revision !== index + 1) {
        throw new Invalid('closeout event chain integrity failure');
      }
      history.push({ revision: event.revision, kind: event.kind, body, digest: event.digest });
      previous = event.digest;
    }
    const latest = history.at(-1);
    if (!latest || latest.revision !== row.revision || (row.state === 'frozen') !== (latest.kind === 'frozen')) {
      throw new Invalid('closeout state differs from event history');
    }
    verifyCloseout(this.registers(row.register_revision), this.matches(row.match_revision), report, true);
    return { period, revision: row.revision, state: row.state, register_revision: row.register_revision,
      match_revision: row.match_revision, report, history };
  }

  snapshot(idValue, period) {
    id(idValue, 'snapshot');
    const closeout = this.closeout(period);
    if (closeout.state !== 'frozen') {
      throw new Conflict('only frozen closeout can be snapshotted');
    }
    const body = { period, revision: closeout.revision, report: closeout.report,
                   register_revision: closeout.register_revision, match_revision: closeout.match_revision };
    const signature = digest(body);
    const old = this.database.prepare('SELECT * FROM snapshots WHERE id=?').get(idValue);
    if (old) {
      if (old.fingerprint !== signature) {
        throw new Conflict('snapshot id already binds another closeout');
      }
      return { id: idValue, fingerprint: signature, duplicate: true };
    }
    this.database.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(idValue, closeout.register_revision,
      closeout.match_revision, canonical(body), signature);
    return { id: idValue, fingerprint: signature, duplicate: false };
  }

  verifySnapshot(idValue) {
    const row = this.database.prepare('SELECT * FROM snapshots WHERE id=?').get(idValue);
    if (!row) {
      throw new Invalid('snapshot missing');
    }
    const body = JSON.parse(row.report);
    if (digest(body) !== row.fingerprint || body.register_revision !== row.register_revision || body.match_revision !== row.match_revision) {
      throw new Invalid('snapshot binding integrity failure');
    }
    const current = this.closeout(body.period);
    const historical = this.registers(body.register_revision);
    const matches = this.matches(body.match_revision);
    verifyCloseout(historical, matches, body.report, true);
    return { valid: true, period: body.period, current_revision: current.revision,
      snapshot_revision: body.revision, immutable: body.revision !== current.revision || current.state !== 'frozen' };
  }

  audit() {
    if (this.database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || this.database.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Invalid('SQLite integrity failure');
    }
    for (let revision = 0; revision <= this.registerRevision(); revision += 1) {
      const current = this.registers(revision);
      if (revision > 0) {
        const row = this.database.prepare('SELECT * FROM register_versions WHERE revision=?').get(revision);
        const prior = this.registers(revision - 1);
        const events = this.database.prepare('SELECT * FROM register_events WHERE revision=? ORDER BY ordinal').all(revision);
        const batch = this.database.prepare('SELECT body FROM import_batches WHERE id=?').get(row.batch);
        if (!batch || events.length !== JSON.parse(batch.body).operations.length) {
          throw new Invalid('register event count differs from batch');
        }
        const replayed = this.replaceInMemory(prior, JSON.parse(batch.body).operations);
        if (replayed.fingerprint !== current.fingerprint) {
          throw new Invalid('register version does not replay from journal');
        }
      }
    }
    for (let revision = 0; revision <= this.matchRevision(); revision += 1) {
      const matches = this.matches(revision);
      if (revision > 0) {
        const row = this.database.prepare('SELECT * FROM match_versions WHERE revision=?').get(revision);
        const prior = this.matches(revision - 1);
        const batch = this.database.prepare('SELECT body FROM match_batches WHERE id=?').get(row.batch);
        const request = JSON.parse(batch.body).operation;
        let replayed;
        if (request.action === 'append') {
          replayed = new MatchLedger({ ...prior.export(), matches: [...prior.export().matches, request.match] });
        } else {
          replayed = prior.reverse(request.match);
        }
        if (replayed.fingerprint !== matches.fingerprint) {
          throw new Invalid('match version does not replay');
        }
      }
    }
    for (const row of this.database.prepare('SELECT period FROM closeouts').all()) {
      this.closeout(row.period);
    }
    for (const row of this.database.prepare('SELECT id FROM snapshots').all()) {
      this.verifySnapshot(row.id);
    }
    return { valid: true, register_revision: this.registerRevision(), match_revision: this.matchRevision(),
      batches: this.database.prepare('SELECT COUNT(*) count FROM import_batches').get().count,
      closeouts: this.database.prepare('SELECT COUNT(*) count FROM closeouts').get().count,
      snapshots: this.database.prepare('SELECT COUNT(*) count FROM snapshots').get().count };
  }

  replaceInMemory(before, operations) {
    return applyOperations(before, operations);
  }
}
