import { mkdtempSync, rmSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registers, TABLES } from './ledger/registers.js';
import { MatchLedger } from './matching/ledger.js';
import { Journal } from './closeout/journal.js';
import { backupDatabase, restoreDatabase, replayDatabase } from './closeout/recovery.js';
import { buildCloseout, verifyCloseout, revisionImpact } from './closeout/periods.js';
import { fromRows, fromCSV, validateImportPreview } from './ingestion/operations.js';
import { SCHEMAS } from './ingestion/schemas.js';
import { dispatch, page } from './portfolio/query.js';
import { planMatch, automaticMatch, proportional } from './matching/allocator.js';
import { reconcile, verifyReconciliation } from './matching/reconcile.js';
import { exportArchive, inspectArchive } from './closeout/archive.js';
import { canonical, load, integer, id, fields, Invalid } from './ledger/values.js';
import { controlReport, verifyControlReport, exposureByProgram, explainControlFinding } from './portfolio/controls.js';
import { translate } from './ingestion/mapping.js';
import { assessTranslation } from './ingestion/quality.js';

export function demo(path) {
  const registers = new Registers(load(path));
  const root = mkdtempSync(join(tmpdir(), 'investment-demo-'));
  try {
    const journal = new Journal(join(root, 'ledger.sqlite'));
    const empty = journal.registers();
    const operations = fromRows(empty, 'projects', [...registers.projects.values()]);
    const projectBatch = journal.import('projects-v1', 0, operations);
    let current = journal.registers();
    const appropriationRows = [...registers.appropriations.values()];
    const appropriationOps = fromRows(current, 'appropriations', appropriationRows);
    journal.import('appropriations-v1', 1, appropriationOps);
    current = journal.registers();
    const remaining = ['disbursements', 'expenses', 'milestones', 'deliverables', 'reversals'];
    for (const table of remaining) {
      const items = [...registers[table].values()];
      if (items.length) {
        const operations = fromRows(current, table, items);
        journal.import(`${table}-v1`, journal.registerRevision(), operations);
        current = journal.registers();
      }
    }
    const output = new MatchLedger();
    const source = [...current.disbursements.values()].find(row => row.kind === 'payment');
    const expense = [...current.expenses.values()][0];
    if (source && expense) {
      const match = { id: 'match-demo', source_ledger: 'disbursement', source_id: source.id,
        target_ledger: 'expense', target_id: expense.id,
        amount_cents: Math.min(Number(source.amount.replace('.', '')), Number(expense.amount.replace('.', ''))),
        state: 'active', created_at: source.date, reversed_by: null };
      journal.matchBatch('match-v1', 0, { action: 'append', match });
    }
    const result = journal.closePeriod('2026-close', journal.registerRevision(), journal.matchRevision(), 20261231);
    const closeout = journal.closeout('2026-close');
    const snapshot = journal.snapshot('2026-report', '2026-close');
    const archive = exportArchive(journal.registers(closeout.register_revision), journal.matches(closeout.match_revision), closeout.report, join(root, 'archive'));
    const saved = backupDatabase(join(root, 'ledger.sqlite'), join(root, 'backup.sqlite'));
    const restored = restoreDatabase(join(root, 'backup.sqlite'), join(root, 'restore.sqlite'), saved.manifest_digest);
    journal.close();
    const rebuilt = replayDatabase(join(root, 'ledger.sqlite'), join(root, 'replay.sqlite'));
    const verifiedArchive = inspectArchive(join(root, 'archive'));
    return { source: 'local_synthetic_fixture', imported_revision: projectBatch.revision,
      closeout: result, report_totals: closeout.report.reconciliation.totals,
      snapshot, archive: verifiedArchive, restored, rebuilt,
      audit: rebuilt.audit, projects: closeout.report.portfolio.projects.length };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function number(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Invalid(`${name} requires canonical integer`);
  }
  return Number(value);
}

function arity(values, min, max = min) {
  if (values.length < min || values.length > max) {
    throw new Invalid('incorrect command argument count');
  }
}

export function execute(argv) {
  const [command, ...args] = argv;
  if (!command) {
    throw new Invalid('command required');
  }
  if (command === 'demo') {
    arity(args, 1);
    return demo(args[0]);
  }
  if (command === 'preview-import') {
    arity(args, 4);
    const registers = new Registers(load(args[0]));
    const content = readFileSync(args[1], 'utf8');
    const specification = load(args[2]);
    const table = specification.table;
    const mapping = fromCSV(registers, content, specification, SCHEMAS);
    return validateImportPreview(registers, mapping.operations, number(args[3], 'project bound'));
  }
  if (command === 'assess-import') {
    arity(args, 2);
    const content = readFileSync(args[0], 'utf8');
    const specification = load(args[1]);
    return assessTranslation(translate(content, specification, SCHEMAS, false));
  }
  if (command === 'simulate-closeout') {
    arity(args, 3);
    const registers = new Registers(load(args[0]));
    const matches = new MatchLedger(load(args[1]));
    const report = buildCloseout(registers, matches, args[2]);
    verifyCloseout(registers, matches, report, true);
    return report;
  }
  if (command === 'controls') {
    arity(args, 2, 3);
    const journal = new Journal(args[0]);
    try {
      const registers = journal.registers(args[1] === '-' ? undefined : number(args[1], 'register revision'));
      const matches = journal.matches();
      const report = controlReport(registers, matches, args[2] ? number(args[2], 'as-of date') : 21001231);
      return { controls: report, verification: verifyControlReport(registers, matches, report),
        exposure_by_program: exposureByProgram(registers, report.as_of),
        evidence: report.issues.map(row => explainControlFinding(registers, matches, report, row.code, row.entity)) };
    } finally {
      journal.close();
    }
  }
  if (command === 'verify-archive') {
    arity(args, 1);
    return inspectArchive(args[0]);
  }
  if (command === 'restore') {
    arity(args, 3);
    return restoreDatabase(args[0], args[1], args[2]);
  }
  if (command === 'replay') {
    arity(args, 2);
    return replayDatabase(args[0], args[1]);
  }
  const required = { 'project-report': 3, 'register-page': 3, close: 3, reopen: 4, audit: 1, backup: 2, snapshot: 3, 'verify-snapshot': 2, 'match-page': 4 };
  if (!Object.hasOwn(required, command)) {
    throw new Invalid('unknown command');
  }
  arity(args, required[command]);
  if (command === 'project-report' || command === 'register-page' || command === 'match-page') {
    const journal = new Journal(args[0]);
    try {
      const registers = journal.registers(args[1] === '-' ? undefined : number(args[1], 'register revision'));
      const matches = journal.matches(args[2] === '-' ? undefined : number(args[2], 'match revision'));
      if (command === 'project-report') {
        return dispatch(registers, matches, args[3], {});
      }
      if (command === 'register-page') {
        return page(registers, matches, args[3], null, 100);
      }
      return pageMatchesCLI(registers, matches, args[3]);
    } finally {
      journal.close();
    }
  }
  const journal = new Journal(args[0]);
  try {
    if (command === 'close') {
      return journal.closePeriod(args[1], number(args[2], 'register revision'), journal.matchRevision());
    }
    if (command === 'reopen') {
      return journal.reopen(args[1], number(args[2], 'revision'), args[3]);
    }
    if (command === 'audit') {
      return journal.audit();
    }
    if (command === 'backup') {
      return backupDatabase(args[0], args[1]);
    }
    if (command === 'snapshot') {
      return journal.snapshot(args[1], args[2]);
    }
    if (command === 'verify-snapshot') {
      return journal.verifySnapshot(args[1]);
    }
  } finally {
    journal.close();
  }
}

function pageMatchesCLI(registers, matches, state) {
  if (!['active', 'reversed', 'all'].includes(state)) {
    throw new Invalid('state requires active, reversed or all');
  }
  return [...matches.matches.values()].filter(row => state === 'all' || row.state === state).sort((a,b) => a.id.localeCompare(b.id));
}

export function main(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(canonical(execute(argv)) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(canonical({ error: error.message, type: error.name }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
