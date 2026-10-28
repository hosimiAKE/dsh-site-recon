// Workspace persistence: one directory per research question, plain JSON files,
// atomic writes, and stable human-readable ids (S01 / E01 / C01 / Q01).

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MARKER = 'recon.json';

export function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

/** A filesystem-safe, human-recognisable name for a question or URL. */
export function slugify(input, fallback = 'recon') {
  const ascii = String(input || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const digest = sha1(input).slice(0, 6);
  return `${ascii || fallback}-${digest}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  return writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function emptySources() {
  return { nextId: 1, items: [] };
}

export function emptyEvidence() {
  return { nextId: 1, items: [] };
}

export function emptyClaims() {
  return { nextId: 1, items: [] };
}

export function emptyArtifacts() {
  return { nextId: 1, items: [] };
}

/** `S01`, `E07`, ... with a prefix-specific counter. */
export function formatId(prefix, n) {
  return `${prefix}${String(n).padStart(2, '0')}`;
}

export function parseId(value, prefix) {
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(value || '').trim());
  return m ? Number(m[1]) : undefined;
}

export function paths(workspace) {
  return {
    workspace,
    brief: path.join(workspace, 'brief.json'),
    sources: path.join(workspace, 'sources.json'),
    evidence: path.join(workspace, 'evidence.json'),
    claims: path.join(workspace, 'claims.json'),
    artifacts: path.join(workspace, 'artifacts.json'),
    report: path.join(workspace, 'report.md'),
    pages: path.join(workspace, 'pages'),
    meta: path.join(workspace, 'meta'),
    captures: path.join(workspace, 'captures'),
    marker: path.join(workspace, MARKER),
  };
}

export async function isWorkspace(dir) {
  try {
    const marker = await readJson(path.join(dir, MARKER), null);
    return Boolean(marker && marker.version === 1);
  } catch {
    return false;
  }
}

/** Load every ledger for a workspace; read-only tools tolerate missing files. */
export async function loadState(workspace) {
  const p = paths(workspace);
  const [marker, brief, sources, evidence, claims, artifacts] = await Promise.all([
    readJson(p.marker, null),
    readJson(p.brief, null),
    readJson(p.sources, emptySources()),
    readJson(p.evidence, emptyEvidence()),
    readJson(p.claims, emptyClaims()),
    readJson(p.artifacts, emptyArtifacts()),
  ]);
  return {
    workspace,
    paths: p,
    marker,
    brief,
    sources: sources?.items ? sources : emptySources(),
    evidence: evidence?.items ? evidence : emptyEvidence(),
    claims: claims?.items ? claims : emptyClaims(),
    artifacts: artifacts?.items ? artifacts : emptyArtifacts(),
  };
}

export async function save(workspace, name, value) {
  const p = paths(workspace);
  if (!p[name]) throw new Error(`unknown ledger "${name}"`);
  return writeJson(p[name], value);
}

/**
 * Save a page snapshot plus its metadata, returning the relative paths used in
 * evidence records. Snapshot text is what quotes are verified against.
 */
export async function savePage(workspace, url, text, meta) {
  const p = paths(workspace);
  await ensureDir(p.pages);
  await ensureDir(p.meta);
  const host = (() => { try { return new URL(url).host; } catch { return 'page'; } })();
  const base = slugify(`${host}-${new URL(url).pathname}`, 'page');
  const file = `${base}.txt`;
  const header = [
    `URL: ${url}`,
    `TITLE: ${meta?.title || ''}`,
    `FETCHED: ${new Date().toISOString()}`,
    `STATUS: ${meta?.status ?? 'n/a'}`,
    '',
    text,
  ].join('\n');
  await writeAtomic(path.join(p.pages, file), header);
  await writeJson(path.join(p.meta, `${base}.json`), { url, ...meta, snapshot: file });
  return { snapshot: path.join('pages', file), metaFile: path.join('meta', `${base}.json`), base };
}

export async function readSnapshot(workspace, relative) {
  return fs.readFile(path.join(workspace, relative), 'utf8');
}

export async function listDir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
