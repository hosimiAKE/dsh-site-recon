// The recon tool suite. Every tool reads and writes the same workspace ledgers,
// so breadth, depth, and evidence stay one state instead of three opinions.

import fs from 'node:fs/promises';
import path from 'node:path';

import { captureSection, probeBrowser } from './capture.js';
import { classifyPage, extractPage, normSpace } from './html.js';
import {
  DEFAULT_ROLES, DEPTH_RUNGS, LEVEL_BY_KEY, LEVELS, ROLE_BY_KEY, ROLE_KEYS,
  RUNG_KEYS, SOURCE_ROLES, SUBQUESTION_SEEDS, claimStatus, clip, coverage,
  gaps, levelMix, probeScore, table,
} from './model.js';
import { normalizeUrl, politeFetch, searchMany, sameSite } from './net.js';
import {
  emptyClaims, emptyEvidence, emptySources, ensureDir, formatId, loadState,
  paths as pathsOf, readJson, readSnapshot, save, savePage, slugify, writeAtomic,
  writeJson,
} from './store.js';

const VERSION = 1;

const textBlock = (text) => [{ type: 'text', text: String(text ?? '') }];

const output = (extra = {}) => ({
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, ...extra },
    required: ['text'],
    additionalProperties: true,
  },
  render: (_args, value) => textBlock(value?.text ?? JSON.stringify(value)),
});

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function fail(message) {
  throw new Error(message);
}

async function baseCwd(ctx, exec) {
  const workingDirectory = ctx.get?.('workingDirectory');
  if (workingDirectory?.ensure && exec?.agent) {
    try { return await workingDirectory.ensure(exec.agent); } catch { /* fall through */ }
  }
  return process.cwd();
}

async function resolveWorkspace(ctx, exec, given) {
  if (!given) fail('workspace is required: pass the directory returned by recon_init');
  const cwd = await baseCwd(ctx, exec);
  const dir = path.isAbsolute(given) ? given : path.resolve(cwd, given);
  const marker = await readJson(path.join(dir, 'recon.json'), null);
  if (!marker || marker.version !== VERSION) {
    fail(`not a recon workspace: ${dir} (no recon.json). Run recon_init first.`);
  }
  return dir;
}

