import { readFileSync, lstatSync } from 'node:fs';
import { TABLES } from '../ledger/registers.js';
import { fields, id, array, integer, Invalid } from '../ledger/values.js';

export function parseRecords(text, maximum = 100000) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 50000000) {
    throw new Invalid('bounded record source required');
  }
  integer(maximum, 'maximum records', 1, 100000);
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      if (index === text.split(/\r?\n/).length - 1) {
        continue;
      }
      throw new Invalid(`blank line at ${index + 1}`);
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Invalid(`invalid JSON at line ${index + 1}: ${error.message}`);
    }
    if (records.length > maximum) {
      throw new Invalid('record count exceeds maximum');
    }
  }
  return records;
}

export function operationsFromFile(path, maximum = 100000) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50000000) {
    throw new Invalid('bounded regular operation file required');
  }
  const content = readFileSync(path, 'utf8');
  return parseRecords(content, maximum);
}

export function operationsFromRows(registers, table, rows) {
  if (!TABLES.includes(table)) {
    throw new Invalid('unknown register table');
  }
  array(rows, 'import rows', 100000);
  const existing = registers[table];
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Invalid('import row object required');
    }
    id(row.id);
    if (seen.has(row.id)) {
      throw new Invalid('duplicate import entity');
    }
    seen.add(row.id);
    const before = existing.get(row.id) ?? null;
    return { table, id: row.id, before_digest: before === null ? null : (awaitDigest(before)), after: row };
  });
}

function awaitDigest(value) {
  return digest(value);
}

import { digest } from '../ledger/values.js';

export function operationsFromCSV(registers, content, specification, schemas) {
  const { translate, requireComplete } = requireMapping();
  const translated = translate(content, specification, schemas);
  const rows = requireComplete(translated);
  return { translated, operations: operationsFromRows(registers, specification.table, rows) };
}

function requireMapping() {
  return mappingModule;
}

import * as mappingModule from './mapping.js';
