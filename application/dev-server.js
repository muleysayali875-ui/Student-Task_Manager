/**
 * Student Task Manager - Local Development Server
 * 
 * Runs the Cloudflare Worker (application/worker.js) locally on Node.js
 * with a persistent local Workers KV simulation.
 * 
 * Resolves the Windows `spawn EFTYPE` workerd limitation and provides
 * a seamless local testing environment on http://localhost:8787.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import worker from './worker.js';

const PORT = parseInt(process.env.PORT || '8787', 10);
const KV_FILE = path.resolve(process.cwd(), '.wrangler/local_kv.json');

/**
 * Local implementation of Cloudflare Workers KV Namespace.
 * Persists data to .wrangler/local_kv.json across server restarts.
 */
class LocalKVNamespace {
  constructor(filePath) {
    this.filePath = filePath;
    this.store = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data)) {
        this.store.set(k, v);
      }
    } catch (err) {
      console.warn('Could not read existing local KV file:', err.message);
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this.store.entries());
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Could not persist local KV file:', err.message);
    }
  }

  async get(key, options = {}) {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (options.type === 'json') {
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    }
    return val;
  }

  async put(key, value) {
    this.store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    this.save();
  }

  async delete(key) {
    this.store.delete(key);
    this.save();
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        keys.push({ name: k });
      }
    }
    return { keys, list_complete: true };
  }
}

const env = {
  TASKS_KV: new LocalKVNamespace(KV_FILE)
};

const server = http.createServer(async (req, res) => {
  const url = `http://${req.headers.host || `localhost:${PORT}`}${req.url}`;

  // Read request body for non-GET/HEAD methods
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = (req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0)
    ? Buffer.concat(chunks)
    : undefined;

  // Build standard Fetch Request
  const workerRequest = new Request(url, {
    method: req.method,
    headers: req.headers,
    body
  });

  try {
    // Execute worker.fetch
    const workerResponse = await worker.fetch(workerRequest, env);

    res.statusCode = workerResponse.status;
    for (const [key, value] of workerResponse.headers.entries()) {
      res.setHeader(key, value);
    }

    const resBuffer = await workerResponse.arrayBuffer();
    res.end(Buffer.from(resBuffer));

    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url} -> ${workerResponse.status}`);
  } catch (err) {
    console.error(`Error handling ${req.method} ${req.url}:`, err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` Student Task Manager — Local Worker Development Server`);
  console.log(` Running at: http://localhost:${PORT}`);
  console.log(` Local KV Store: ${KV_FILE}`);
  console.log(`======================================================\n`);
});
