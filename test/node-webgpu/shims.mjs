// Browser-environment shims so @mlc-ai/web-llm runs under Node via Dawn.
//
// Loading this module sets up:
//   - navigator.gpu      (Dawn, via the `webgpu` npm package)
//   - caches             (filesystem-backed Cache API for model weights)
//   - indexedDB          (fake-indexeddb/auto)
//   - window/self/location/document/createRequire  (minimal DOM)
//   - __esmDirname/__esmFilename/__nodeRequireEsc  (CJS-marker replacements
//     that pair with patch.mjs — the Web-LLM bundle must be patched first)
//
// Plain `import './shims.mjs'` before any Web-LLM import is all you need.
//
// Cache location: <repo>/.webllm-cache/ — override via WEBLLM_CACHE_DIR.

import 'fake-indexeddb/auto';
import { create, globals } from 'webgpu';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire as nodeCreateRequire } from 'node:module';

const CACHE_ROOT = process.env.WEBLLM_CACHE_DIR || join(process.cwd(), '.webllm-cache');

// ---------- GPU ----------
Object.assign(globalThis, globals);  // GPUBufferUsage, GPUTextureUsage, …
Object.defineProperty(globalThis, 'navigator', {
  value: { gpu: create([]), userAgent: 'node-dawn' },
  writable: true, configurable: true,
});

// ---------- DOM-ish ----------
// `window` present forces Emscripten's env detection toward the web branch
// for the parts of TVM's runtime that want it; other parts independently
// check ENVIRONMENT_IS_NODE and the bundle patch handles those.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.location = { href: 'file:///' + process.cwd() + '/' };
globalThis.document = undefined;

// ---------- CJS shims paired with patch.mjs renames ----------
const nodeRequire = nodeCreateRequire(import.meta.url);
globalThis.__nodeRequireEsc = (name) => nodeRequire(name);
globalThis.__esmDirname  = process.cwd();
globalThis.__esmFilename = process.cwd() + '/web-llm.js';
globalThis.createRequire = nodeCreateRequire;

// ---------- Cache API (filesystem-backed) ----------
// Web-LLM's ArtifactCache calls caches.open(scope).match/add/keys/delete.
// We back each scope with <CACHE_ROOT>/<scopeHash>/ containing <urlHash>.body
// and <urlHash>.meta pairs.

function h(s) { return createHash('sha256').update(s).digest('hex').slice(0, 32); }

class FsCache {
  constructor(scope) {
    this.scope = scope;
    this.dir = join(CACHE_ROOT, h(scope));
    mkdirSync(this.dir, { recursive: true });
  }
  _paths(url) {
    const base = join(this.dir, h(url));
    return { body: base + '.body', meta: base + '.meta' };
  }
  async match(req) {
    const url = typeof req === 'string' ? req : req.url;
    const { body, meta } = this._paths(url);
    if (!existsSync(body) || !existsSync(meta)) return undefined;
    const headers = JSON.parse(readFileSync(meta, 'utf8'));
    return new Response(readFileSync(body), { status: 200, headers });
  }
  async add(req) {
    const url = typeof req === 'string' ? req : req.url;
    const { body, meta } = this._paths(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    writeFileSync(body, Buffer.from(await res.arrayBuffer()));
    const headers = Object.fromEntries(res.headers.entries());
    headers._url = url;
    writeFileSync(meta, JSON.stringify(headers));
  }
  async keys() {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.meta'));
    return files.flatMap(f => {
      try {
        const m = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
        return m._url ? [new Request(m._url)] : [];
      } catch { return []; }
    });
  }
  async delete(req) {
    const url = typeof req === 'string' ? req : req.url;
    const { body, meta } = this._paths(url);
    let hit = false;
    for (const p of [body, meta]) if (existsSync(p)) { unlinkSync(p); hit = true; }
    return hit;
  }
}

const _caches = new Map();
globalThis.caches = {
  async open(scope) {
    if (!_caches.has(scope)) _caches.set(scope, new FsCache(scope));
    return _caches.get(scope);
  },
  async has(scope) { return _caches.has(scope); },
  async delete(scope) { _caches.delete(scope); return true; },
};
