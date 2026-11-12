import { TABLES } from '../ledger/registers.js';
import { Invalid } from '../ledger/values.js';

export const SCHEMAS = {
  projects: ['id', 'county', 'program', 'name', 'start', 'end', 'status'],
  appropriations: ['id', 'project', 'fiscal_year', 'authorized', 'source'],
  disbursements: ['id', 'appropriation', 'date', 'amount', 'kind', 'external_ref'],
  expenses: ['id', 'project', 'date', 'amount', 'category', 'vendor_ref'],
  milestones: ['id', 'project', 'code', 'due_date', 'required'],
  deliverables: ['id', 'project', 'milestone', 'accepted_date', 'units', 'evidence_ref'],
  reversals: ['id', 'disbursement', 'reversal_of', 'date', 'amount', 'reason']
};

export const CONVERSIONS = {
  id: value => value,
  county: value => value,
  program: value => value,
  name: value => value,
  start: Number,
  end: Number,
  status: value => value,
  project: value => value,
  fiscal_year: Number,
  authorized: value => value,
  source: value => value,
  appropriation: value => value,
  date: Number,
  amount: value => value,
  kind: value => value,
  external_ref: value => value,
  category: value => value,
  vendor_ref: value => value,
  code: value => value,
  due_date: Number,
  required: value => value === 'true' ? true : value === 'false' ? false : value,
  milestone: value => value,
  accepted_date: value => value === '' ? null : Number(value),
  units: Number,
  evidence_ref: value => value,
  disbursement: value => value,
  reversal_of: value => value,
  reason: value => value
};

export function schemaFor(table) {
  if (!TABLES.includes(table)) {
    throw new Invalid('unknown mapping output table');
  }
  return SCHEMAS[table];
}

export function mappingFor(table, headers, defaults = {}) {
  const columns = schemaFor(table);
  const mapping = {};
  for (const column of columns) {
    if (headers.includes(column)) {
      mapping[column] = column;
    } else if (!Object.hasOwn(defaults, column)) {
      throw new Invalid(`missing mapping for ${column}`);
    }
  }
  return { version: 1, table, columns: mapping,
    defaults: Object.fromEntries(Object.entries(defaults).filter(([key]) => columns.includes(key))),
    values: {} };
}

export function converters(table) {
  return Object.fromEntries(schemaFor(table).map(key => [key, CONVERSIONS[key]]));
}
