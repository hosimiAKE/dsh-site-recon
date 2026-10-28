// Page extraction: dependency-free HTML -> readable structure.
// The same normalisation is used later to prove that a quoted sentence really
// appears in the saved snapshot, so text and quotes can never drift apart.

const BLOCK_CLOSERS = [
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'blockquote', 'pre', 'figure', 'figcaption', 'form', 'ul', 'ol', 'dl', 'dt',
  'dd', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
];

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', times: '×',
  laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', yen: '¥',
};

/** Decode the entity forms that matter for readable text and quote matching. */
export function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** Collapse every run of whitespace to one space and trim. */
export function normSpace(input) {
  return String(input || '').replace(/[\s\u00a0\u2007\u202f]+/g, ' ').trim();
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

function stripInvisible(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ');
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function attr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function metaContent(html, keys) {
  for (const key of keys) {
    const re = new RegExp(
      `<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${key}["'][^>]*>`,
      'i',
    );
    const tag = re.exec(html);
    if (tag) {
      const value = attr(tag[0].replace(/^<meta\b/i, '').replace(/>$/, ''), 'content');
      if (value) return normSpace(value);
    }
  }
  return undefined;
}

/** Ordered content blocks, headings included, in document order. */
function toBlocks(html, baseUrl) {
  let work = stripInvisible(stripComments(html));

  work = work
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<h([1-6])\b[^>]*>/gi, '\n@@H$1@@')
    .replace(/<\/h[1-6]\s*>/gi, '\n');

  for (const tag of BLOCK_CLOSERS) {
    work = work.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '\n');
  }

  // Turn every remaining anchor into "text (href)" so links survive as text,
  // then strip whatever tags are left.
  work = work.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner) => {
    const text = normSpace(decodeEntities(stripTags(inner)));
    const href = attr(attrs, 'href');
    if (!href || !text) return ` ${text} `;
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return ` ${text} `;
    let abs = href;
    try { abs = new URL(href, baseUrl).href; } catch { abs = href; }
    return ` ${text} (${abs}) `;
  });

  work = decodeEntities(stripTags(work));

  const blocks = [];
  for (const rawLine of work.split('\n')) {
    const line = normSpace(rawLine);
    if (!line) continue;
    const head = /^@@H([1-6])@@\s*(.*)$/.exec(line);
    if (head) {
      const text = normSpace(head[2]);
      if (text) blocks.push({ tag: `h${head[1]}`, level: Number(head[1]), text });
      continue;
    }
    blocks.push({ tag: 'p', text: line });
  }
  return blocks;
}

/** Split ordered blocks into heading-delimited sections. */
function toSections(blocks) {
  const sections = [];
  let current = { level: 0, heading: '', text: [] };
  for (const block of blocks) {
    if (block.level) {
      if (current.heading || current.text.length) sections.push(current);
      current = { level: block.level, heading: block.text, text: [] };
    } else {
      current.text.push(block.text);
    }
  }
  if (current.heading || current.text.length) sections.push(current);
  return sections.map((s) => ({ ...s, text: s.text.join(' ').trim() }));
}

function toLinks(html, baseUrl, origin) {
  const seen = new Set();
  const links = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = attr(m[1], 'href');
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl); } catch { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    const key = `${abs.href}|${normSpace(decodeEntities(stripTags(m[2])))}`.slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    const text = normSpace(decodeEntities(stripTags(m[2])));
    if (!text || text.length > 160) continue;
    links.push({
      href: abs.href,
      text,
      sameOrigin: abs.origin === origin,
      external: abs.origin !== origin,
    });
  }
  return links;
}

/**
 * Extract everything the recon tools need from one fetched document.
 * `kind: 'html'` runs the full pipeline; `kind: 'text'` only normalises.
 */
export function extractPage(body, finalUrl) {
  const kind = body?.kind === 'text' ? 'text' : 'html';
  const raw = String(body?.content ?? '');
  let origin = '';
  try { origin = new URL(finalUrl).origin; } catch { origin = ''; }

  if (kind === 'text') {
    const blocks = raw
      .split(/\n{2,}/)
      .map((chunk) => normSpace(chunk))
      .filter(Boolean)
      .map((text) => ({ tag: 'p', text }));
    const text = blocks.map((b) => b.text).join('\n');
    return {
      kind,
      title: '',
      description: undefined,
      canonical: undefined,
      text,
      blocks,
      sections: [{ level: 0, heading: '', text }],
      outline: [],
      links: [],
      stats: { chars: text.length, blocks: blocks.length, links: 0, headings: 0, htmlBytes: raw.length },
    };
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch ? normSpace(decodeEntities(stripTags(titleMatch[1]))) : '';
  const canonicalTag = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(raw);
  const canonical = canonicalTag
    ? attr(canonicalTag[0].replace(/^<link\b/i, '').replace(/>$/, ''), 'href')
    : undefined;

  const blocks = toBlocks(raw, finalUrl);
  const outline = blocks.filter((b) => b.level).map((b) => ({ level: b.level, text: b.text }));
  const text = blocks
    .map((b) => (b.level ? `${'#'.repeat(b.level)} ${b.text}` : b.text))
    .join('\n');

  return {
    kind,
    title,
    description: metaContent(raw, ['description', 'og:description']),
    canonical,
    siteName: metaContent(raw, ['og:site_name']),
    text,
    blocks,
    sections: toSections(blocks),
    outline,
    links: toLinks(raw, finalUrl, origin),
    stats: {
      chars: text.length,
      blocks: blocks.length,
      links: 0,
      headings: outline.length,
      htmlBytes: raw.length,
    },
  };
}

const BLOCK_TITLE = /access denied|just a moment|attention required|are you a robot|enable javascript|403 forbidden|request unsuccessful|too many requests|verify you are human|cf-browser-verification/i;

/**
 * Decide whether a fetched page is usable evidence or a wall.
 * `blocked` means the body is not the page; `likelyJs` means the shell loaded
 * but the content did not, which is the signal to reach for a rendered capture.
 */
export function classifyPage({ status, title, text, htmlBytes, requestedUrl, finalUrl }) {
  const chars = (text || '').trim().length;
  const reasons = [];
  let blocked = false;
  let likelyJs = false;

  if (status && (status === 403 || status === 429 || status === 503)) {
    blocked = true;
    reasons.push(`HTTP ${status}`);
  }
  if (BLOCK_TITLE.test(title || '')) {
    blocked = true;
    reasons.push(`challenge title “${title}”`);
  }
  if (!blocked && chars < 200 && (htmlBytes || 0) > 4000) {
    likelyJs = true;
    reasons.push('thin text in a large document: content is probably client-rendered');
  }
  if (!blocked && !likelyJs && chars < 60) {
    blocked = true;
    reasons.push('almost no readable text');
  }
  if (requestedUrl && finalUrl && requestedUrl !== finalUrl) {
    reasons.push(`redirected to ${finalUrl}`);
  }

  return { blocked, likelyJs, chars, reasons };
}
