import { digest, fields, id, integer, money, Invalid } from '../ledger/values.js';
import { validateImportPreview } from './operations.js';

const AMOUNT_FIELDS = new Set(['amount', 'authorized']);

function issue(code, severity, count, detail) {
  return { code, severity, count, detail };
}

function boundedPolicy(policy) {
  fields(policy, [], ['max_rejected_basis_points', 'max_changed_rows', 'max_deletions', 'allow_empty']);
  const maxRejected = policy.max_rejected_basis_points ?? 0;
  const maxChanged = policy.max_changed_rows ?? 10000;
  const maxDeletions = policy.max_deletions ?? 0;
  const allowEmpty = policy.allow_empty ?? false;
  integer(maxRejected, 'max rejected basis points', 0, 10000);
  integer(maxChanged, 'maximum changed rows', 1, 100000);
  integer(maxDeletions, 'maximum deletions', 0, 100000);
  if (typeof allowEmpty !== 'boolean') {
    throw new Invalid('allow_empty must be boolean');
  }
  return { max_rejected_basis_points: maxRejected, max_changed_rows: maxChanged,
    max_deletions: maxDeletions, allow_empty: allowEmpty };
}

export function assessTranslation(translation, policy = {}) {
  fields(translation, ['table', 'accepted', 'rejected', 'complete', 'unmapped_columns']);
  if (typeof translation.table !== 'string' || !Array.isArray(translation.accepted)
      || !Array.isArray(translation.rejected) || !Array.isArray(translation.unmapped_columns)
      || typeof translation.complete !== 'boolean') {
    throw new Invalid('translation result shape invalid');
  }
  const rules = boundedPolicy(policy);
  const total = translation.accepted.length + translation.rejected.length;
  const rejectedBasisPoints = total === 0 ? 0 : Math.ceil(translation.rejected.length * 10000 / total);
  const identities = new Map();
  for (const row of translation.accepted) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Invalid('accepted import row must be an object');
    }
    id(row.id, 'import row identity');
    identities.set(row.id, (identities.get(row.id) ?? 0) + 1);
  }
  const duplicates = [...identities].filter(([, count]) => count > 1)
    .map(([identity, count]) => ({ identity, count })).sort((a, b) => a.identity.localeCompare(b.identity));
  const findings = [];
  if (!total && !rules.allow_empty) {
    findings.push(issue('EMPTY_IMPORT', 'warning', 1, 'no source rows were supplied'));
  }
  if (translation.rejected.length) {
    findings.push(issue('ROWS_REJECTED', rejectedBasisPoints > rules.max_rejected_basis_points ? 'critical' : 'warning',
      translation.rejected.length, 'one or more source rows could not be translated'));
  }
  if (translation.unmapped_columns.length) {
    findings.push(issue('UNMAPPED_COLUMNS', 'critical', translation.unmapped_columns.length,
      'source columns have no registered field mapping'));
  }
  if (duplicates.length) {
    findings.push(issue('DUPLICATE_IDENTITIES', 'critical', duplicates.length,
      'accepted rows repeat a business identity'));
  }
  findings.sort((a, b) => a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code));
  const ready = rejectedBasisPoints <= rules.max_rejected_basis_points
    && translation.unmapped_columns.length === 0 && duplicates.length === 0
    && (total > 0 || rules.allow_empty);
  const body = { table: translation.table, row_count: total, accepted_rows: translation.accepted.length,
    rejected_rows: translation.rejected.length, rejected_basis_points: rejectedBasisPoints,
    unmapped_columns: [...translation.unmapped_columns].sort(), duplicate_identities: duplicates,
    policy: rules, findings, ready_for_preview: ready };
  return { ...body, digest: digest(body) };
}

function rowAmount(row) {
  let sum = 0;
  for (const [key, value] of Object.entries(row ?? {})) {
    if (AMOUNT_FIELDS.has(key)) {
      sum += money(value, key);
      if (!Number.isSafeInteger(sum)) {
        throw new Invalid('import amount delta exceeds safe integer');
      }
    }
  }
  return sum;
}

export function auditImportPreview(registers, operations, policy = {}) {
  const rules = boundedPolicy(policy);
  const preview = validateImportPreview(registers, operations);
  const groups = new Map();
  let deletions = 0;
  let beforeAmountCents = 0;
  let afterAmountCents = 0;
  const changed = [];
  for (const entity of preview.changed_entities) {
    const kind = entity.before === null ? 'added' : entity.after === null ? 'deleted' : 'revised';
    if (kind === 'deleted') {
      deletions += 1;
    }
    const key = `${entity.table}:${kind}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
    beforeAmountCents += rowAmount(entity.before);
    afterAmountCents += rowAmount(entity.after);
    changed.push({ table: entity.table, id: entity.id, kind,
      before_digest: entity.before === null ? null : digest(entity.before),
      after_digest: entity.after === null ? null : digest(entity.after) });
  }
  changed.sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
  const findings = [];
  if (changed.length > rules.max_changed_rows) {
    findings.push(issue('CHANGE_VOLUME_EXCEEDED', 'critical', changed.length,
      'preview changes more rows than the review policy permits'));
  }
  if (deletions > rules.max_deletions) {
    findings.push(issue('DELETION_LIMIT_EXCEEDED', 'critical', deletions,
      'preview deletes more rows than the review policy permits'));
  }
  if (beforeAmountCents !== afterAmountCents) {
    findings.push(issue('REGISTERED_AMOUNT_DELTA', 'warning', 1,
      'proposed changes alter the sum of explicit amount fields'));
  }
  const body = { before_digest: preview.before_digest, after_digest: preview.after_digest,
    changed_count: changed.length, by_table_and_change: Object.fromEntries([...groups].sort()),
    deletion_count: deletions, before_amount_cents: beforeAmountCents,
    after_amount_cents: afterAmountCents, amount_delta_cents: afterAmountCents - beforeAmountCents,
    policy: rules, findings, requires_human_review: true,
    review_permitted: findings.every(row => row.severity !== 'critical'), changed };
  return { ...body, digest: digest(body) };
}
