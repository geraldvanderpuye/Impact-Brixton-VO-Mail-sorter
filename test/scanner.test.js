const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real scanner entry point with external services replaced. No
// Google credentials, customer data, HTTP server or cron jobs are used.
function scanner({ list, request, download, ocr, upload, connected } = {}) {
  const calls = { lists: 0, downloads: 0, uploads: 0, ingests: 0, idLoads: 0 };
  const module = { exports: {} };
  const dependencies = {
    dotenv: { config() {} },
    http: { createServer: () => ({}) },
    'node-cron': {},
    './auth': { isConnected: async () => connected !== false },
    './drive': {
      listNewPdfs: async ids => { calls.lists++; return list ? list(ids) : []; },
      downloadPdf: async () => { calls.downloads++; return download ? download() : Buffer.from('%PDF-'); },
    },
    './ocr': { processOcr: async () => ocr ? ocr() : ({ recipient: '', ocrText: '' }) },
    './storage': { uploadPdf: async () => { calls.uploads++; return upload ? upload() : 'incoming/test.pdf'; } },
    './runtime': {
      ...require('../src/runtime'),
      fetchWithDeadline: async (url, options) => {
        const ingest = options.method === 'POST';
        if (ingest) calls.ingests++; else calls.idLoads++;
        if (request) return request({ ingest, calls });
        return { ok: true, json: async () => ingest ? { success: true, mailId: 'mail-test' } : { ids: [] } };
      },
    },
    '../package.json': { version: 'test' },
  };
  const requireStub = name => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  };
  const context = vm.createContext({
    module, require: requireStub, process: { env: { INGEST_URL: 'https://example.invalid/api/mail/ingest', INGEST_SECRET: 'test' } },
    console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, Buffer, URL,
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8'), context);
  return { ...module.exports, calls };
}

test('Drive request failure releases the poll and retries successfully', async () => {
  let fail = true;
  const app = scanner({ list: () => { if (fail) throw Error('Drive timeout'); return []; } });
  await app.pollDrive();
  assert.equal((await app.healthSnapshot()).status, 'degraded');
  assert.equal((await app.healthSnapshot()).processing, false);
  fail = false;
  await app.pollDrive();
  assert.equal(app.calls.lists, 2);
  assert.equal((await app.healthSnapshot()).status, 'ok');
  assert.ok((await app.healthSnapshot()).lastSuccessfulPollAt);
});

test('no discovery or intake happens until processed IDs load successfully', async () => {
  const app = scanner({ request: ({ calls }) => calls.idLoads === 1
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ ids: ['already-recovered'] }) },
  list: ids => { assert.equal(ids.has('already-recovered'), true); return []; } });
  await app.pollDrive();
  assert.equal(app.calls.lists, 0);
  assert.equal((await app.healthSnapshot()).status, 'degraded');
  await app.pollDrive();
  assert.equal(app.calls.idLoads, 2);
  assert.equal(app.calls.downloads, 0);
  assert.equal(app.calls.ingests, 0);
  assert.equal((await app.healthSnapshot()).processed, 1);
});

test('an ambiguous ingest response does not mark a PDF processed; it is retried', async () => {
  const app = scanner({
    list: ids => ids.has('new-file') ? [] : [{ id: 'new-file', name: 'test.pdf' }],
    request: ({ ingest, calls }) => ({ ok: true, json: async () => !ingest ? { ids: [] }
      : calls.ingests === 1 ? {} : { success: true, mailId: 'confirmed-id' } }),
  });
  await app.pollDrive();
  assert.equal((await app.healthSnapshot()).processed, 0);
  assert.equal((await app.healthSnapshot()).status, 'degraded');
  await app.pollDrive();
  await app.pollDrive();
  assert.equal(app.calls.ingests, 2);
  assert.equal((await app.healthSnapshot()).processed, 1);
  assert.equal((await app.healthSnapshot()).status, 'ok');
});

test('OCR failure still preserves the PDF for staff review', async () => {
  const app = scanner({ list: () => [{ id: 'new-file', name: 'test.pdf' }], ocr: () => { throw Error('OCR failed'); } });
  await app.pollDrive();
  assert.equal(app.calls.uploads, 1);
  assert.equal(app.calls.ingests, 1);
});

test('a disconnected account is unhealthy and cannot begin discovery', async () => {
  const app = scanner({ connected: false });
  await app.pollDrive();
  assert.equal((await app.healthSnapshot()).status, 'disconnected');
  assert.equal(app.calls.lists, 0);
});

test('an overlapping cron tick does not start another Drive request', async () => {
  let finish;
  const app = scanner({ list: () => new Promise(resolve => { finish = resolve; }) });
  const active = app.pollDrive();
  await new Promise(setImmediate);
  try {
    assert.ok(finish);
    await app.pollDrive();
    assert.equal(app.calls.lists, 1);
  } finally {
    if (finish) finish([]);
    await active;
  }
});
