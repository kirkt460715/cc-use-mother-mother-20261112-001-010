import { fields, array, text, integer, money, Invalid } from '../ledger/values.js';

export function parseCSV(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 50000000) {
    throw new Invalid('bounded CSV content required');
  }
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        value += char;
      }
      continue;
    }
    if (afterQuote && ![',', '\n', '\r'].includes(char)) {
      throw new Invalid('unexpected character after CSV quote');
    }
    if (char === '"') {
      if (value) {
        throw new Invalid('quote in unquoted CSV field');
      }
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
      afterQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[index + 1] === '\n') {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      afterQuote = false;
    } else {
      value += char;
    }
    if (rows.length > 100001) {
      throw new Invalid('CSV row count exceeds limit');
    }
  }
  if (quoted) {
    throw new Invalid('unclosed CSV quote');
  }
  if (value || row.length || afterQuote) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

export function definition(specification, schemas) {
  fields(specification, ['version', 'table', 'columns', 'defaults', 'values']);
  if (specification.version !== 1 || !schemas[specification.table]) {
    throw new Invalid('unsupported mapping version or table');
  }
  if (!specification.columns || typeof specification.columns !== 'object' || Array.isArray(specification.columns) ||
      !specification.defaults || typeof specification.defaults !== 'object' || Array.isArray(specification.defaults) ||
      !specification.values || typeof specification.values !== 'object' || Array.isArray(specification.values)) {
    throw new Invalid('mapping records must be objects');
  }
  const targets = Object.keys(specification.columns);
  const defaults = Object.keys(specification.defaults);
  if (targets.some(key => defaults.includes(key)) || new Set(Object.values(specification.columns)).size !== targets.length) {
    throw new Invalid('mapping target overlap or source reuse');
  }
  const schema = schemas[specification.table];
  if (targets.length + defaults.length !== schema.length || schema.some(key => !targets.includes(key) && !defaults.includes(key))) {
    throw new Invalid('mapping must cover every output field once');
  }
  if (Object.keys(specification.values).some(key => !targets.includes(key))) {
    throw new Invalid('translation configured for unmapped field');
  }
  for (const value of Object.values(specification.columns)) {
    text(value, 'source column', 100);
  }
  for (const translations of Object.values(specification.values)) {
    if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
      throw new Invalid('bounded value translation object required');
    }
  }
  return specification;
}

function convert(value, target, translations) {
  if (translations && Object.hasOwn(translations, value)) {
    value = translations[value];
  } else if (translations) {
    throw new Invalid(`unmapped value for ${target}`);
  }
  if (target.endsWith('_cents')) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return integer(value, target, 0, Number.MAX_SAFE_INTEGER);
    }
    return money(value, target);
  }
  if (['date', 'fiscal_year', 'units', 'start', 'end'].some(name => target === name || target.endsWith('_' + name))) {
    if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
      value = Number(value);
    }
    return integer(value, target, 0, Number.MAX_SAFE_INTEGER);
  }
  if (typeof value !== 'string') {
    throw new Invalid(`${target} mapping requires text`);
  }
  return value;
}

export function translate(content, specification, schemas, strict = true) {
  definition(specification, schemas);
  const rows = parseCSV(content);
  const header = rows.shift();
  const sourceColumns = Object.values(specification.columns);
  if (!header || new Set(header).size !== header.length || sourceColumns.some(key => !header.includes(key))) {
    throw new Invalid('source columns missing or duplicated');
  }
  const extra = header.filter(key => !sourceColumns.includes(key));
  if (strict && extra.length) {
    throw new Invalid('unmapped source columns');
  }
  const accepted = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.length !== header.length) {
      rejected.push({ line: index + 2, error: 'record width mismatch' });
      continue;
    }
    const source = Object.fromEntries(header.map((key, offset) => [key, cells[offset]]));
    const target = { ...specification.defaults };
    try {
      for (const [output, input] of Object.entries(specification.columns)) {
        target[output] = convert(source[input], output, specification.values[output]);
      }
      accepted.push(target);
    } catch (error) {
      rejected.push({ line: index + 2, error: error.message });
    }
    if (accepted.length + rejected.length > 100000) {
      throw new Invalid('mapping record limit exceeded');
    }
  }
  return {
    table: specification.table,
    accepted,
    rejected,
    complete: rejected.length === 0,
    unmapped_columns: extra,
    importable: rejected.length === 0,
    no_partial_import: true
  };
}

export function requireComplete(translation) {
  if (!translation.complete || !translation.importable) {
    throw new Invalid('mapping errors prevent posting any rows');
  }
  array(translation.accepted, 'accepted rows', 100000);
  return translation.accepted;
}
