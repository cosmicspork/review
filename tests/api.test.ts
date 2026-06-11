import { test, expect } from 'bun:test';
import { createDb } from '../db.ts';
import { createHandler, type Handler } from '../routes.ts';

function makeHandler(): Handler {
  const db = createDb(':memory:');
  return createHandler({
    db,
    repoRoot: '/tmp',
    indexHtml: '<html></html>',
    bundle: { js: null, err: null },
    diff2htmlCssPath: '/dev/null',
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const post = (h: Handler, p: string, b: unknown) =>
  h(new Request('http://x' + p, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(b) }));
const patch = (h: Handler, p: string, b: unknown) =>
  h(new Request('http://x' + p, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(b) }));
const get = (h: Handler, p: string) => h(new Request('http://x' + p));

test('POST with an adf part fills content via convert() and stores raw', async () => {
  const h = makeHandler();
  const created = await (
    await post(h, '/api/reviews', {
      title: 't',
      kind: 'ticket',
      parts: [
        {
          type: 'adf',
          adf: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] },
        },
      ],
    })
  ).json();
  const full = await (await get(h, '/api/reviews/' + created.id)).json();
  expect(full.parts[0].content).toContain('hello');
  expect(full.parts[0].raw).not.toBeNull();
});

test('malformed ADF stores fallback content and still returns 201', async () => {
  const h = makeHandler();
  const res = await post(h, '/api/reviews', { title: 't', kind: 'ticket', parts: [{ type: 'adf', adf: { not: 'valid' } }] });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const full = await (await get(h, '/api/reviews/' + id)).json();
  expect(full.parts[0].content).toContain('ADF preview unavailable');
  expect(full.parts[0].raw).not.toBeNull();
});

test('submit requires a title and a valid kind', async () => {
  const h = makeHandler();
  expect((await post(h, '/api/reviews', { kind: 'code', parts: [{ type: 'markdown', content: 'x' }] })).status).toBe(400);
  expect((await post(h, '/api/reviews', { title: 't', kind: 'bogus', parts: [{ type: 'markdown', content: 'x' }] })).status).toBe(400);
});

test('a diff part with a git spec but unresolvable repo is rejected', async () => {
  const h = makeHandler();
  const res = await post(h, '/api/reviews', {
    title: 't',
    kind: 'code',
    repo: '/not/under/root',
    parts: [{ type: 'diff', diff: { mode: 'worktree' } }],
  });
  expect(res.status).toBe(400);
});

test('?wait long-poll resolves when a PATCH lands mid-wait', async () => {
  const h = makeHandler();
  const { id } = await (await post(h, '/api/reviews', { title: 't', kind: 'code', parts: [{ type: 'markdown', content: 'x' }] })).json();
  // The GET /status handler registers its waiter synchronously (the Promise executor
  // runs before the first await), so the waiter exists by the time `get` returns its
  // promise — the subsequent PATCH resolves it with no real delay.
  const waitP = get(h, `/api/reviews/${id}/status?wait=5`).then((r) => r.text());
  await patch(h, `/api/reviews/${id}`, { status: 'approved' });
  expect(await waitP).toBe('approved');
});

test('?wait returns immediately when already terminal', async () => {
  const h = makeHandler();
  const { id } = await (await post(h, '/api/reviews', { title: 't', kind: 'code', parts: [{ type: 'markdown', content: 'x' }] })).json();
  await patch(h, `/api/reviews/${id}`, { status: 'rejected' });
  expect(await (await get(h, `/api/reviews/${id}/status?wait=5`)).text()).toBe('rejected');
});

test('revise resets to pending, keeps comments, replaces parts, adds agent note', async () => {
  const h = makeHandler();
  const { id } = await (await post(h, '/api/reviews', { title: 't', kind: 'code', parts: [{ type: 'markdown', content: 'x' }] })).json();
  await post(h, `/api/reviews/${id}/comments`, { body: 'first round' });
  await patch(h, `/api/reviews/${id}`, { status: 'changes_requested' });
  await post(h, `/api/reviews/${id}/revise`, { note: 'fixed it', parts: [{ type: 'markdown', content: 'y' }] });
  const full = await (await get(h, '/api/reviews/' + id)).json();
  expect(full.status).toBe('pending');
  expect(full.resolved_at).toBeNull();
  expect(full.comments.some((c: { body: string }) => c.body === 'first round')).toBe(true);
  expect(full.comments.some((c: { author: string; body: string }) => c.author === 'agent' && c.body === 'fixed it')).toBe(true);
  expect(full.parts.length).toBe(1);
  expect(full.parts[0].content).toBe('y');
});

test('PUT on a diff part returns 400; on a markdown part it persists', async () => {
  const h = makeHandler();
  const { id } = await (
    await post(h, '/api/reviews', {
      title: 't',
      kind: 'mr',
      parts: [
        { type: 'diff', patch: 'diff --git a/a b/a\n' },
        { type: 'markdown', content: 'desc' },
      ],
    })
  ).json();
  const full = await (await get(h, '/api/reviews/' + id)).json();
  const diffPart = full.parts.find((p: { type: string }) => p.type === 'diff');
  const mdPart = full.parts.find((p: { type: string }) => p.type === 'markdown');
  const putDiff = await h(
    new Request(`http://x/api/parts/${diffPart.id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ edited: 'no' }) }),
  );
  expect(putDiff.status).toBe(400);
  const putMd = await h(
    new Request(`http://x/api/parts/${mdPart.id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ edited: '# yes' }) }),
  );
  expect(putMd.status).toBe(200);
  const after = await (await get(h, '/api/reviews/' + id)).json();
  expect(after.parts.find((p: { id: string }) => p.id === mdPart.id).edited).toBe('# yes');
});

test('missing review returns 404', async () => {
  const h = makeHandler();
  expect((await get(h, '/api/reviews/nope')).status).toBe(404);
});
