import { fields, array, id, integer, digest, Conflict, Invalid } from '../ledger/values.js';

function compareWeight(left, right) {
  const first = BigInt(left.numerator) * BigInt(right.denominator);
  const second = BigInt(right.numerator) * BigInt(left.denominator);
  return first < second ? -1 : first > second ? 1 : 0;
}

export function rational(value, name = 'weight') {
  fields(value, ['numerator', 'denominator']);
  integer(value.numerator, `${name}.numerator`, 0, Number.MAX_SAFE_INTEGER);
  integer(value.denominator, `${name}.denominator`, 1, Number.MAX_SAFE_INTEGER);
  if (value.numerator === 0) {
    throw new Invalid(`${name} must be positive`);
  }
  return value;
}

export function proportional(total, weights) {
  integer(total, 'allocation total', 0, Number.MAX_SAFE_INTEGER);
  array(weights, 'weights', 10000);
  if (!weights.length) {
    if (total === 0) {
      return [];
    }
    throw new Invalid('positive total requires recipients');
  }
  const normalized = weights.map(row => {
    fields(row, ['id', 'weight']);
    id(row.id, 'recipient');
    const weight = rational(row.weight);
    return { id: row.id, numerator: BigInt(weight.numerator), denominator: BigInt(weight.denominator) };
  });
  if (new Set(normalized.map(row => row.id)).size !== normalized.length) {
    throw new Invalid('duplicate allocation recipient');
  }
  const denominator = normalized.reduce((value, row) => value / gcdBig(value, row.denominator) * row.denominator, 1n);
  const scaled = normalized.map(row => ({ ...row, weight: row.numerator * (denominator / row.denominator) }));
  const sum = scaled.reduce((acc, row) => acc + row.weight, 0n);
  const shares = scaled.map(row => {
    const numerator = BigInt(total) * row.weight;
    const base = numerator / sum;
    const remainder = numerator % sum;
    return { id: row.id, amount_cents: Number(base), remainder, denominator: sum };
  });
  let left = total - shares.reduce((acc, row) => acc + row.amount_cents, 0);
  const order = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
  for (let index = 0; left > 0; index += 1, left -= 1) {
    order[index % order.length].amount_cents += 1;
  }
  const output = shares.map(({ id: recipient, amount_cents }) => ({ id: recipient, amount_cents }));
  if (output.reduce((acc, row) => acc + row.amount_cents, 0) !== total) {
    throw new Invalid('allocation remainder did not conserve total');
  }
  return output.sort((a, b) => a.id.localeCompare(b.id));
}

function gcdBig(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a || 1n;
}

export function validateAmountSources(amount, candidates) {
  integer(amount, 'match amount', 1, Number.MAX_SAFE_INTEGER);
  array(candidates, 'candidates', 10000);
  let available = 0;
  for (const row of candidates) {
    fields(row, ['id', 'available_cents']);
    id(row.id);
    integer(row.available_cents, 'available', 0, Number.MAX_SAFE_INTEGER);
    available += row.available_cents;
    if (!Number.isSafeInteger(available)) {
      throw new Invalid('candidate balances exceed safe integer cents');
    }
  }
  if (available < amount) {
    throw new Conflict('candidate balances do not cover requested match');
  }
  return { available_cents: available, requested_cents: amount, excess_cents: available - amount };
}

export function automaticMatch(amount, candidates, exactLimit = 25) {
  validateAmountSources(amount, candidates);
  integer(exactLimit, 'exact limit', 1, 100);
  if (candidates.length > exactLimit) {
    throw new Invalid('automatic matching candidate limit exceeded');
  }
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  let best = null;
  const chosen = [];
  function visit(index, sum) {
    if (sum >= amount) {
      const excess = sum - amount;
      const ids = chosen.map(row => row.id).sort();
      if (!best || excess < best.excess_cents || (excess === best.excess_cents && ids.join('\0') < best.ids.join('\0'))) {
        best = { excess_cents: excess, ids };
      }
      return;
    }
    if (index >= ordered.length || (best && sum > amount + best.excess_cents)) {
      return;
    }
    chosen.push(ordered[index]);
    visit(index + 1, sum + ordered[index].available_cents);
    chosen.pop();
    visit(index + 1, sum);
  }
  visit(0, 0);
  if (!best) {
    throw new Conflict('no exact candidate subset covers requested amount');
  }
  return {
    selected: best.ids,
    excess_cents: best.excess_cents,
    method: 'exact_bounded_subset_search',
    search_limit: exactLimit,
    candidate_digest: digest(ordered)
  };
}

export function planMatch(sourceType, sourceId, targetType, targetId, amount, beforeBalances, afterBalances) {
  if (!['disbursement', 'expense'].includes(sourceType) || !['disbursement', 'expense'].includes(targetType)) {
    throw new Invalid('unsupported match ledger type');
  }
  id(sourceId, 'source');
  id(targetId, 'target');
  integer(amount, 'amount', 1, Number.MAX_SAFE_INTEGER);
  const left = new Map(beforeBalances.map(row => [row.id, row.available_cents]));
  const right = new Map(afterBalances.map(row => [row.id, row.available_cents]));
  if (!left.has(sourceId) || !right.has(targetId) || left.get(sourceId) < amount || right.get(targetId) < amount) {
    throw new Conflict('match exceeds source or target unmatched balance');
  }
  return {
    source: { ledger: sourceType, id: sourceId, amount_cents: amount },
    target: { ledger: targetType, id: targetId, amount_cents: amount },
    before_source_available: left.get(sourceId),
    after_source_available: left.get(sourceId) - amount,
    before_target_available: right.get(targetId),
    after_target_available: right.get(targetId) - amount,
    source_conserved: left.get(sourceId) === amount + left.get(sourceId) - amount,
    target_conserved: right.get(targetId) === amount + right.get(targetId) - amount
  };
}
