const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createStageGuard, fetchWithDeadline } = require('../src/runtime');

test('a stuck stage terminates the process instead of starting an overlapping poll', () => {
  const script = `
    const { createStageGuard } = require(${JSON.stringify(path.resolve(__dirname, '../src/runtime'))});
    const guard = createStageGuard({ timeoutMs: 30 });
    guard.run('drive-list', () => new Promise(() => {}));
    setTimeout(() => console.log('UNSAFE LATE WORK'), 100);
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /drive-list exceeded 30ms/);
  assert.doesNotMatch(child.stdout, /UNSAFE/);
});

test('successful and rejected stages both clear their watchdog and state', async () => {
  const guard = createStageGuard({ timeoutMs: 1000 });
  assert.equal(await guard.run('drive-list', async () => 7), 7);
  assert.equal(guard.snapshot(), null);
  await assert.rejects(guard.run('drive-list', async () => { throw Error('timeout'); }), /timeout/);
  assert.equal(guard.snapshot(), null);
  assert.equal(await guard.run('drive-list', async () => 8), 8);
});

test('a second operation cannot run concurrently with the first', async () => {
  const guard = createStageGuard({ timeoutMs: 1000 });
  let finish;
  const active = guard.run('ocr', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(guard.run('storage-upload', async () => {}), /Overlapping/);
  assert.equal(guard.snapshot().stage, 'ocr');
  finish();
  await active;
});

test('request deadline also preserves caller cancellation', async () => {
  const original = global.fetch;
  const controller = new AbortController();
  controller.abort();
  global.fetch = async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    assert.equal(options.method, 'GET');
    return 'checked';
  };
  try {
    assert.equal(await fetchWithDeadline('https://example.invalid', { signal: controller.signal, method: 'GET' }), 'checked');
  } finally { global.fetch = original; }
});
