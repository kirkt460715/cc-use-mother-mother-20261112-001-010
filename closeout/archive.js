import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { Registers } from '../ledger/registers.js';
import { MatchLedger } from '../matching/ledger.js';
import { verifyCloseout, buildCloseout } from './periods.js';
import { digest, canonical, load, Invalid } from '../ledger/values.js';

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildContents(registers, matches, report) {
  verifyCloseout(registers, matches, report, true);
  const files = {
    'registers.json': canonical(registers.document),
    'matches.json': canonical(matches.document),
    'closeout.json': canonical(report),
    'projects.csv': csv(report.portfolio.projects),
    'counties.csv': csv(report.portfolio.counties),
    'exceptions.csv': csv(report.exceptions.rows)
  };
  const manifest = { version: 1, period: report.period, register_digest: registers.fingerprint,
    match_digest: matches.fingerprint, closeout_digest: report.closeout_digest,
    access: 'restricted_source_ledger_detail',
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])) };
  return { ...files, 'manifest.json': canonical(manifest) };
}

export function csv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]).sort();
  const cell = value => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? canonical(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text;
  };
  return [columns.map(key => cell(key)).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\n') + '\n';
}

export function exportArchive(registers, matches, report, destination) {
  if (existsSync(destination)) throw new Invalid('archive destination exists');
  const files = buildContents(registers, matches, report);
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), '.investment-archive-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(stage, name), body, { flag: 'wx' });
    inspectArchive(stage);
    renameSync(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return inspectArchive(destination);
}

export function inspectArchive(directory) {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Invalid('regular archive directory required');
  const manifest = load(join(directory, 'manifest.json'));
  if (manifest.version !== 1 || typeof manifest.files !== 'object') throw new Invalid('invalid archive manifest');
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...Object.keys(manifest.files), 'manifest.json'].sort())) {
    throw new Invalid('archive file set mismatch');
  }
  for (const [name, signature] of Object.entries(manifest.files)) {
    if (basename(name) !== name || name === '.' || name === '..') throw new Invalid('archive path traversal');
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000000) throw new Invalid('invalid archive file');
    if (sha(readFileSync(path)) !== signature) throw new Invalid('archive file checksum mismatch');
  }
  const registers = new Registers(load(join(directory, 'registers.json')));
  const matches = new MatchLedger(load(join(directory, 'matches.json')));
  const report = load(join(directory, 'closeout.json'));
  const expected = buildContents(registers, matches, report);
  for (const [name, content] of Object.entries(expected)) {
    if (readFileSync(join(directory, name), 'utf8') !== content) throw new Invalid('archive semantic replay mismatch');
  }
  return { valid: true, files: Object.keys(expected).length, closeout_digest: report.closeout_digest };
}
