import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registers } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';

export function sampleRegisters() {
  const path = new URL('../fixtures/accounts.json', import.meta.url);
  return new Registers(JSON.parse(readFileSync(path, 'utf8')));
}

export function paymentMatch(id, source, target, cents, date = 20260601) {
  return { id, source_ledger: 'disbursement', source_id: source,
    target_ledger: 'expense', target_id: target, amount_cents: cents,
    state: 'active', created_at: date, reversed_by: null };
}

export function allocationLedger(rows, reversals = []) {
  return new MatchLedger({ version: 1, matches: rows, reversals });
}

export function temporaryDirectory(prefix = 'investment-test-') {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
