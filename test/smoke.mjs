// Offline end-to-end check of the recon tool suite.
// A fake web service stands in for the network, so this exercises the ledger,
// the quote gate, the ladders, the report, and the audit with no network access.
//
//   node test/smoke.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';

const PAGES = {
  'https://example.com/docs/how-it-works': `<!doctype html><html><head>
    <title>How it works · Example</title>
    <meta name="description" content="The request path explained end to end.">
    </head><body>
    <nav><a href="/docs/overview">Overview</a><a href="/pricing">Pricing</a></nav>
    <h1>How it works</h1>
    <p>Every call is resolved against a compiled policy before it reaches a model.</p>
    <h2>Request path</h2>
    <p>Requests are queued, classified, and then routed to one of three handlers.</p>
    <p>The classifier runs in under 12 milliseconds at the 95th percentile.</p>
    <h2>Failure handling</h2>
    <p>When a handler is unavailable the request is retried twice before failing closed.</p>
    <p>Retries are logged with the original trace id.</p>
    </body></html>`,
  'https://example.com/pricing': `<!doctype html><html><head><title>Pricing · Example</title></head>
    <body><h1>Pricing</h1><p>The base tier costs 40 dollars per month and includes 10 thousand calls.</p>
    <p>Overage is billed at 0.004 dollars per call.</p></body></html>`,
};

const fakeWeb = {
  async fetch({ url }) {
    const html = PAGES[url];
    if (!html) return { url, statusCode: 404, body: { kind: 'text', content: 'not found' }, truncated: false };
    return { url, statusCode: 200, body: { kind: 'html', content: html }, truncated: false };
  },
  async search({ query }) {
    return {
      content: `summary for ${query}`,
      sources: [
        { url: 'https://example.com/docs/how-it-works', title: 'How it works' },
        { url: 'https://example.com/pricing', title: 'Pricing' },
        { url: 'https://example.com/blog/design', title: 'Design notes' },
      ],
      truncated: false,
    };
  },
};

const ctx = {
  get(name) {
    if (name === 'web') return fakeWeb;
    if (name === 'workingDirectory') return { ensure: async () => process.cwd() };
    return undefined;
  },
};

const tools = new Map(createTools(ctx, {}).map((t) => [t.name, t]));
const exec = { agent: {} };
const call = (name, args) => {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.execute(args, exec);
};

function section(text, title) {
  const start = text.indexOf(title);
  assert.ok(start >= 0, `expected “${title}” in output:\n${text.slice(0, 600)}`);
  return text.slice(start);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recon-smoke-'));
const failures = [];
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); } catch (error) { failures.push(`${label}: ${error.message}`); console.log(`  FAIL ${label}\n       ${error.message}`); }
};

