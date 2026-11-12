import { TABLES, Registers, cashEffect } from './registers.js';
import { fields, array, id, integer, digest, canonical, clone, Invalid, Conflict } from './values.js';

export function changePlan(before, after) {
  const changes = [];
  const touchedProjects = new Set();
  const touchedAppropriations = new Set();
  const touchedMilestones = new Set();
  for (const table of TABLES) {
    const left = getattr(before, table);
    const right = getattr(after, table);
    const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const key of keys) {
      const first = left.get(key) ?? null;
      const last = right.get(key) ?? null;
      if (canonical(first) === canonical(last)) {
        continue;
      }
      changes.push({
        table,
        id: key,
        action: first === null ? 'added' : last === null ? 'removed' : 'changed',
        before_digest: first === null ? null : digest(first),
        after: clone(last)
      });
      for (const row of [first, last]) {
        if (!row) {
          continue;
        }
        if (table === 'projects') {
          touchedProjects.add(key);
        }
        if (table === 'appropriations') {
          touchedAppropriations.add(key);
          touchedProjects.add(row.project);
        }
        if (table === 'disbursements') {
          touchedAppropriations.add(row.appropriation);
        }
        if (table === 'expenses' || table === 'milestones' || table === 'deliverables') {
          touchedProjects.add(row.project);
        }
        if (table === 'milestones') {
          touchedMilestones.add(key);
        }
      }
    }
  }
  return {
    changes,
    affected_projects: [...touchedProjects].sort(),
    affected_appropriations: [...touchedAppropriations].sort(),
    affected_milestones: [...touchedMilestones].sort(),
    before_digest: before.fingerprint,
    after_digest: after.fingerprint
  };
}

function getattr(registers, table) {
  return registers[table];
}

export function applyOperations(source, operations) {
  array(operations, 'operations', 100000);
  const document = source.export();
  const tables = Object.fromEntries(TABLES.map(table => [table, new Map(document[table].map(row => [row.id, row]))]));
  const seen = new Set();
  for (const operation of operations) {
    fields(operation, ['table', 'id', 'before_digest', 'after']);
    const table = operation.table;
    id(operation.id);
    if (!TABLES.includes(table) || seen.has(`${table}\0${operation.id}`)) {
      throw new Invalid('unknown table or duplicate operation identity');
    }
    seen.add(`${table}\0${operation.id}`);
    const current = tables[table].get(operation.id) ?? null;
    const signature = current === null ? null : digest(current);
    if (signature !== operation.before_digest) {
      throw new Conflict('entity changed since patch was prepared');
    }
    if (operation.after === null) {
      if (current === null) {
        throw new Invalid('cannot remove absent row');
      }
      tables[table].delete(operation.id);
    } else {
      if (!operation.after || operation.after.id !== operation.id) {
        throw new Invalid('replacement must preserve id');
      }
      tables[table].set(operation.id, clone(operation.after));
    }
  }
  return new Registers({ version: 1, ...Object.fromEntries(TABLES.map(table => [table, [...tables[table].values()]])) });
}

export function planChange(before, operations) {
  const after = applyOperations(before, operations);
  const difference = changePlan(before, after);
  return {
    operations: clone(operations),
    before_digest: before.fingerprint,
    after_digest: after.fingerprint,
    affected_projects: difference.affected_projects,
    affected_appropriations: difference.affected_appropriations,
    affected_milestones: difference.affected_milestones,
    requires_full_register_validation: true
  };
}

export function cashJournal(registers) {
  const reversals = new Map([...registers.reversals.values()].map(row => [row.disbursement, row]));
  return [...registers.disbursements.values()].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id)).map(row => ({
    disbursement: row.id,
    appropriation: row.appropriation,
    external_ref: row.external_ref,
    date: row.date,
    kind: row.kind,
    signed_cents: cashEffect(registers, row),
    reversal_of: reversals.get(row.id)?.reversal_of ?? null
  }));
}

export function validateCashConservation(registers) {
  const actual = cashJournal(registers);
  for (const row of registers.appropriations.values()) {
    const related = actual.filter(item => item.appropriation === row.id);
    const signed = related.reduce((sum, item) => sum + item.signed_cents, 0);
    const expected = registers.disbursements.values();
    let total = 0;
    for (const item of expected) {
      if (item.appropriation === row.id) {
        total += cashEffect(registers, item);
      }
    }
    if (signed !== total) {
      throw new Invalid('cash event journal does not conserve balance');
    }
  }
  return {
    valid: true,
    events: actual.length,
    total_signed_cents: actual.reduce((sum, row) => sum + row.signed_cents, 0)
  };
}
