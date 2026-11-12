import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';

export class Invalid extends Error {
  constructor(message) {
    super(message);
    this.name = 'Invalid';
  }
}

export class Conflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'Conflict';
  }
}

export function integer(value, name, min = 0, max = 1000000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Invalid(`${name} integer outside ${min}..${max}`);
  }
  return value;
}

export function text(value, name, maximum = 200) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\x00-\x1f]/.test(value)) {
    throw new Invalid(`${name} bounded text required`);
  }
  return value;
}

export function id(value, name = 'id') {
  text(value, name, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) {
    throw new Invalid(`${name} invalid identity`);
  }
  return value;
}

export function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Invalid('object required');
  }
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key));
  if (missing.length || extra.length) {
    throw new Invalid(`fields mismatch: ${missing.concat(extra).join(',')}`);
  }
  return value;
}

export function array(value, name, maximum = 100000) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Invalid(`${name} bounded array required`);
  }
  return value;
}

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Invalid('nonfinite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Invalid('unsupported canonical value');
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function clone(value) {
  return JSON.parse(canonical(value));
}

export function money(value, name = 'amount') {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) {
    throw new Invalid(`${name} must be canonical nonnegative decimal with two places`);
  }
  const [whole, fraction] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  return integer(cents, name, 0, Number.MAX_SAFE_INTEGER);
}

export function dollars(cents) {
  integer(cents, 'cents', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const sign = cents < 0 ? '-' : '';
  const amount = Math.abs(cents);
  return `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

export function add(...values) {
  return integer(values.reduce((sum, value) => sum + integer(value, 'cents', 0, Number.MAX_SAFE_INTEGER), 0), 'sum', 0, Number.MAX_SAFE_INTEGER);
}

export function load(path, maximum = 50000000) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw new Invalid('bounded regular input file required');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function index(rows, name) {
  const result = new Map();
  for (const row of rows) {
    id(row.id, `${name}.id`);
    if (result.has(row.id)) {
      throw new Invalid(`duplicate ${name} ${row.id}`);
    }
    result.set(row.id, row);
  }
  return result;
}

export function gcd(left, right) {
  let a = Math.abs(integer(left, 'left', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
  let b = Math.abs(integer(right, 'right', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function ratio(numerator, denominator) {
  integer(numerator, 'numerator', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  integer(denominator, 'denominator', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (denominator === 0) {
    return null;
  }
  const divisor = gcd(numerator, denominator) || 1;
  const sign = denominator < 0 ? -1 : 1;
  return { numerator: numerator / divisor * sign, denominator: Math.abs(denominator) / divisor };
}