try {
  console.log('recon smoke test');

  await check('recon_init writes a workspace with breadth and depth', async () => {
    const result = await call('recon_init', {
      question: 'How does Example route and price model calls?',
      goal: 'Decide whether to adopt it',
      dir: root,
    });
    assert.ok(result.workspace, 'workspace returned');
    const brief = JSON.parse(await fs.readFile(path.join(result.workspace, 'brief.json'), 'utf8'));
    assert.equal(brief.subquestions.length, 6, 'six sub-questions');
    assert.equal(brief.breadth.roles.length, 8, 'eight source roles');
    assert.match(result.text, /Breadth — source roles/);
    globalThis.__workspace = result.workspace;
  });

  const workspace = globalThis.__workspace;

  await check('recon_init is idempotent', async () => {
    const again = await call('recon_init', { question: 'How does Example route and price model calls?', dir: root });
    assert.match(again.text, /already exists/);
  });

  await check('recon_search registers candidates with roles', async () => {
    const result = await call('recon_search', { workspace, queries: ['example routing', 'example pricing'] });
    assert.ok(result.found >= 2, 'found sources');
    assert.match(result.text, /New candidates/);
    const sources = JSON.parse(await fs.readFile(path.join(workspace, 'sources.json'), 'utf8'));
    assert.ok(sources.items.some((s) => s.role === 'pricing'), 'a pricing source was classified');
  });

  await check('recon_fetch saves a snapshot and reports the outline', async () => {
    const result = await call('recon_fetch', {
      workspace, url: 'https://example.com/docs/how-it-works', role: 'docs', purpose: 'Q02 mechanism',
    });
    assert.equal(result.status, 200);
    assert.match(result.text, /Request path/, 'outline present');
    const snapshot = await fs.readFile(path.join(workspace, result.snapshot), 'utf8');
    assert.match(snapshot, /compiled policy/, 'body text stored');
    globalThis.__snapshot = result.snapshot;
  });

  await check('recon_evidence rejects a quote that is not in the snapshot', async () => {
    const result = await call('recon_evidence', {
      workspace, url: 'https://example.com/docs/how-it-works',
      quote: 'Every request is validated against a signed policy bundle.', // invented
    });
    assert.equal(result.verified, false);
    assert.match(result.text, /not found/i);
    assert.match(result.text, /Closest passage|Nearest region/, 'offers the nearest real passage');
  });

  await check('recon_evidence accepts a verbatim quote', async () => {
    const result = await call('recon_evidence', {
      workspace, url: 'https://example.com/docs/how-it-works',
      quote: 'Every call is resolved against a compiled policy before it reaches a model.',
      locator: 'H1 How it works, first paragraph',
      claimIds: [],
    });
    assert.equal(result.verified, true);
    assert.equal(result.id, 'E01');
  });

  await check('recon_claim derives single-source status', async () => {
    const result = await call('recon_claim', {
      workspace, text: 'Calls are gated by a compiled policy before any model is invoked.',
      parent: 'Q02', addEvidence: ['E01'],
    });
    assert.equal(result.status, 'single-source');
    globalThis.__claim = result.id;
  });

  await check('recon_fetch reads a second page, giving cross-source support', async () => {
    await call('recon_fetch', { workspace, url: 'https://example.com/pricing', role: 'pricing' });
    const pricingQuote = await call('recon_evidence', {
      workspace, url: 'https://example.com/pricing',
      quote: 'The base tier costs 40 dollars per month and includes 10 thousand calls.',
      locator: 'H1 Pricing, first paragraph',
      claimIds: [globalThis.__claim],
    });
    assert.equal(pricingQuote.verified, true);
    const claim = await call('recon_claim', { workspace, id: globalThis.__claim, addEvidence: [pricingQuote.id] });
    assert.equal(claim.status, 'supported', `expected supported, got ${claim.status}`);
  });

  await check('recon_probe reports and stores depth', async () => {
    const ladder = await call('recon_probe', { workspace, claimId: globalThis.__claim });
    assert.match(ladder.text, /机制/);
    assert.equal(ladder.percent, 0);
    const answered = await call('recon_probe', {
      workspace, claimId: globalThis.__claim,
      answers: {
        mechanism: 'A classifier inspects the request, matches it to a compiled policy, and only then dispatches to a handler.',
        counter: 'If policies were hot-reloaded without recompilation the gate could be bypassed for a short window.',
      },
    });
    assert.equal(answered.percent, 25);
  });

  await check('recon_gaps names uncovered roles and shallow claims', async () => {
    const result = await call('recon_gaps', { workspace });
    assert.match(result.text, /Breadth/);
    assert.match(result.text, /EMPTY/, 'some role is still empty');
    assert.ok(result.blockers >= 0);
  });

  await check('recon_report writes findings with citations and an appendix', async () => {
    const result = await call('recon_report', { workspace, lang: 'en' });
    const markdown = await fs.readFile(result.file, 'utf8');
    assert.match(markdown, /## Findings/);
    assert.match(markdown, /【E01】/, 'citation marker present');
    assert.match(markdown, /Appendix A: evidence/);
    assert.match(markdown, /compiled policy/, 'the quote survives into the report');
    assert.ok(result.findings >= 1);
  });

  await check('recon_audit fails on uncovered roles in strict mode', async () => {
    const loose = await call('recon_audit', { workspace });
    assert.equal(loose.pass, true, `loose audit should pass: ${loose.text}`);
    const strict = await call('recon_audit', { workspace, strict: true });
    assert.equal(strict.pass, false, 'strict audit should fail while roles are empty');
    assert.match(strict.text, /no page actually read/);
  });

  await check('recon_capture reports a clear failure without a browser', async () => {
    const result = await call('recon_capture', {
      workspace, url: 'https://example.com/', target: 'How it works', port: 9333,
    });
    assert.equal(result.ok, false);
    assert.match(result.text, /Capture refused/);
    assert.match(result.text, /remote-debugging-port/);
  });
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
