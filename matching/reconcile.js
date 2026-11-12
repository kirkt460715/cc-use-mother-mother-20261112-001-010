import { Registers, cashEffect, netCash } from '../ledger/registers.js';
import { MatchLedger, activeAllocations } from './ledger.js';
import { money, integer, id, digest, Invalid, Conflict } from '../ledger/values.js';

export function balances(registers, ledger, type, dateCutoff = 21001231) {
  integer(dateCutoff, 'date cutoff', 20000101, 21001231);
  const rows = [];
  if (type === 'disbursement') {
    for (const row of registers.disbursements.values()) {
      if (row.date > dateCutoff || row.kind !== 'payment') {
        continue;
      }
      const reversalTotal = [...registers.reversals.values()].filter(item => item.reversal_of === row.id && item.date <= dateCutoff).reduce((sum, item) => sum + money(item.amount), 0);
      const gross = money(row.amount) - reversalTotal;
      if (gross < 0) {
        throw new Invalid('refunds exceed original disbursement');
      }
      const allocated = activeAllocations(ledger, type, row.id).reduce((sum, match) => sum + match.amount_cents, 0);
      if (allocated > gross) {
        throw new Invalid('disbursement match overallocated');
      }
      rows.push({ id: row.id, gross_cents: gross, matched_cents: allocated,
                  available_cents: gross - allocated, external_ref: row.external_ref,
                  appropriation: row.appropriation, date: row.date });
    }
  } else if (type === 'expense') {
    for (const row of registers.expenses.values()) {
      if (row.date > dateCutoff) {
        continue;
      }
      const gross = money(row.amount);
      const allocated = activeAllocations(ledger, type, row.id).reduce((sum, match) => sum + match.amount_cents, 0);
      if (allocated > gross) {
        throw new Invalid('expense match overallocated');
      }
      rows.push({ id: row.id, gross_cents: gross, matched_cents: allocated,
                  available_cents: gross - allocated, vendor_ref: row.vendor_ref,
                  project: row.project, date: row.date });
    }
  } else {
    throw new Invalid('unknown match balance ledger');
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function balancedTotal(rows, key) {
  let total = 0;
  for (const row of rows) {
    integer(row[key], key, 0, Number.MAX_SAFE_INTEGER);
    total += row[key];
    if (!Number.isSafeInteger(total)) {
      throw new Invalid('ledger sum exceeds safe integer cents');
    }
  }
  return total;
}

export function matchRows(registers, ledger) {
  const sources = balances(registers, ledger, 'disbursement');
  const targets = balances(registers, ledger, 'expense');
  const bySource = new Map(sources.map(row => [row.id, row]));
  const byTarget = new Map(targets.map(row => [row.id, row]));
  const output = [];
  for (const match of ledger.active()) {
    const source = bySource.get(match.source_id);
    const target = byTarget.get(match.target_id);
    if (!source || !target) {
      throw new Invalid('active match references unavailable dated ledger row');
    }
    output.push({ ...match, source_available_after: source.available_cents,
                  target_available_after: target.available_cents,
                  source_external_ref: source.external_ref,
                  target_vendor_ref: target.vendor_ref });
  }
  return output.sort((a, b) => a.id.localeCompare(b.id));
}

export function reconcile(registers, ledger, options = {}) {
  const cutoff = options.date_cutoff ?? 21001231;
  const sourceRows = balances(registers, ledger, 'disbursement', cutoff);
  const targetRows = balances(registers, ledger, 'expense', cutoff);
  const disbursed = sourceRows.reduce((sum, row) => sum + row.gross_cents, 0);
  const spent = targetRows.reduce((sum, row) => sum + row.gross_cents, 0);
  const matched = ledger.active().filter(row => row.created_at <= cutoff && sourceRows.some(source => source.id === row.source_id) && targetRows.some(target => target.id === row.target_id)).reduce((sum, row) => sum + row.amount_cents, 0);
  if (matched > disbursed || matched > spent) {
    throw new Invalid('matched value exceeds a ledger total');
  }
  const exceptions = [];
  for (const row of sourceRows) {
    if (row.available_cents > 0) {
      exceptions.push({ ledger: 'disbursement', id: row.id, unallocated_cents: row.available_cents });
    }
  }
  for (const row of targetRows) {
    if (row.available_cents > 0) {
      exceptions.push({ ledger: 'expense', id: row.id, unallocated_cents: row.available_cents });
    }
  }
  const report = {
    version: 1,
    register_digest: registers.fingerprint,
    match_digest: ledger.fingerprint,
    date_cutoff: cutoff,
    totals: { disbursed_cents: disbursed, spent_cents: spent, matched_cents: matched,
              disbursed_minus_spent_cents: disbursed - spent,
              disbursed, spent, matched },
    unmatched: { disbursement_cents: disbursed - matched, expense_cents: spent - matched },
    exceptions: exceptions.sort((a, b) => a.ledger.localeCompare(b.ledger) || a.id.localeCompare(b.id)),
    matches: matchRows(registers, ledger),
    disposition: 'unmatched_is_difference_not_proof_of_misuse',
  };
  return report;
}

export function verifyReconciliation(registers, ledger, report, replay = false) {
  if (report.version !== 1 || report.register_digest !== registers.fingerprint || report.match_digest !== ledger.fingerprint) {
    throw new Invalid('reconciliation source binding mismatch');
  }
  if (report.totals.matched_cents !== ledger.active().reduce((sum, row) => sum + row.amount_cents, 0)) {
    throw new Invalid('reconciliation active match total mismatch');
  }
  if (report.totals.disbursed_cents - report.totals.matched_cents !== report.unmatched.disbursement_cents ||
      report.totals.spent_cents - report.totals.matched_cents !== report.unmatched.expense_cents) {
    throw new Invalid('reconciliation totals fail conservation');
  }
  if (replay) {
    const expected = reconcile(registers, ledger, { date_cutoff: report.date_cutoff });
    const subset = { ...report };
    delete subset.exceptions;
    delete subset.matches;
    delete subset.unmatched;
    delete subset.totals;
    delete subset.disposition;
    delete subset.version;
    delete subset.register_digest;
    delete subset.match_digest;
    const expectedOptions = { ...report };
    for (const key of ['version', 'register_digest', 'match_digest', 'date_cutoff', 'totals', 'unmatched', 'exceptions', 'matches', 'disposition']) {
      delete expectedOptions[key];
    }
    if (expected.totals.disbursed_cents !== report.totals.disbursed_cents ||
        expected.totals.spent_cents !== report.totals.spent_cents ||
        expected.totals.matched_cents !== report.totals.matched_cents ||
        digest(expected.matches) !== digest(report.matches) || digest(expected.exceptions) !== digest(report.exceptions)) {
      throw new Invalid('reconciliation semantic replay mismatch');
    }
  }
  return { valid: true, unmatched_disbursements: report.unmatched.disbursement_cents,
           unmatched_expenses: report.unmatched.expense_cents };
}
