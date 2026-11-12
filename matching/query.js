import { balances, matchRows, reconcile } from './reconcile.js';
import { activeAllocations } from './ledger.js';
import { integer, id, Invalid } from '../ledger/values.js';

export function sourceDetail(registers, ledger, ledgerType, entityId, cutoff = 21001231) {
  id(entityId);
  const source = ledgerType === 'disbursement' ? registers.disbursements.get(entityId) :
    ledgerType === 'expense' ? registers.expenses.get(entityId) : null;
  if (!source) {
    throw new Invalid('ledger source not found');
  }
  const balance = balances(registers, ledger, ledgerType, cutoff).find(row => row.id === entityId);
  if (!balance) {
    throw new Invalid('source excluded by date cutoff');
  }
  return { ledger: ledgerType, source, balance,
    active_matches: activeAllocations(ledger, ledgerType, entityId),
    audit_access: 'restricted_transaction_detail' };
}

export function pageMatches(registers, ledger, after = null, limit = 100, state = 'active') {
  integer(limit, 'limit', 1, 1000);
  if (after !== null) {
    id(after, 'after');
  }
  if (!['active', 'reversed', 'all'].includes(state)) {
    throw new Invalid('unknown match state');
  }
  const rows = [...ledger.matches.values()].filter(row => state === 'all' || row.state === state)
    .sort((a, b) => a.id.localeCompare(b.id)).filter(row => after === null || row.id > after);
  const result = rows.slice(0, limit).map(row => ({ ...row,
    source: row.source_ledger === 'disbursement' ? registers.disbursements.get(row.source_id) : registers.expenses.get(row.source_id),
    target: row.target_ledger === 'disbursement' ? registers.disbursements.get(row.target_id) : registers.expenses.get(row.target_id) }));
  return { rows: result, next_after: rows.length > limit ? result.at(-1).id : null,
    match_digest: ledger.fingerprint, stable_for_match_snapshot: true };
}

export function reconciliationExceptions(registers, ledger, cutoff = 21001231) {
  const report = reconcile(registers, ledger, { date_cutoff: cutoff });
  const groups = new Map();
  for (const row of report.exceptions) {
    const key = row.ledger;
    if (!groups.has(key)) groups.set(key, { ledger: key, rows: 0, amount_cents: 0 });
    groups.get(key).rows += 1;
    groups.get(key).amount_cents += row.unallocated_cents;
  }
  return { cutoff, summary: [...groups.values()].sort((a, b) => a.ledger.localeCompare(b.ledger)),
    details: report.exceptions, unmatched_total_cents: report.unmatched.disbursement_cents + report.unmatched.expense_cents,
    unmatched_across_ledgers_double_counts_value: true };
}

export function trend(registers, ledger, years) {
  if (!Array.isArray(years) || !years.length || years.length > 50 || new Set(years).size !== years.length) {
    throw new Invalid('unique bounded fiscal years required');
  }
  const output = [];
  for (const year of years) {
    integer(year, 'year', 2000, 2100);
    const cutoff = year * 10000 + 1231;
    const result = reconcile(registers, ledger, { date_cutoff: cutoff });
    output.push({ year,
      disbursed_cents: result.totals.disbursed_cents,
      spent_cents: result.totals.spent_cents,
      matched_cents: result.totals.matched_cents,
      unmatched_disbursement_cents: result.unmatched.disbursement_cents,
      unmatched_expense_cents: result.unmatched.expense_cents });
  }
  return { rows: output, each_year_recomputed_at_its_own_date_cutoff: true };
}