/** Which source role a URL probably fills. Only a default: the model can override. */
export function guessRole(url) {
  const u = String(url).toLowerCase();
  if (/\/docs?\/|documentation|\/reference\/|developer\.|learn\.|help\.|support\./.test(u)) return 'docs';
  if (/\/pricing|\/plans|\/buy\b/.test(u)) return 'pricing';
  if (/changelog|release-notes|\/releases?\/|\/whats-new/.test(u)) return 'release';
  if (/\/blog\/|engineering\.|\.dev\/blog/.test(u)) return 'engineering';
  if (/github\.com|gitlab\.com|stackoverflow|reddit|news\.ycombinator|discourse|forum|community\./.test(u)) return 'community';
  if (/wikipedia|gartner|forrester|mckinsey|techcrunch|theverge|arstechnica|infoq|thenewstack|cncf\.io/.test(u)) return 'thirdparty';
  if (/\/customers?\/|case-stud|\/stories\//.test(u)) return 'customer';
  if (/sec\.gov|\.gov\b|iso\.org|nist\.gov|eur-lex|gdpr/.test(u)) return 'regulatory';
  if (/\/compare|\/vs\/|alternative/.test(u)) return 'competitor';
  if (/statista|benchmark|\/report\//.test(u)) return 'data';
  return 'primary';
}

function upsertSource(state, { url, title, role, status, via, snapshot }) {
  const normalized = normalizeUrl(url);
  const existing = state.sources.items.find((s) => normalizeUrl(s.url) === normalized);
  if (existing) {
    existing.title = title || existing.title;
    existing.role = role || existing.role;
    existing.status = status || existing.status;
    existing.via = existing.via || via;
    existing.snapshot = snapshot || existing.snapshot;
    existing.fetches = (existing.fetches || 0) + (status === 'fetched' ? 1 : 0);
    existing.lastSeenAt = new Date().toISOString();
    return existing;
  }
  const item = {
    id: formatId('S', state.sources.nextId),
    url,
    title: title || '',
    role: role || guessRole(url),
    status: status || 'seen',
    via: via || 'search',
    snapshot: snapshot || null,
    fetches: status === 'fetched' ? 1 : 0,
    seenAt: new Date().toISOString(),
  };
  state.sources.nextId += 1;
  state.sources.items.push(item);
  return item;
}

function findSource(state, url) {
  const normalized = normalizeUrl(url);
  return state.sources.items.find((s) => normalizeUrl(s.url) === normalized)
    || state.sources.items.find((s) => s.snapshot && normalizeUrl(s.url) === normalized);
}

function detectLang(question) {
  return /[\u3400-\u9fff]/.test(String(question || '')) ? 'zh' : 'en';
}

function outlineLines(outline, limit = 40) {
  return outline.slice(0, limit).map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`).join('\n');
}

function bulletList(items, marker = '-') {
  return items.filter(Boolean).map((item) => `${marker} ${item}`).join('\n');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function createTools(ctx, config = {}) {
  const defaults = {
    minIntervalMs: Number(config.minIntervalMs ?? 1200),
    maxPages: Number(config.maxPages ?? 8),
    maxChars: Number(config.maxChars ?? 6000),
  };

  const web = () => ctx.get?.('web');

  return [
    // ---------------------------------------------------------------- init
    {
      name: 'recon_init',
      description:
        'Open a research workspace for a question. Writes a brief that fixes what wide and deep mean for this question — the source roles to cover, the sub-questions to answer, the page and search budget — then returns the plan and the first actions. Call once per question, before any other recon tool.',
      parameters: schema(
        {
          question: {
            type: 'string',
            description: 'The research question in the asker\'s own words. Stored verbatim and replayed in the report, so paraphrase nothing.',
          },
          goal: {
            type: 'string',
            description: 'What the answer will be used for. A decision needs different sources from a survey.',
          },
          audience: {
            type: 'string',
            description: 'Who reads the report. Shapes the implications section only.',
          },
          dir: {
            type: 'string',
            description: 'Parent directory for the workspace, resolved against the working directory. Defaults to `recon`.',
          },
          roles: {
            type: 'array',
            description:
              'Source roles to cover. Omit for the eight defaults, which suit technical-product questions. Pass an explicit subset for medicine, law, or markets, where regulatory and data sources outweigh community ones.',
            items: { type: 'string', enum: ROLE_KEYS },
          },
          budget: {
            type: 'object',
            description: 'Ceiling for this recon; recorded in the brief and reported by recon_gaps.',
            properties: { pages: { type: 'number' }, searches: { type: 'number' } },
            additionalProperties: false,
          },
        },
        ['question'],
      ),
      output: output({ workspace: { type: 'string' } }),
      async execute(args, exec) {
        const cwd = await baseCwd(ctx, exec);
        const parent = args.dir ? path.resolve(cwd, args.dir) : path.join(cwd, 'recon');
        const workspace = path.join(parent, slugify(args.question));
        const existing = await readJson(path.join(workspace, 'brief.json'), null);
        if (existing) {
          const before = await loadState(workspace);
          const cov = coverage(before.brief, before.sources.items);
          return {
            text: [
              `Workspace already exists: ${workspace}`,
              '',
              `Question: ${before.brief.question}`,
              `Coverage: ${cov.covered}/${cov.total} source roles · ${before.evidence.items.length} evidence · ${before.claims.items.length} claims`,
              '',
              'Continue with recon_search or recon_fetch. Call recon_gaps to see what is missing.',
            ].join('\n'),
            workspace,
          };
        }

        const roles = (args.roles && args.roles.length ? args.roles : DEFAULT_ROLES).filter((r) => ROLE_KEYS.includes(r));
        const brief = {
          version: VERSION,
          question: args.question,
          goal: args.goal || '',
          audience: args.audience || '',
          lang: detectLang(args.question),
          createdAt: new Date().toISOString(),
          breadth: { roles, levels: LEVELS.map((l) => l.key), minPerRole: 1 },
          depth: { rungs: RUNG_KEYS },
          subquestions: SUBQUESTION_SEEDS.map((seed, index) => ({
            id: formatId('Q', index + 1),
            key: seed.key,
            text: `${seed.ask}\n  → 关于「${clip(args.question, 90)}」`,
            status: 'open',
          })),
          budget: {
            pages: Number(args.budget?.pages ?? 20),
            searches: Number(args.budget?.searches ?? 8),
          },
          counters: { fetches: 0, searches: 0 },
        };

        await ensureDir(workspace);
        await ensureDir(path.join(workspace, 'pages'));
        await ensureDir(path.join(workspace, 'meta'));
        await ensureDir(path.join(workspace, 'captures'));
        await writeJson(path.join(workspace, 'recon.json'), {
          version: VERSION, question: args.question, createdAt: brief.createdAt,
        });
        await writeJson(path.join(workspace, 'brief.json'), brief);
        await save(workspace, 'sources', emptySources());
        await save(workspace, 'evidence', emptyEvidence());
        await save(workspace, 'claims', emptyClaims());
        await save(workspace, 'artifacts', { nextId: 1, items: [] });

        const roleRows = roles.map((key) => {
          const role = ROLE_BY_KEY.get(key);
          return [role.label, role.hint, '0'];
        });

        return {
          text: [
            `Workspace: ${workspace}`,
            '',
            `Question: ${brief.question}`,
            brief.goal ? `Goal: ${brief.goal}` : '',
            `Budget: ${brief.budget.pages} pages · ${brief.budget.searches} searches`,
            '',
            '## Breadth — source roles to cover',
            table(['角色', '要找什么', '已有'], roleRows),
            '',
            '## Depth — sub-questions to answer',
            bulletList(brief.subquestions.map((q) => `${q.id} ${q.text.replace(/\n\s*→ /, ' — ')}`)),
            '',
            '## Depth — the eight rungs applied to every claim',
            bulletList(DEPTH_RUNGS.map((r) => `${r.label} (${r.key})`)),
            '',
            '## First actions',
            bulletList([
              'recon_search with 2–4 queries aimed at the roles you know least about.',
              'recon_fetch the single most authoritative page and read it fully before searching again.',
              'recon_evidence the first verbatim sentence that answers Q01 — the ledger, not your notes, is the report\'s source.',
              'recon_claim each assertion as you form it, then recon_probe it.',
            ]),
          ].filter(Boolean).join('\n'),
          workspace,
        };
      },
    },

    // -------------------------------------------------------------- search
    {
      name: 'recon_search',
      description:
        'Sweep for candidate sources. Runs each query, registers every new URL with the role it fills and the evidence level its publisher implies, and returns what is new plus the roles still empty. Registers candidates only — read a page with recon_fetch before citing it.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory returned by recon_init.' },
          queries: {
            type: 'array',
            description: 'Two to four differently-angled queries beat one long query. Angle them at the empty source roles.',
            items: { type: 'string' },
          },
          role: {
            type: 'string',
            enum: ROLE_KEYS,
            description: 'Assign every hit this role. Omit to let each URL keep its guessed role.',
          },
          maxResults: { type: 'number', description: 'Results per query. Defaults to 8.' },
        },
        ['workspace', 'queries'],
      ),
      output: output({ found: { type: 'number' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const queries = (args.queries || []).filter(Boolean).slice(0, 6);
        if (!queries.length) fail('queries is empty: give at least one search query');

        const { sources, answers, failures } = await searchMany(web(), queries, {
          maxResults: Number(args.maxResults ?? 8),
          signal: exec?.signal,
        });

        const fresh = [];
        for (const source of sources) {
          const before = state.sources.items.length;
          const item = upsertSource(state, {
            url: source.url,
            title: source.title,
            role: args.role || guessRole(source.url),
            status: 'seen',
            via: 'search',
          });
          if (state.sources.items.length > before || item.status === 'seen') fresh.push(item);
        }
        state.brief.counters.searches += queries.length;
        await save(workspace, 'sources', state.sources);
        await writeJson(path.join(workspace, 'brief.json'), state.brief);

        const cov = coverage(state.brief, state.sources.items);
        const empty = cov.rows.filter((r) => !r.covered);
        const newOnes = [...new Map(fresh.map((f) => [f.id, f])).values()];

        return {
          text: [
            `Searched ${queries.length} queries · ${newOnes.length} new candidates · coverage ${cov.covered}/${cov.total}`,
            '',
            '## New candidates',
            newOnes.length
              ? table(['ID', '角色', '标题', 'URL'], newOnes.slice(0, 20).map((s) => [s.id, s.role, clip(s.title || '—', 50), clip(s.url, 80)]))
              : '(nothing new)',
            newOnes.length > 20 ? `…and ${newOnes.length - 20} more in sources.json` : '',
            '',
            '## Still empty',
            empty.length ? bulletList(empty.map((r) => `${r.label} — ${r.hint}`)) : 'every role has at least one source',
            answers.length ? `\n## Provider summaries\n${answers.map((a) => `> ${clip(a.text, 400)}`).join('\n>\n')}` : '',
            failures.length ? `\n## Failed queries\n${bulletList(failures.map((f) => `${f.query}: ${f.error}`))}` : '',
            '',
            'Candidates are registered, not read. recon_fetch the ones that matter; a search snippet is hearsay until the page is in the snapshot.',
          ].filter(Boolean).join('\n'),
          found: newOnes.length,
        };
      },
    },

    // --------------------------------------------------------------- fetch
    {
      name: 'recon_fetch',
      description:
        'Read one page and save it. Fetches once, stores the text snapshot that later quotes must come from, registers the URL as a source, and returns title, heading outline, opening sections and same-site links. Reports plainly when a page was blocked or is client-rendered instead of returning an empty shell.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          url: { type: 'string', description: 'Page to read.' },
          role: {
            type: 'string',
            enum: ROLE_KEYS,
            description: 'Source role to file it under. Omit to keep the guessed role.',
          },
          purpose: {
            type: 'string',
            description: 'Which sub-question this page is meant to answer. Recorded in the source list so later readers know why it was fetched.',
          },
          chars: {
            type: 'number',
            description: 'Characters of body text to return. Defaults to 6000; the full text stays in the snapshot.',
          },
        },
        ['workspace', 'url'],
      ),
      output: output({ status: { type: 'number' }, snapshot: { type: 'string' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const requested = args.url;

        const response = await politeFetch(web(), requested, {
          minIntervalMs: defaults.minIntervalMs,
          signal: exec?.signal,
        });
        const page = extractPage(response.body, response.finalUrl);
        page.stats.links = page.links.length;
        const verdict = classifyPage({
          status: response.status,
          title: page.title,
          text: page.text,
          htmlBytes: page.stats.htmlBytes,
          requestedUrl: requested,
          finalUrl: response.finalUrl,
        });

        const status = verdict.blocked ? 'blocked' : 'fetched';
        const saved = await savePage(workspace, response.finalUrl || requested, page.text, {
          status: response.status,
          title: page.title,
          description: page.description,
          outline: page.outline,
          via: response.via,
          blocked: verdict.blocked,
          likelyJs: verdict.likelyJs,
          requestedUrl: requested,
        });

        const source = upsertSource(state, {
          url: response.finalUrl || requested,
          title: page.title,
          role: args.role,
          status,
          via: 'fetch',
          snapshot: saved.snapshot,
        });
        if (args.purpose) source.purpose = args.purpose;
        if (verdict.likelyJs) source.likelyJs = true;
        state.brief.counters.fetches += 1;
        await save(workspace, 'sources', state.sources);
        await writeJson(path.join(workspace, 'brief.json'), state.brief);

        const limit = Number(args.chars ?? defaults.maxChars);
        const body = page.text.length > limit ? `${page.text.slice(0, limit)}\n…[${page.text.length - limit} more characters in the snapshot]` : page.text;
        const internal = page.links.filter((l) => l.sameOrigin).slice(0, 18);
        const external = page.links.filter((l) => l.external).slice(0, 8);

        return {
          status: response.status,
          snapshot: saved.snapshot,
          text: [
            `## ${page.title || '(untitled)'}`,
            `${source.id} · ${response.status} · role=${source.role} · ${verdict.blocked ? 'BLOCKED' : saved.snapshot}`,
            page.description ? `\n> ${clip(page.description, 300)}` : '',
            verdict.reasons.length ? `\nNotes: ${verdict.reasons.join('; ')}` : '',
            verdict.blocked
              ? '\nThis is a wall, not the page. Try recon_capture (rendered browser) or a different source for this role; do not cite what was saved.'
              : '',
            verdict.likelyJs
              ? '\nText is thin for this document size: the content is probably rendered by JavaScript. Use recon_capture to see what a visitor sees.'
              : '',
            page.outline.length ? `\n### Outline\n${outlineLines(page.outline)}` : '',
            `\n### Text\n${body}`,
            internal.length ? `\n### Same-site links (${page.links.filter((l) => l.sameOrigin).length})\n${bulletList(internal.map((l) => `[${clip(l.text, 60)}](${l.href})`))}` : '',
            external.length ? `\n### Elsewhere\n${bulletList(external.map((l) => `[${clip(l.text, 50)}](${l.href})`))}` : '',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // ----------------------------------------------------------------- map
    {
      name: 'recon_map',
      description:
        'Chart a site or section before reading it. Starts at one page, follows that page\'s own navigation links on the same host, reads up to a page budget, and returns a page tree with a one-line summary each. Use it to decide which pages deserve a full read.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          url: { type: 'string', description: 'Entry page; usually the section index or home page.' },
          maxPages: {
            type: 'number',
            description: 'Pages to read, entry included. Defaults to 8; raise it only when the section is genuinely large.',
          },
          includeExternal: {
            type: 'boolean',
            description: 'Also list off-host links the entry points at. Off by default because they belong to other roles.',
          },
        },
        ['workspace', 'url'],
      ),
      output: output({ pages: { type: 'number' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const budget = Math.max(2, Math.min(20, Number(args.maxPages ?? defaults.maxPages)));

        const entryResponse = await politeFetch(web(), args.url, { minIntervalMs: defaults.minIntervalMs, signal: exec?.signal });
        const entry = extractPage(entryResponse.body, entryResponse.finalUrl);
        const nodes = [];
        const seen = new Set([normalizeUrl(args.url), normalizeUrl(entryResponse.finalUrl)]);
        nodes.push({
          url: entryResponse.finalUrl, title: entry.title, level: 0,
          summary: clip(entry.description || entry.sections.find((s) => s.text)?.text || '', 140),
        });

        const ranked = entry.links
          .filter((l) => (args.includeExternal ? true : l.sameOrigin))
          .filter((l) => !/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|css|js)$/i.test(l.href))
          .map((l) => {
            let pathname = '/';
            try { pathname = new URL(l.href).pathname; } catch { /* keep default */ }
            const nav = /docs?|guide|product|platform|pricing|architecture|reference|learn|solution|feature|how-it-works/i.test(l.text + ' ' + pathname);
            return { ...l, pathname, score: (sameSite(l.href, args.url) ? 2 : 0) + (nav ? 2 : 0) + (pathname.length < 40 ? 1 : 0) };
          })
          .filter((l) => {
            const key = normalizeUrl(l.href);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => b.score - a.score || a.pathname.length - b.pathname.length);

        const toRead = ranked.slice(0, budget - 1);
        const skipped = ranked.slice(budget - 1, budget - 1 + 12);

        for (const link of toRead) {
          try {
            const response = await politeFetch(web(), link.href, { minIntervalMs: defaults.minIntervalMs, signal: exec?.signal });
            const page = extractPage(response.body, response.finalUrl);
            const verdict = classifyPage({
              status: response.status, title: page.title, text: page.text,
              htmlBytes: page.stats.htmlBytes, requestedUrl: link.href, finalUrl: response.finalUrl,
            });
            const saved = await savePage(workspace, response.finalUrl || link.href, page.text, {
              status: response.status, title: page.title, description: page.description,
              outline: page.outline, blocked: verdict.blocked, likelyJs: verdict.likelyJs,
            });
            upsertSource(state, {
              url: response.finalUrl || link.href, title: page.title, status: verdict.blocked ? 'blocked' : 'fetched',
              via: 'map', snapshot: saved.snapshot,
            });
            nodes.push({
              url: response.finalUrl || link.href,
              title: page.title || link.text,
              level: 1,
              summary: clip(page.description || page.sections.find((s) => s.text)?.text || '', 140),
              blocked: verdict.blocked,
              linkText: link.text,
            });
          } catch (error) {
            nodes.push({ url: link.href, title: link.text, level: 1, summary: `unreachable: ${error.message}`, blocked: true });
          }
        }

        state.brief.counters.fetches += nodes.length;
        await save(workspace, 'sources', state.sources);
        await writeJson(path.join(workspace, 'brief.json'), state.brief);

        const bySection = new Map();
        for (const node of nodes) {
          let section = '/';
          try { section = new URL(node.url).pathname.split('/').filter(Boolean)[0] || '/'; } catch { /* keep default */ }
          if (!bySection.has(section)) bySection.set(section, []);
          bySection.get(section).push(node);
        }

        const tree = [...bySection.entries()].map(([section, list]) => [
          `${section}/`,
          list.map((n) => `  - ${clip(n.title || n.url, 70)}\n    ${n.url}\n    ${n.summary}${n.blocked ? ' _(unreadable)_' : ''}`).join('\n'),
        ].map(([head, body]) => `${head}\n${body}`).join('\n')).join('\n\n');

        return {
          pages: nodes.length,
          text: [
            `Mapped ${nodes.length}/${budget} pages from ${args.url}`,
            '',
            tree,
            skipped.length
              ? `\n## Not read (${ranked.length - toRead.length} more links found)\n${bulletList(skipped.map((l) => `[${clip(l.text, 50)}](${l.href})`))}\nChoose from these with recon_fetch.`
              : '',
            '',
            'Every page above was saved as a snapshot and registered as a source. Read the ones that carry an argument with recon_fetch before quoting them.',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // ------------------------------------------------------------ evidence
    {
      name: 'recon_evidence',
      description:
        'Record one quotable fact. Stores a verbatim sentence, where it sits, which claim it supports, and how strong the source is. The quote must already appear in the saved snapshot of that page; when it does not, nothing is stored and the closest matching passage comes back so the sentence can be corrected instead of invented.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          url: {
            type: 'string',
            description: 'Page the quote comes from. It must already have a snapshot from recon_fetch or recon_map.',
          },
          quote: {
            type: 'string',
            description: 'The sentence, copied exactly from the page — one to three sentences, no ellipses across gaps.',
          },
          locator: {
            type: 'string',
            description: 'Where on the page it sits, e.g. "H2 How it works, third paragraph" or "pricing table, row Enterprise". Makes the quote findable by a human.',
          },
          claimIds: {
            type: 'array',
            description: 'Claims this evidence supports. Omit to file it unlinked and attach it later with recon_claim.',
            items: { type: 'string' },
          },
          strength: {
            type: 'string',
            enum: LEVELS.map((l) => l.key),
            description: 'Evidence level. Defaults from the source role: official docs are primary, forums are anecdotal.',
          },
          contests: {
            type: 'string',
            description: 'Evidence id this record contradicts. Setting it marks the linked claims contested.',
          },
          allowUnverified: {
            type: 'boolean',
            description:
              'Store the quote even though it is not in the snapshot. Use only for a passage you could not capture, and accept that recon_audit will flag it.',
          },
        },
        ['workspace', 'url', 'quote'],
      ),
      output: output({ id: { type: 'string' }, verified: { type: 'boolean' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const quote = String(args.quote || '').trim();
        if (quote.length < 12) fail('quote is too short to be evidence: give a full sentence');

        const source = findSource(state, args.url);
        if (!source?.snapshot) {
          fail(`no snapshot for ${args.url}. Run recon_fetch on it first — evidence must come from a page this workspace has actually read.`);
        }
        const snapshot = await readSnapshot(workspace, source.snapshot);
        const haystack = normSpace(snapshot);
        const needle = normSpace(quote);
        const verified = haystack.includes(needle);

        if (!verified && !args.allowUnverified) {
          const near = closestPassage(needle, haystack);
          return {
            verified: false,
            text: [
              'Quote not found in the saved page. Nothing was recorded.',
              '',
              `Searched: ${source.snapshot} (${haystack.length} characters)`,
              '',
              near
                ? `${near.weak ? 'Nearest region (no shared opening):' : 'Closest passage:'}\n\n> ${near.text}\n\n(at character ${near.index}; shares ${near.length} characters with your quote)`
                : 'No overlapping passage at all — the page may have changed, or the quote may be from a different URL.',
              '',
              'Fix the quote until it is verbatim, or pass allowUnverified: true and accept the audit flag.',
            ].join('\n'),
          };
        }

        const strength = args.strength
          || ({ primary: 'primary', docs: 'primary', pricing: 'primary', release: 'primary', engineering: 'primary', regulatory: 'primary', thirdparty: 'independent', data: 'measured', community: 'anecdotal', customer: 'anecdotal', competitor: 'independent' }[source.role] || 'anecdotal');

        const item = {
          id: formatId('E', state.evidence.nextId),
          url: args.url,
          sourceId: source.id,
          quote,
          locator: args.locator || '',
          strength,
          verified,
          contests: args.contests || null,
          claimIds: args.claimIds || [],
          snapshot: source.snapshot,
          recordedAt: new Date().toISOString(),
        };
        state.evidence.nextId += 1;
        state.evidence.items.push(item);

        for (const claimId of item.claimIds) {
          const claim = state.claims.items.find((c) => c.id === claimId);
          if (!claim) continue;
          claim.evidence = [...new Set([...(claim.evidence || []), item.id])];
        }
        await save(workspace, 'evidence', state.evidence);
        await save(workspace, 'claims', state.claims);

        const linked = item.claimIds.map((id) => {
          const claim = state.claims.items.find((c) => c.id === id);
          return claim ? `${id} → ${claimStatus(claim, state.evidence.items).status}` : `${id} (missing)`;
        });

        return {
          id: item.id,
          verified,
          text: [
            `${item.id} recorded · ${LEVEL_BY_KEY.get(strength).label} · ${verified ? 'verbatim in snapshot' : 'UNVERIFIED'}`,
            '',
            `> ${clip(quote, 400)}`,
            '',
            `Source: ${source.id} ${clip(source.title || '', 60)} — ${args.url}`,
            item.locator ? `Locator: ${item.locator}` : 'Locator: (none — add one so a reader can find it)',
            linked.length ? `Supports: ${linked.join(', ')}` : 'Supports: nothing yet — attach it with recon_claim addEvidence',
          ].join('\n'),
        };
      },
    },

    // --------------------------------------------------------------- claim
    {
      name: 'recon_claim',
      description:
        'Add or update a claim: the single sentence the report will assert, which sub-question it answers, and which evidence backs it. Support status is computed from the ledger — unsupported, single-source, supported, contested — never accepted as input.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          id: {
            type: 'string',
            description: 'Existing claim id to update, e.g. C03. Omit to create a new claim.',
          },
          text: {
            type: 'string',
            description: 'The assertion, as one declarative sentence. If it needs "and", it is two claims.',
          },
          parent: {
            type: 'string',
            description: 'Sub-question id it answers, e.g. Q02.',
          },
          addEvidence: {
            type: 'array',
            description: 'Evidence ids to attach.',
            items: { type: 'string' },
          },
          removeEvidence: {
            type: 'array',
            description: 'Evidence ids to detach.',
            items: { type: 'string' },
          },
          note: {
            type: 'string',
            description: 'Caveat, scope, or the reason two sources disagree.',
          },
        },
        ['workspace'],
      ),
      output: output({ id: { type: 'string' }, status: { type: 'string' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);

        let claim = args.id ? state.claims.items.find((c) => c.id === args.id) : undefined;
        if (args.id && !claim) fail(`no claim ${args.id} in this workspace`);

        if (!claim) {
          if (!args.text) fail('text is required when creating a claim');
          claim = {
            id: formatId('C', state.claims.nextId),
            text: args.text,
            parent: args.parent || '',
            evidence: [],
            probe: { answers: {} },
            note: '',
            createdAt: new Date().toISOString(),
          };
          state.claims.nextId += 1;
          state.claims.items.push(claim);
        } else {
          if (args.text) claim.text = args.text;
          if (args.parent) claim.parent = args.parent;
          if (args.note) claim.note = args.note;
        }

        const attached = (args.addEvidence || []).map((id) => {
          const found = state.evidence.items.find((e) => e.id === id);
          if (!found) fail(`no evidence ${id} in this workspace`);
          found.claimIds = [...new Set([...(found.claimIds || []), claim.id])];
          return id;
        });
        claim.evidence = [...new Set([...(claim.evidence || []), ...attached])];
        const detached = args.removeEvidence || [];
        claim.evidence = claim.evidence.filter((id) => !detached.includes(id));
        for (const id of detached) {
          const found = state.evidence.items.find((e) => e.id === id);
          if (found) found.claimIds = (found.claimIds || []).filter((c) => c !== claim.id);
        }

        await save(workspace, 'claims', state.claims);
        await save(workspace, 'evidence', state.evidence);

        const { status, linked } = claimStatus(claim, state.evidence.items);
        const probe = probeScore(claim);
        const parent = state.brief?.subquestions?.find((q) => q.id === claim.parent);

        return {
          id: claim.id,
          status,
          text: [
            `${claim.id} · ${status} · depth ${probe.answered}/8`,
            '',
            claim.text,
            parent ? `Answers ${parent.id}: ${clip(parent.text.split('\n')[0], 100)}` : 'Answers: (no parent sub-question)',
            '',
            linked.length
              ? `Evidence:\n${bulletList(linked.map((e) => `${e.id} [${e.strength}] ${clip(e.quote, 90)}`))}`
              : 'Evidence: none. This claim cannot appear as a finding until it has at least one quoted source.',
            claim.note ? `\nNote: ${claim.note}` : '',
            probe.answered < 8 ? `\nMissing rungs: ${probe.missing.join(', ')} — call recon_probe ${claim.id}.` : '',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // --------------------------------------------------------------- probe
    {
      name: 'recon_probe',
      description:
        'Interrogate one claim against the eight rungs of depth: mechanism, evidence, preconditions, alternatives, counter-evidence, boundary, second-order consequence, and what it means for the asker. Without answers it returns the rungs with prompts; with answers it stores them and reports how deep the claim has become.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          claimId: { type: 'string', description: 'Claim to interrogate, e.g. C02.' },
          answers: {
            type: 'object',
            description:
              'Answers keyed by rung. Any subset may be supplied in one call; each needs a real sentence, not a restatement of the claim.',
            properties: Object.fromEntries(RUNG_KEYS.map((key) => [key, { type: 'string' }])),
            additionalProperties: false,
          },
        },
        ['workspace', 'claimId'],
      ),
      output: output({ percent: { type: 'number' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const claim = state.claims.items.find((c) => c.id === args.claimId);
        if (!claim) fail(`no claim ${args.claimId} in this workspace`);
        claim.probe = claim.probe || { answers: {} };
        claim.probe.answers = claim.probe.answers || {};

        const answers = args.answers || {};
        const written = Object.keys(answers).filter((key) => RUNG_KEYS.includes(key) && String(answers[key] || '').trim());
        for (const key of written) claim.probe.answers[key] = String(answers[key]).trim();
        if (written.length) {
          claim.probe.updatedAt = new Date().toISOString();
          await save(workspace, 'claims', state.claims);
        }

        const probe = probeScore(claim);
        const rungRows = DEPTH_RUNGS.map((rung) => {
          const answer = claim.probe.answers[rung.key];
          return [`${rung.label} \`${rung.key}\``, answer ? clip(answer, 160) : `_待回答_ — ${rung.ask}`];
        });

        return {
          percent: probe.percent,
          text: [
            `${claim.id} depth ${probe.answered}/8 (${probe.percent}%)`,
            '',
            `Claim: ${claim.text}`,
            '',
            table(['Rung', 'Answer'], rungRows),
            '',
            written.length
              ? `Recorded: ${written.join(', ')}.`
              : 'Call again with answers, e.g. recon_probe { claimId, answers: { mechanism: "...", counter: "..." } }.',
            probe.missing.length && written.length ? `Still missing: ${probe.missing.join(', ')}` : '',
            probe.percent < 50
              ? '\nBelow 50% a claim reads as reporting, not understanding. Start with mechanism and counter — they change the conclusion most often.'
              : '',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // ---------------------------------------------------------------- gaps
    {
      name: 'recon_gaps',
      description:
        'Report what is still missing: uncovered source roles, unsupported and single-source claims, shallow claims, contradictions, unverified quotes and orphaned evidence, ranked by how much each would change the report. Call it after every few pages instead of wondering whether the research is done.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          limit: { type: 'number', description: 'Maximum gaps to list. Defaults to 12.' },
        },
        ['workspace'],
      ),
      output: output({ blockers: { type: 'number' }, coverage: { type: 'number' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const report = gaps({ brief: state.brief, sources: state.sources.items, evidence: state.evidence.items, claims: state.claims.items });
        const limit = Number(args.limit ?? 12);
        const shown = report.items.slice(0, limit);

        const claimRows = state.claims.items.map((claim) => {
          const { status } = claimStatus(claim, state.evidence.items);
          const probe = probeScore(claim);
          return [claim.id, clip(claim.text, 60), status, `${probe.answered}/8`];
        });

        return {
          blockers: report.blockers,
          coverage: report.coverage.percent,
          text: [
            `Coverage ${report.coverage.covered}/${report.coverage.total} roles (${report.coverage.percent}%) · ${state.sources.items.length} sources · ${state.evidence.items.length} evidence · ${state.claims.items.length} claims · ${report.blockers} blockers`,
            '',
            '## Breadth',
            table(['角色', '读过', '登记', '状态'], report.coverage.rows.map((r) => [
              r.label, r.fetched, r.total, r.covered ? 'ok' : 'EMPTY',
            ])),
            '',
            '## Evidence levels',
            table(['级别', '条数'], report.levels.map((l) => [l.label, l.count])),
            '',
            '## Claims',
            claimRows.length ? table(['ID', '断言', '状态', '深度'], claimRows) : '(no claims yet)',
            '',
            `## Gaps (${report.items.length})`,
            shown.length
              ? bulletList(shown.map((g) => `**[${g.severity}] ${g.kind} · ${g.subject}** — ${g.detail}\n   → ${g.action}`))
              : 'Nothing outstanding. Run recon_report, then recon_audit.',
            report.items.length > shown.length ? `\n…and ${report.items.length - shown.length} more; raise limit to see them.` : '',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // -------------------------------------------------------------- report
    {
      name: 'recon_report',
      description:
        'Write report.md from the ledger: method, breadth table, findings in argument order with 【E##】 citations, the depth actually reached, tensions, implications, limits, and an evidence appendix with quotes and links. Unsupported claims never appear as findings — they go to an explicit open-questions section.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          title: { type: 'string', description: 'Report title. Defaults to the question.' },
          lang: {
            type: 'string',
            enum: ['auto', 'zh', 'en'],
            description: 'Prose language. auto follows the language of the original question.',
          },
          includeDepth: {
            type: 'boolean',
            description: 'Include each finding\'s mechanism, counter-evidence and boundary answers. On by default; they are what separate this from a link roundup.',
          },
        },
        ['workspace'],
      ),
      output: output({ file: { type: 'string' }, findings: { type: 'number' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const lang = args.lang && args.lang !== 'auto' ? args.lang : state.brief?.lang || 'zh';
        const zh = lang === 'zh';
        const includeDepth = args.includeDepth !== false;

        const claims = state.claims.items.map((claim) => {
          const { status, linked } = claimStatus(claim, state.evidence.items);
          return { claim, status, linked, probe: probeScore(claim) };
        });
        const findings = claims.filter((c) => c.status === 'supported' || c.status === 'contested');
        const weak = claims.filter((c) => c.status === 'single-source');
        const open = claims.filter((c) => c.status === 'unsupported');
        const cov = coverage(state.brief, state.sources.items);

        const cite = (ids) => (ids || []).map((id) => `【${id}】`).join('');
        const evidenceById = new Map(state.evidence.items.map((e) => [e.id, e]));

        const sections = [];
        sections.push(`# ${args.title || state.brief?.question || 'Research report'}`);
        sections.push([
          zh ? `> **调研问题**：${state.brief?.question || ''}` : `> **Question**: ${state.brief?.question || ''}`,
          state.brief?.goal ? (zh ? `> **用途**：${state.brief.goal}` : `> **Purpose**: ${state.brief.goal}`) : '',
          state.brief?.audience ? (zh ? `> **读者**：${state.brief.audience}` : `> **Reader**: ${state.brief.audience}`) : '',
          zh
            ? `> **规模**：${state.sources.items.length} 个来源 · ${state.evidence.items.length} 条证据 · ${claims.length} 条断言 · ${cov.covered}/${cov.total} 类来源`
            : `> **Scale**: ${state.sources.items.length} sources · ${state.evidence.items.length} evidence · ${claims.length} claims · ${cov.covered}/${cov.total} roles`,
          `> **Generated**: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        ].filter(Boolean).join('  \n'));

        sections.push([
          zh ? '## 方法与边界' : '## Method and limits',
          '',
          zh
            ? [
              '每一页按顺序单独读取，读一份、记一份，再进入下一页；全部页面文本都已存为快照，正文中的【E##】对应附录 A 中逐字引文。',
              `广度按 ${cov.total} 类来源角色衡量，已覆盖 ${cov.covered} 类；深度按八级阶梯衡量，每条断言的完成度写在正文里。`,
              '本报告的结论只到证据支持的位置为止：证据不足的断言不会出现在"发现"里，而是列在"尚未回答"。',
            ].join('\n\n')
            : [
              'Pages were read one at a time, in order, and captured before the next was opened; every quote in the appendix is verbatim from a saved snapshot.',
              `Breadth is measured against ${cov.total} source roles (${cov.covered} covered); depth against eight rungs, reported per finding.`,
              'Conclusions stop where the evidence stops: weakly supported assertions appear under open questions, not as findings.',
            ].join('\n\n'),
        ].join('\n'));

        sections.push([
          zh ? '## 来源地图' : '## Source map',
          '',
          table(
            zh ? ['角色', '来源', '状态'] : ['Role', 'Sources', 'State'],
            cov.rows.map((r) => [r.label, String(r.fetched), r.covered ? 'ok' : 'EMPTY']),
          ),
        ].join('\n'));

        sections.push([zh ? '## 发现' : '## Findings', ''].join('\n'));
        if (!findings.length) {
          sections.push(zh ? '_还没有任何一条断言达到"已支持"。先用 recon_evidence 与 recon_claim 把证据挂上去。_' : '_No claim is supported yet. Attach evidence with recon_evidence and recon_claim._');
        }
        findings.forEach((entry, index) => {
          const { claim, status, linked, probe } = entry;
          const marker = status === 'contested' ? (zh ? '（存疑）' : ' (contested)') : '';
          sections.push(`### ${index + 1}. ${claim.text}${marker}\n`);
          sections.push(`${zh ? '证据' : 'Evidence'}${cite(linked.map((e) => e.id))} · ${zh ? '深度' : 'depth'} ${probe.answered}/8\n`);
          if (includeDepth) {
            const answers = claim.probe?.answers || {};
            const rungs = [
              ['mechanism', zh ? '机制' : 'Mechanism'],
              ['preconditions', zh ? '前提' : 'Preconditions'],
              ['alternatives', zh ? '替代解释' : 'Alternatives'],
              ['counter', zh ? '反证' : 'Counter-evidence'],
              ['boundary', zh ? '边界' : 'Boundary'],
              ['consequence', zh ? '二阶后果' : 'Second-order effect'],
            ];
            const body = rungs
              .filter(([key]) => answers[key])
              .map(([key, label]) => `- **${label}**：${answers[key]}`)
              .join('\n');
            if (body) sections.push(`${body}\n`);
          }
          const quotes = linked.slice(0, 3).map((e) => `> ${e.quote}\n> — ${e.id}, ${e.locator || e.url}`);
          if (quotes.length) sections.push(`${quotes.join('\n>\n')}\n`);
          if (claim.note) sections.push(`${zh ? '注' : 'Note'}：${claim.note}\n`);
        });

        const tensions = findings.filter((f) => f.status === 'contested').concat(weak);
        if (tensions.length) {
          sections.push([
            zh ? '## 张力与不确定' : '## Tension and uncertainty',
            '',
            bulletList(tensions.map(({ claim, status }) => (status === 'contested'
              ? `${claim.id} ${claim.text} — ${zh ? '两条来源互相矛盾，取舍理由见正文' : 'two sources disagree; the choice is stated in the finding'}`
              : `${claim.id} ${claim.text} — ${zh ? '仅一个来源，未做交叉验证' : 'single source, not cross-checked'}`))),
          ].join('\n'));
        }

        const implications = claims
          .filter((c) => c.claim.probe?.answers?.implication)
          .map((c) => `- ${c.claim.probe.answers.implication}`);
        if (implications.length) {
          sections.push([zh ? '## 对我们的含义' : '## What this means for the reader', '', implications.join('\n')].join('\n'));
        }

        const openParts = [
          open.length
            ? bulletList(open.map((c) => `${c.claim.id} ${c.claim.text} — ${zh ? '目前没有任何证据' : 'no supporting evidence'}`))
            : (zh ? '- 无' : '- none'),
        ];
        const uncovered = cov.rows.filter((r) => !r.covered);
        if (uncovered.length) {
          openParts.push(`**${zh ? '未覆盖的来源类型' : 'Uncovered source roles'}**：${uncovered.map((r) => r.label).join('、')}`);
        }
        if (weak.length) {
          openParts.push(`**${zh ? '仅单一来源的判断' : 'Single-source claims'}**：${weak.map((c) => c.claim.id).join(', ')}`);
        }
        sections.push([zh ? '## 尚未回答' : '## Open questions', '', openParts.join('\n\n')].join('\n'));

        sections.push([
          zh ? '## 附录 A：证据清单' : '## Appendix A: evidence',
          '',
          table(
            zh ? ['编号', '级别', '来源', '原文', '位置'] : ['ID', 'Level', 'Source', 'Quote', 'Locator'],
            state.evidence.items.map((e) => [
              e.id,
              LEVEL_BY_KEY.get(e.strength)?.label || e.strength,
              e.url,
              clip(e.quote, 120),
              e.locator || '—',
            ]),
          ),
        ].join('\n'));

        sections.push([
          zh ? '## 附录 B：来源清单' : '## Appendix B: sources',
          '',
          table(
            zh ? ['ID', '角色', '状态', '标题', 'URL'] : ['ID', 'Role', 'State', 'Title', 'URL'],
            state.sources.items.map((s) => [s.id, s.role, s.status, clip(s.title || '—', 60), s.url]),
          ),
        ].join('\n'));

        const markdown = `${sections.filter(Boolean).join('\n\n')}\n`;
        const file = pathsOf(workspace).report;
        await writeAtomic(file, markdown);

        return {
          file,
          findings: findings.length,
          text: [
            `Wrote ${file}`,
            '',
            `${findings.length} findings · ${weak.length} single-source · ${open.length} open · ${state.evidence.items.length} evidence · coverage ${cov.covered}/${cov.total}`,
            '',
            open.length ? `Unsupported claims kept out of findings: ${open.map((c) => c.claim.id).join(', ')}` : 'No unsupported claims.',
            cov.rows.some((r) => !r.covered) ? `Uncovered roles: ${cov.rows.filter((r) => !r.covered).map((r) => r.label).join(', ')}` : '',
            '',
            'Run recon_audit before presenting it.',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // --------------------------------------------------------------- audit
    {
      name: 'recon_audit',
      description:
        'Gate the report. Checks that every claim is supported, every quote still appears in its snapshot, every read page has a snapshot on disk, every applicable source role was actually read, and every citation resolves. Returns pass, or the exact fixes in priority order.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          strict: {
            type: 'boolean',
            description: 'Treat uncovered source roles and shallow claims as failures instead of warnings.',
          },
        },
        ['workspace'],
      ),
      output: output({ pass: { type: 'boolean' }, errors: { type: 'number' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const state = await loadState(workspace);
        const strict = Boolean(args.strict);
        const errors = [];
        const warnings = [];

        for (const claim of state.claims.items) {
          const { status } = claimStatus(claim, state.evidence.items);
          if (status === 'unsupported') errors.push(`${claim.id} has no evidence: “${clip(claim.text, 70)}”`);
          if (status === 'contested' && !claim.note) warnings.push(`${claim.id} is contested with no note explaining the choice`);
          const probe = probeScore(claim);
          if (probe.percent < 50) {
            const line = `${claim.id} depth ${probe.answered}/8 — missing ${probe.missing.slice(0, 3).join(', ')}`;
            (strict ? errors : warnings).push(line);
          }
        }

        for (const item of state.evidence.items) {
          if (item.verified === false) errors.push(`${item.id} quote was never found in ${item.snapshot || 'a snapshot'}`);
          if (!item.locator) warnings.push(`${item.id} has no locator — a reader cannot find it on the page`);
          if (!(item.claimIds || []).length && !state.claims.items.some((c) => (c.evidence || []).includes(item.id))) {
            warnings.push(`${item.id} is not attached to any claim`);
          }
          const snapshot = item.snapshot ? path.join(workspace, item.snapshot) : null;
          if (snapshot) {
            try {
              const text = normSpace(await fs.readFile(snapshot, 'utf8'));
              if (!text.includes(normSpace(item.quote))) {
                errors.push(`${item.id} quote no longer matches its snapshot — the page changed or the quote was edited`);
              }
            } catch {
              errors.push(`${item.id} points at a missing snapshot: ${item.snapshot}`);
            }
          }
        }

        for (const source of state.sources.items) {
          if (source.status === 'fetched' && !source.snapshot) errors.push(`${source.id} is marked read but has no snapshot`);
          if (source.snapshot) {
            try { await fs.access(path.join(workspace, source.snapshot)); } catch { errors.push(`${source.id} snapshot file is missing: ${source.snapshot}`); }
          }
        }

        const cov = coverage(state.brief, state.sources.items);
        for (const row of cov.rows) {
          if (!row.covered) {
            const line = `source role “${row.label}” has no page actually read`;
            (strict ? errors : warnings).push(line);
          }
        }

        const seenQuotes = new Map();
        for (const item of state.evidence.items) {
          const key = `${normalizeUrl(item.url)}|${normSpace(item.quote)}`;
          if (seenQuotes.has(key)) warnings.push(`${item.id} duplicates ${seenQuotes.get(key)}`);
          else seenQuotes.set(key, item.id);
        }

        let hasReport = true;
        try { await fs.access(pathsOf(workspace).report); } catch { hasReport = false; }
        if (!hasReport) warnings.push('report.md has not been written yet — run recon_report');

        const pass = errors.length === 0;
        return {
          pass,
          errors: errors.length,
          text: [
            `${pass ? 'PASS' : 'FAIL'} · ${errors.length} errors · ${warnings.length} warnings`,
            '',
            errors.length ? `## Must fix\n${bulletList(errors.slice(0, 20))}` : '## Must fix\n- nothing blocking',
            errors.length > 20 ? `…and ${errors.length - 20} more` : '',
            '',
            warnings.length ? `## Should fix\n${bulletList(warnings.slice(0, 20))}` : '## Should fix\n- nothing outstanding',
            warnings.length > 20 ? `…and ${warnings.length - 20} more` : '',
            '',
            pass
              ? (warnings.length
                ? 'The report is defensible. Warnings above are the honest limits to state in it.'
                : 'The report is defensible and complete against its own brief.')
              : 'Fix the errors, or move those claims into open questions where they cannot be read as findings.',
          ].filter(Boolean).join('\n'),
        };
      },
    },

    // ------------------------------------------------------------- capture
    {
      name: 'recon_capture',
      description:
        'Screenshot a page section through a local Chrome on a debugging port, after measuring the target, hiding overlays, scrolling it into frame, re-measuring, and testing for occlusion. A capture that cannot be verified is not saved, and the failure names which measurement failed. Use it for pages recon_fetch reports as client-rendered or blocked.',
      parameters: schema(
        {
          workspace: { type: 'string', description: 'Workspace directory.' },
          url: { type: 'string', description: 'Page to capture.' },
          target: {
            type: 'string',
            description: 'Exact text of the heading or block to frame, e.g. "How it works". The capture frames that element, not the page top.',
          },
          selector: {
            type: 'string',
            description: 'CSS selector to search for the target text in. Defaults to h1–h4; widen to p,li,div when the target is body text.',
          },
          name: { type: 'string', description: 'File stem for the PNG. Defaults to a slug of the URL and target.' },
          top: { type: 'number', description: 'Pixels between the viewport top and the target. Defaults to 120.' },
          width: { type: 'number', description: 'Viewport width. Defaults to 1440.' },
          height: { type: 'number', description: 'Viewport height. Defaults to 900.' },
          port: { type: 'number', description: 'Chrome DevTools port. Defaults to 9222.' },
          claimIds: {
            type: 'array',
            description: 'Claims this figure illustrates; recorded in artifacts.json.',
            items: { type: 'string' },
          },
        },
        ['workspace', 'url', 'target'],
      ),
      output: output({ ok: { type: 'boolean' } }),
      async execute(args, exec) {
        const workspace = await resolveWorkspace(ctx, exec, args.workspace);
        const stem = slugify(args.name || `${args.url}-${args.target}`, 'capture');
        const outFile = path.join(workspace, 'captures', `${stem}.png`);

        const record = await captureSection({
          port: Number(args.port ?? 9222),
          url: args.url,
          targetText: args.target,
          selector: args.selector || 'h1,h2,h3,h4',
          top: Number(args.top ?? 120),
          width: Number(args.width ?? 1440),
          height: Number(args.height ?? 900),
          workspace,
          outFile,
        });

        if (!record.ok) {
          const browser = await probeBrowser(Number(args.port ?? 9222));
          return {
            ok: false,
            text: [
              'Capture refused — nothing was saved.',
              '',
              `Reason: ${record.reason}`,
              browser.ok ? '' : `Browser: ${browser.hint}`,
              '',
              record.attempts?.length
                ? `Attempts:\n${bulletList(record.attempts.map((a) => `#${a.attempt}: ${a.error || 'ok'}`))}`
                : '',
              'Adjust the target text, widen the selector, or add a wait; do not describe a page you could not frame.',
            ].filter(Boolean).join('\n'),
          };
        }

        const state = await loadState(workspace);
        const artifact = {
          id: formatId('F', state.artifacts.nextId),
          file: path.relative(workspace, outFile),
          url: args.url,
          target: args.target,
          viewport: record.viewport,
          bytes: record.pixels?.bytes,
          claimIds: args.claimIds || [],
          capturedAt: record.capturedAt,
        };
        state.artifacts.nextId += 1;
        state.artifacts.items.push(artifact);
        await save(workspace, 'artifacts', state.artifacts);

        return {
          ok: true,
          text: [
            `${artifact.id} saved · ${record.pixels.width}x${record.pixels.height} · ${Math.round(record.pixels.bytes / 1024)} KB`,
            '',
            `File: ${artifact.file}`,
            `Target: “${args.target}” measured at ${Math.round(record.target.rect.width)}x${Math.round(record.target.rect.height)} px, in frame, no overlay`,
            record.finalUrl !== args.url ? `Redirected to: ${record.finalUrl}` : '',
            '',
            'The verification record sits beside the image as .png.json. Reference the file in the report; a screenshot is an illustration, not a substitute for a quoted sentence.',
          ].filter(Boolean).join('\n'),
        };
      },
    },
  ];
}

/** Find the passage in `haystack` that overlaps a quote the most. */
function closestPassage(needle, haystack) {
  const max = Math.min(needle.length, 80);
  for (let length = max; length >= 12; length -= 4) {
    const probe = needle.slice(0, length);
    const index = haystack.indexOf(probe);
    if (index >= 0) {
      return { index, length, text: clip(haystack.slice(index, index + 240), 240) };
    }
  }
  // No shared prefix: fall back to the longest distinctive word in the quote.
  const words = [...new Set(needle.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5))]
    .sort((a, b) => b.length - a.length);
  for (const word of words) {
    const index = haystack.indexOf(word);
    if (index >= 0) {
      return { index, length: word.length, weak: true, text: clip(haystack.slice(Math.max(0, index - 120), index + 240), 300) };
    }
  }
  return null;
}
