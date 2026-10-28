// Verified screenshot capture over the Chrome DevTools Protocol.
// The capture is only accepted after the target has been measured, brought into
// frame, re-measured, tested for occlusion, and the saved file checked on disk.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { USER_AGENT, sleep } from './net.js';
import { ensureDir, writeJson } from './store.js';

class WebSocketLite extends EventEmitter {
  constructor(url) {
    super();
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
    this.pathname = parsed.pathname + (parsed.search || '');
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.socket = net.connect(this.port, this.host, () => {
        this.socket.write(
          `GET ${this.pathname} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.socket.on('error', reject);
      let upgraded = false;
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!upgraded) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = this.buffer.slice(0, end).toString('latin1');
          if (!/HTTP\/1\.1 101/.test(head)) {
            reject(new Error(`websocket handshake failed: ${head.split('\r\n')[0]}`));
            return;
          }
          upgraded = true;
          this.buffer = this.buffer.slice(end + 4);
          resolve();
        }
        this.drain();
      });
      this.socket.on('close', () => {
        this.closed = true;
        this.emit('close');
      });
    });
  }

  drain() {
    for (;;) {
      const buffer = this.buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.slice(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.buffer = buffer.slice(offset + length);

      if (opcode === 0x8) {
        this.closed = true;
        try { this.socket.end(); } catch { /* already gone */ }
        this.emit('close');
        return;
      }
      if (opcode === 0x9) this.frame(0xa, payload);
      else if (opcode !== 0xa) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', full);
        }
      }
    }
  }

  frame(opcode, payload) {
    if (this.closed) return;
    const length = payload.length;
    let head;
    if (length < 126) {
      head = Buffer.alloc(2);
      head[1] = 0x80 | length;
    } else if (length < 65536) {
      head = Buffer.alloc(4);
      head[1] = 0x80 | 126;
      head.writeUInt16BE(length, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(length), 2);
    }
    head[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
    try { this.socket.write(Buffer.concat([head, mask, body])); } catch { /* socket gone */ }
  }

  send(text) { this.frame(0x1, Buffer.from(text, 'utf8')); }

  close() {
    try {
      this.frame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch { /* already closed */ }
  }
}

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.on('message', (text) => {
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (message.id == null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 60000);
    });
  }
}

async function endpoint(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function probeBrowser(port = 9222) {
  try {
    const version = await endpoint(port);
    return { ok: true, port, browser: version.Browser, protocol: version['Protocol-Version'] };
  } catch (error) {
    return {
      ok: false,
      port,
      error: error.message,
      hint: `需要本机 Chrome 以调试端口启动，例如：chrome.exe --remote-debugging-port=${port} --user-data-dir=<空目录>`,
    };
  }
}

async function connectPage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  }
  const socket = new WebSocketLite(target.webSocketDebuggerUrl);
  await socket.connect();
  return new Devtools(socket);
}

async function evaluate(devtools, expression, awaitPromise = false) {
  const result = await devtools.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(`page script failed: ${detail.text || ''} ${detail.exception?.description || ''}`.trim());
  }
  return result.result.value;
}

const evalJson = async (devtools, expression, awaitPromise) =>
  JSON.parse(await evaluate(devtools, expression, awaitPromise));

const DISMISS_JS = `
(() => {
  const sels = ['#onetrust-accept-btn-handler','#onetrust-reject-all-handler','button[aria-label="Accept All Cookies"]',
    'button[data-testid="cookie-accept"]','#truste-consent-button','button.accept-all'];
  let clicked = null;
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) { try { el.click(); clicked = sel; } catch (e) {} break; }
  }
  return clicked;
})()`;

const HIDE_JS = `
(() => {
  const junk = ['#onetrust-consent-sdk','.optanon-alert-box-wrapper','#truste-consent-track','[id*=cookie-banner]',
    '.cookie-banner','#axeptio_overlay','#CybotCookiebotDialog','#embedded-messaging','.embeddedServiceHelpButton',
    '[id*=embeddedservice]','iframe[name*=chat]','iframe[title*=chat i]','iframe[title*=message i]','[class*=chat-widget]',
    '[id*=launcher]','#drift-frame-controller','#intercom-container','[class*=MessagingLauncher]'];
  junk.forEach((sel) => document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; }));
  document.querySelectorAll('body *').forEach((el) => {
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 120) return;
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (/need help\\? ask|ask me about|connect me with a sales rep|accept all cookies|we value your privacy/i.test(text)) {
      el.style.display = 'none';
    }
  });
  document.querySelectorAll('video').forEach((v) => { try { v.pause(); v.autoplay = false; } catch (e) {} });
  if (!document.getElementById('__recon_freeze')) {
    const style = document.createElement('style');
    style.id = '__recon_freeze';
    style.textContent = '*,*::before,*::after{animation-play-state:paused !important;transition:none !important;}';
    document.head.appendChild(style);
  }
  return 1;
})()`;

const SCROLL_THROUGH_JS = `
(async () => {
  const height = Math.min(document.documentElement.scrollHeight, 16000);
  const step = Math.max(400, Math.round(innerHeight * 0.75));
  for (let y = 0; y < height; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 110));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 500));
  return height;
})()`;

function findScript(text, selector) {
  return `
