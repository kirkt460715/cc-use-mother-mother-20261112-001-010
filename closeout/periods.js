import { fields, integer, id, digest, Invalid, Conflict } from '../ledger/values.js';
import { reconcile, verifyReconciliation } from '../matching/reconcile.js';
import { validateCashConservation } from '../ledger/events.js';
import { dashboard, exceptions, validatePortfolio } from '../portfolio/indicators.js';

export function buildCloseout(registers, matches, period, options = {}) {
  id(period, 'period');
  const cutoff = options.date_cutoff ?? 21001231;
  integer(cutoff, 'date cutoff', 20000101, 21001231);
  const reconciliation = reconcile(registers, matches, { date_cutoff: cutoff });
  verifyReconciliation(registers, matches, reconciliation, true);
  const cash = validateCashConservation(registers);
  const portfolio = dashboard(registers, matches, cutoff);
  const portfolioAudit = validatePortfolio(registers, matches, portfolio);
  const exceptionReport = exceptions(registers, matches, cutoff);
  const body = { version: 1, period, cutoff, register_digest: registers.fingerprint,
    match_digest: matches.fingerprint, reconciliation, cash_audit: cash,
    portfolio, portfolio_audit: portfolioAudit, exceptions: exceptionReport,
    frozen_source_versions: true,
    limitation: 'reported outputs reconcile records and do not certify service quality or causality' };
  return { ...body, closeout_digest: digest(body) };
}

export function verifyCloseout(registers, matches, report, replay = false) {
  const { closeout_digest, ...body } = report;
  if (digest(body) !== closeout_digest || body.version !== 1) {
    throw new Invalid('closeout checksum mismatch');
  }
  if (body.register_digest !== registers.fingerprint || body.match_digest !== matches.fingerprint) {
    throw new Invalid('closeout source digest mismatch');
  }
  verifyReconciliation(registers, matches, body.reconciliation, replay);
  if (replay && buildCloseout(registers, matches, body.period, { date_cutoff: body.cutoff }).closeout_digest !== closeout_digest) {
    throw new Invalid('closeout semantic replay mismatch');
  }
  return { valid: true, period: body.period, exceptions: body.exceptions.rows.length,
    projects: body.portfolio.projects.length };
}

export function revisionImpact(oldReport, newReport) {
  if (oldReport.period !== newReport.period) {
    throw new Invalid('revision must preserve closeout period');
  }
  if (newReport.cutoff < oldReport.cutoff) {
    throw new Invalid('revision cutoff cannot move backwards');
  }
  const projects = new Map(newReport.portfolio.projects.map(row => [row.project, row]));
  const previous = new Map(oldReport.portfolio.projects.map(row => [row.project, row]));
  const changes = [];
  for (const key of [...new Set([...projects.keys(), ...previous.keys()])].sort()) {
    if (digest(projects.get(key) ?? null) !== digest(previous.get(key) ?? null)) {
      changes.push({ project: key, before: previous.get(key) ?? null, after: projects.get(key) ?? null });
    }
  }
  return { prior_closeout_digest: oldReport.closeout_digest,
    revised_closeout_digest: newReport.closeout_digest, changed_projects: changes,
    previous_closeout_preserved: true, effects_recomputed_from_full_source: true };
}
