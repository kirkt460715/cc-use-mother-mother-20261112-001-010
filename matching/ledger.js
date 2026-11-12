import { fields, array, id, integer, digest, clone, Invalid, Conflict } from '../ledger/values.js';
import { planMatch } from './allocator.js';

export function normalizeMatch(row) {
  fields(row, ['id', 'source_ledger', 'source_id', 'target_ledger', 'target_id', 'amount_cents', 'state', 'created_at', 'reversed_by']);
  id(row.id, 'match');
  if (!['disbursement', 'expense'].includes(row.source_ledger) || !['disbursement', 'expense'].includes(row.target_ledger)) {
    throw new Invalid('unknown match side ledger');
  }
  id(row.source_id, 'source id');
  id(row.target_id, 'target id');
  integer(row.amount_cents, 'match amount', 1, Number.MAX_SAFE_INTEGER);
  integer(row.created_at, 'created_at', 20000101, 21001231);
  if (!['active', 'reversed'].includes(row.state)) {
    throw new Invalid('unknown match state');
  }
  if (row.state === 'active' && row.reversed_by !== null) {
    throw new Invalid('active match cannot have reversal identity');
  }
  if (row.state === 'reversed') {
    id(row.reversed_by, 'reversed_by');
  }
}

export class MatchLedger {
  constructor(document = { version: 1, matches: [], reversals: [] }) {
    fields(document, ['version', 'matches', 'reversals']);
    if (document.version !== 1) {
      throw new Invalid('unsupported match ledger version');
    }
    this.document = clone(document);
    array(this.document.matches, 'matches', 100000);
    array(this.document.reversals, 'reversals', 100000);
    this.matches = new Map();
    for (const row of this.document.matches) {
      normalizeMatch(row);
      if (this.matches.has(row.id)) {
        throw new Invalid('duplicate match identity');
      }
      this.matches.set(row.id, row);
    }
    this.reversals = new Map();
    for (const row of this.document.reversals) {
      fields(row, ['id', 'match', 'date', 'reason', 'amount_cents']);
      id(row.id);
      id(row.match);
      integer(row.date, 'reversal date', 20000101, 21001231);
      integer(row.amount_cents, 'reversal amount', 1, Number.MAX_SAFE_INTEGER);
      if (!this.matches.has(row.match) || this.reversals.has(row.id)) {
        throw new Invalid('reversal references missing match or duplicates');
      }
      this.reversals.set(row.id, row);
    }
    for (const match of this.matches.values()) {
      if (match.state === 'active' && [...this.reversals.values()].some(row => row.match === match.id)) {
        throw new Invalid('active match has reversal event');
      }
      if (match.state === 'reversed') {
        const reversal = this.reversals.get(match.reversed_by);
        if (!reversal || reversal.match !== match.id || reversal.amount_cents !== match.amount_cents) {
          throw new Invalid('match state and reversal event disagree');
        }
      }
    }
    this.document.matches.sort((a, b) => a.id.localeCompare(b.id));
    this.document.reversals.sort((a, b) => a.id.localeCompare(b.id));
    this.fingerprint = digest(this.document);
  }

  export() {
    return clone(this.document);
  }

  active() {
    return [...this.matches.values()].filter(row => row.state === 'active');
  }

  append(row, balances) {
    normalizeMatch(row);
    if (this.matches.has(row.id)) {
      const old = this.matches.get(row.id);
      if (digest(old) !== digest(row)) {
        throw new Conflict('match identity already has different content');
      }
      return { ledger: this, duplicate: true };
    }
    const source = balances(row.source_ledger);
    const target = balances(row.target_ledger);
    planMatch(row.source_ledger, row.source_id, row.target_ledger, row.target_id,
      row.amount_cents, source, target);
    const document = this.export();
    document.matches.push(clone(row));
    return { ledger: new MatchLedger(document), duplicate: false };
  }

  reverse(reversal) {
    fields(reversal, ['id', 'match', 'date', 'reason', 'amount_cents']);
    id(reversal.id);
    id(reversal.match);
    integer(reversal.date, 'reversal date', 20000101, 21001231);
    integer(reversal.amount_cents, 'reversal amount', 1, Number.MAX_SAFE_INTEGER);
    if (typeof reversal.reason !== 'string' || !reversal.reason.trim()) {
      throw new Invalid('reversal reason required');
    }
    const match = this.matches.get(reversal.match);
    if (!match || match.state !== 'active' || reversal.amount_cents !== match.amount_cents) {
      throw new Conflict('only active full match can be reversed');
    }
    if (reversal.date < match.created_at || this.reversals.has(reversal.id)) {
      throw new Conflict('reversal date or identity invalid');
    }
    const document = this.export();
    document.reversals.push(clone(reversal));
    const target = document.matches.find(row => row.id === match.id);
    target.state = 'reversed';
    target.reversed_by = reversal.id;
    return new MatchLedger(document);
  }
}

export function activeAllocations(ledger, ledgerType, entityId) {
  id(entityId);
  if (!['disbursement', 'expense'].includes(ledgerType)) {
    throw new Invalid('unknown allocation ledger');
  }
  const rows = [];
  for (const match of ledger.active()) {
    if (match.source_ledger === ledgerType && match.source_id === entityId) {
      rows.push({ match: match.id, side: 'source', other_ledger: match.target_ledger,
                  other_id: match.target_id, amount_cents: match.amount_cents });
    }
    if (match.target_ledger === ledgerType && match.target_id === entityId) {
      rows.push({ match: match.id, side: 'target', other_ledger: match.source_ledger,
                  other_id: match.source_id, amount_cents: match.amount_cents });
    }
  }
  return rows.sort((a, b) => a.match.localeCompare(b.match));
}
