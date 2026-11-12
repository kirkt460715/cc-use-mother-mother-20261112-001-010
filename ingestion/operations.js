import { TABLES, Registers } from '../ledger/registers.js';
import { fields, id, digest, clone, Invalid, Conflict } from '../ledger/values.js';
import { translate, requireComplete } from './mapping.js';

export function fromRows(registers, table, rows) {
  if (!TABLES.includes(table) || !Array.isArray(rows) || rows.length > 100000) {
    throw new Invalid('valid table and bounded rows required');
  }
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Invalid('record object required');
    }
    id(row.id);
    if (seen.has(row.id)) {
      throw new Invalid('duplicate entity within import');
    }
    seen.add(row.id);
    const old = registers[table].get(row.id) ?? null;
    if (digest(old) === digest(row)) {
      continue;
    }
    output.push({ table, id: row.id, before_digest: old === null ? null : digest(old), after: clone(row) });
  }
  return output;
}

export function fromCSV(registers, content, specification, schemas, strict = true) {
  const result = translate(content, specification, schemas, strict);
  const rows = requireComplete(result);
  return { translation: { table: result.table, accepted: result.accepted.length, rejected: result.rejected,
      unmapped_columns: result.unmapped_columns },
    operations: fromRows(registers, result.table, rows),
    atomic_batch_required: true };
}

export function oneEntityPatch(registers, table, entityId, replacement) {
  if (!TABLES.includes(table)) {
    throw new Invalid('unknown register table');
  }
  id(entityId);
  const current = registers[table].get(entityId) ?? null;
  if (replacement !== null && replacement.id !== entityId) {
    throw new Invalid('replacement identity cannot change');
  }
  if (current === null && replacement === null) {
    throw new Invalid('cannot delete absent entity');
  }
  return { table, id: entityId, before_digest: current === null ? null : digest(current), after: clone(replacement) };
}

export function mergeRecords(registers, batches) {
  if (!Array.isArray(batches) || batches.length > 1000) {
    throw new Invalid('bounded batch list required');
  }
  const operations = [];
  const seen = new Set();
  for (const batch of batches) {
    fields(batch, ['table', 'rows']);
    for (const operation of fromRows(registers, batch.table, batch.rows)) {
      const key = `${operation.table}\0${operation.id}`;
      if (seen.has(key)) {
        throw new Conflict('same entity appears across import blocks');
      }
      seen.add(key);
      operations.push(operation);
    }
  }
  return operations;
}

export function validateImportPreview(registers, operations, maxProjects = 1000) {
  if (!Number.isSafeInteger(maxProjects) || maxProjects < 1 || maxProjects > 10000) {
    throw new Invalid('project bound invalid');
  }
  const afterTables = Object.fromEntries(TABLES.map(table => [table, new Map(registers[table])]));
  for (const operation of operations) {
    fields(operation, ['table', 'id', 'before_digest', 'after']);
    if (!TABLES.includes(operation.table)) {
      throw new Invalid('unknown preview table');
    }
    const current = afterTables[operation.table].get(operation.id) ?? null;
    if ((current === null ? null : digest(current)) !== operation.before_digest) {
      throw new Conflict('preview entity changed');
    }
    if (operation.after === null) {
      afterTables[operation.table].delete(operation.id);
    } else {
      afterTables[operation.table].set(operation.id, clone(operation.after));
    }
  }
  const after = new Registers({ version: 1, ...Object.fromEntries(TABLES.map(table => [table, [...afterTables[table].values()]])) });
  if (after.projects.size > maxProjects) {
    throw new Invalid('preview project count exceeds policy');
  }
  const changed = [];
  for (const table of TABLES) {
    const first = registers[table];
    const last = after[table];
    for (const key of [...new Set([...first.keys(), ...last.keys()])]) {
      if (digest(first.get(key) ?? null) !== digest(last.get(key) ?? null)) {
        changed.push({ table, id: key, before: first.get(key) ?? null, after: last.get(key) ?? null });
      }
    }
  }
  return { before_digest: registers.fingerprint, after_digest: after.fingerprint,
    changed_entities: changed, operations, no_source_mutation: true,
    validation: 'full_register_schema_and_reference_validation' };
}
