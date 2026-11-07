// Guards the privacy contract: the page may only talk to itself and to the
// model host. Inference is local; user text never leaves the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const web = new URL('../web/', import.meta.url);
const html = fs.readFileSync(new URL('index.html', web), 'utf8');

function csp() {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'index.html must declare a Content-Security-Policy');
  return Object.fromEntries(
    m[1].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]),
  );
}

test('CSP denies by default and limits connections to the model host', () => {
  const p = csp();
  assert.deepEqual(p['default-src'], ["'none'"]);
  assert.deepEqual(p['connect-src'], ["'self'", 'https://huggingface.co', 'https://*.hf.co']);
  assert.deepEqual(p['script-src'], ["'self'", "'wasm-unsafe-eval'", 'blob:']);
  assert.deepEqual(p['form-action'], ["'none'"]);
});

test('CSP is declared before any script or stylesheet', () => {
  const cspAt = html.indexOf('Content-Security-Policy');
  assert.ok(cspAt < html.indexOf('<link'));
  assert.ok(cspAt < html.indexOf('<script'));
});

test('no referrer is sent with the model download', () => {
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test('page loads no remote scripts, styles, images or fonts', () => {
  assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]+(src|href)="(https?:)?\/\//);
});

test('app code reaches no remote URL except the model repository', () => {
  for (const f of ['app.js', 'pfml.js']) {
    const src = fs.readFileSync(new URL(f, web), 'utf8');
    const urls = src.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
    for (const u of urls) {
      assert.equal(u, 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/', `${f}: ${u}`);
    }
  }
});