(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const text = ${JSON.stringify(text)};
  const sel = ${JSON.stringify(selector)};
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
  };
  let candidates = Array.from(document.querySelectorAll(sel)).filter(visible);
  if (!candidates.length) candidates = Array.from(document.querySelectorAll('body *')).filter(visible);
  const exact = candidates.filter((el) => norm(el.innerText) === text);
  const partial = candidates.filter((el) => norm(el.innerText).includes(text));
  let pool = exact.length ? exact : partial;
  pool = pool.filter((el) => el.getBoundingClientRect().width < innerWidth * 0.995);
  if (!pool.length) return JSON.stringify({ found: false, scanned: candidates.length });
  pool.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height;
  });
  const el = pool[0];
  const rect = el.getBoundingClientRect();
  return JSON.stringify({
    found: true, tag: el.tagName, text: norm(el.innerText).slice(0, 160),
    pageY: rect.top + scrollY,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom },
  });
})()`;
}

function checkScript(text) {
  return `
(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const text = ${JSON.stringify(text)};
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
  };
  const el = Array.from(document.querySelectorAll('body *')).filter(visible)
    .find((node) => norm(node.innerText).includes(text));
  if (!el) return JSON.stringify({ found: false });
  const rect = el.getBoundingClientRect();
  const points = [
    [rect.left + rect.width / 2, Math.max(0, rect.top + 6)],
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + rect.width / 2, Math.min(innerHeight - 2, rect.bottom - 6)],
  ];
  const hits = points.map((point) => (document.elementsFromPoint(point[0], point[1]) || [])
    .slice(0, 3).map((node) => ({ tag: node.tagName, text: norm(node.innerText || '').slice(0, 60) })));
  const blocker = /need help\\? ask|ask me about|connect me with a sales rep|accept all cookies|we value your privacy/i;
  const occluded = hits.flat().filter((hit) => blocker.test(hit.text));
  return JSON.stringify({
    found: true,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom },
    inFrame: rect.top >= -2 && rect.top < innerHeight - 30 && rect.bottom > 60 && rect.left > -2,
    occluded,
    viewport: { width: innerWidth, height: innerHeight },
  });
})()`;
}

/** Read width and height out of a PNG buffer, or report that it is not a PNG. */
export function pngInfo(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return { valid: false };
  return {
    valid: true,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
  };
}

async function settle(devtools, wait) {
  try {
    await evaluate(devtools, 'Promise.race([document.fonts?document.fonts.ready:Promise.resolve(1), new Promise(r=>setTimeout(r,2500))]).then(()=>1)', true);
  } catch { /* fonts are optional */ }
  await sleep(wait);
  await evaluate(devtools, HIDE_JS);
  await sleep(250);
}

/**
 * Capture one section. Returns a record; when `ok` is false the reason names the
 * measurement that failed, so the caller can change the target instead of guessing.
 */
export async function captureSection(options) {
  const {
    port = 9222,
    url,
    targetText,
    selector = 'h1,h2,h3,h4',
    top = 120,
    width = 1440,
    height = 900,
    wait = 6000,
    attempts = 2,
    outFile,
    workspace,
  } = options;

  const browser = await probeBrowser(port);
  if (!browser.ok) return { ok: false, reason: browser.error, hint: browser.hint, checks: {} };

  await opts_ensureDir(outFile);
  const record = {
    url, targetText, selector, viewport: { width, height },
    browser: browser.browser, attempts: [], file: outFile,
  };

  let devtools;
  try {
    devtools = await connectPage(port);
    await devtools.send('Page.enable');
    await devtools.send('Runtime.enable');
    await devtools.send('Network.enable');
    await devtools.send('Emulation.setUserAgentOverride', { userAgent: USER_AGENT, acceptLanguage: 'en-US,en;q=0.9' });
    await devtools.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await devtools.send('Page.navigate', { url });
    await sleep(wait);
    await evaluate(devtools, DISMISS_JS);
    await sleep(1200);
    await evaluate(devtools, HIDE_JS);
    await evaluate(devtools, SCROLL_THROUGH_JS, true);
    await evaluate(devtools, HIDE_JS);
    await sleep(600);
    record.title = await evaluate(devtools, 'document.title');
    record.finalUrl = await evaluate(devtools, 'location.href');

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptRecord = { attempt };
      const target = await evalJson(devtools, findScript(targetText, selector));
      attemptRecord.target = target;
      if (!target.found) {
        attemptRecord.error = `target text not found among ${selector}: “${targetText}”`;
        record.attempts.push(attemptRecord);
        await sleep(1200);
        continue;
      }

      const maxScroll = await evaluate(devtools, 'Math.max(0, document.documentElement.scrollHeight - innerHeight)');
      const desired = Math.max(0, Math.min(Number(maxScroll), target.pageY - Number(top)));
      await evaluate(devtools, `window.scrollTo(0, ${Math.round(desired)})`);
      await sleep(600);
      await settle(devtools, 400);

      const check = await evalJson(devtools, checkScript(targetText));
      attemptRecord.check = check;
      if (!check.found || !check.inFrame) {
        attemptRecord.error = `target not in frame after aligning to top=${top}`;
        record.attempts.push(attemptRecord);
        continue;
      }
      if (check.occluded && check.occluded.length) {
        attemptRecord.error = `target still covered by: ${check.occluded.map((o) => o.text).join(' / ')}`;
        record.attempts.push(attemptRecord);
        await evaluate(devtools, HIDE_JS);
        continue;
      }

      const shot = await devtools.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const bytes = Buffer.from(shot.data, 'base64');
      const info = pngInfo(bytes);
      attemptRecord.pixels = info;
      if (!info.valid) {
        attemptRecord.error = 'capture did not produce a readable PNG';
        record.attempts.push(attemptRecord);
        continue;
      }
      if (info.bytes < 25000) {
        attemptRecord.error = `frame is almost certainly blank (${info.bytes} bytes for ${info.width}x${info.height})`;
        record.attempts.push(attemptRecord);
        await sleep(1200);
        continue;
      }

      await fs.writeFile(outFile, bytes);
      attemptRecord.ok = true;
      record.attempts.push(attemptRecord);
      record.ok = true;
      record.file = outFile;
      record.target = { text: target.text, rect: check.rect, tag: target.tag };
      record.pixels = info;
      record.scrollY = await evaluate(devtools, 'window.scrollY');
      record.capturedAt = new Date().toISOString();
      if (workspace) {
        await ensureDir(path.join(workspace, 'captures'));
        await writeJson(`${outFile}.json`, record);
      }
      return record;
    }

    record.ok = false;
    record.reason = record.attempts[record.attempts.length - 1]?.error || 'capture failed';
    return record;
  } catch (error) {
    return { ok: false, reason: error.message, attempts: record.attempts, checks: {} };
  } finally {
    try { devtools?.socket.close(); } catch { /* nothing to close */ }
  }
}

async function opts_ensureDir(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}
