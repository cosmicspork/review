import { convert } from 'adf-to-md';
import {
  captureDiff,
  resolveRepo,
  HttpError,
  type DiffSpec,
} from './git.ts';
import type { InsertPartInput, ReviewDb, ReviewKind, ReviewStatus } from './db.ts';

export interface AppBundle {
  js: string | null;
  err: string | null;
}

export interface SseEvent {
  kind: 'add' | 'update' | 'remove';
  id: string;
}

export interface HandlerDeps {
  db: ReviewDb;
  repoRoot: string;
  indexHtml: string;
  bundle: AppBundle;
  diff2htmlCssPath: string;
}

export type Handler = (req: Request) => Promise<Response>;

const KINDS: readonly ReviewKind[] = ['code', 'mr', 'pr', 'ticket'];
const STATUSES: readonly ReviewStatus[] = ['pending', 'approved', 'changes_requested', 'rejected'];

const bad = (status: number, message: string): Response => new Response(message, { status });

async function parseJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

// Shared by submit + revise: turn the request's `parts` array into rows, capturing
// git diffs and converting ADF. `captureRepo` is the resolved repo path (or null when
// no part needs a git capture).
async function buildPartRows(
  reviewId: string,
  parts: unknown,
  captureRepo: string | null,
): Promise<InsertPartInput[]> {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new HttpError(400, 'parts must be a non-empty array');
  }
  const rows: InsertPartInput[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as Record<string, unknown>;
    const id = crypto.randomUUID();
    const label = typeof part.label === 'string' ? part.label : null;
    const seq = i;

    if (part.type === 'diff') {
      let content: string;
      if (typeof part.patch === 'string') {
        content = part.patch;
      } else if (part.diff && typeof part.diff === 'object') {
        if (!captureRepo) throw new HttpError(400, 'diff part needs a resolvable repo');
        content = await captureDiff(captureRepo, part.diff as DiffSpec);
      } else {
        throw new HttpError(400, 'diff part needs a `diff` spec or a `patch` string');
      }
      rows.push({ id, review_id: reviewId, seq, type: 'diff', label, content, raw: null });
    } else if (part.type === 'markdown') {
      if (typeof part.content !== 'string') throw new HttpError(400, 'markdown part needs `content`');
      rows.push({ id, review_id: reviewId, seq, type: 'markdown', label, content: part.content, raw: null });
    } else if (part.type === 'adf') {
      if (part.adf == null || typeof part.adf !== 'object') throw new HttpError(400, 'adf part needs an `adf` object');
      const raw = JSON.stringify(part.adf);
      let content: string;
      try {
        const { result, warnings } = convert(part.adf);
        content = result;
        if (warnings.size) console.warn('[review] adf-to-md warnings:', [...warnings].join(', '));
      } catch {
        content = '_(ADF preview unavailable — see raw)_';
      }
      rows.push({ id, review_id: reviewId, seq, type: 'adf', label, content, raw });
    } else {
      throw new HttpError(400, `unknown part type: ${String(part.type)}`);
    }
  }
  return rows;
}

export function createHandler(deps: HandlerDeps): Handler {
  const { db, repoRoot, indexHtml, bundle, diff2htmlCssPath } = deps;
  const sseClients = new Set<(e: SseEvent) => void>();
  const statusWaiters = new Map<string, Set<(s: string) => void>>();

  const broadcast = (e: SseEvent): void => {
    for (const send of sseClients) send(e);
  };
  const notifyStatus = (id: string, status: string): void => {
    const set = statusWaiters.get(id);
    if (!set) return;
    statusWaiters.delete(id);
    for (const resolve of set) resolve(status);
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      if (method === 'GET' && path === '/') {
        return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (method === 'GET' && path === '/app.js') {
        if (bundle.js) {
          return new Response(bundle.js, {
            headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
          });
        }
        return new Response(
          `// review: app bundle failed to build\nconsole.error(${JSON.stringify(bundle.err ?? 'unknown error')});`,
          { status: 500, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } },
        );
      }

      if (method === 'GET' && path === '/vendor/diff2html.css') {
        return new Response(Bun.file(diff2htmlCssPath), { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
      }

      if (method === 'GET' && path === '/api/events') {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (event: SseEvent): void => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {}
            };
            controller.enqueue(enc.encode(`: connected\n\n`));
            sseClients.add(send);
            const keepalive = setInterval(() => {
              try {
                controller.enqueue(enc.encode(`: ping\n\n`));
              } catch {}
            }, 30000);
            req.signal.addEventListener('abort', () => {
              clearInterval(keepalive);
              sseClients.delete(send);
              try {
                controller.close();
              } catch {}
            });
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      if (method === 'GET' && path === '/api/reviews') {
        return Response.json(db.listReviews());
      }

      if (method === 'POST' && path === '/api/reviews') {
        const body = await parseJson(req);
        const title = body.title;
        const kind = body.kind as ReviewKind;
        if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, 'title is required');
        if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
        const parts = body.parts;
        if (!Array.isArray(parts) || parts.length === 0) throw new HttpError(400, 'parts must be a non-empty array');

        const needsRepo = parts.some(
          (p) => (p as Record<string, unknown>).type === 'diff' && typeof (p as Record<string, unknown>).patch !== 'string',
        );
        let storeRepo: string | null = null;
        if (needsRepo) storeRepo = resolveRepo(typeof body.repo === 'string' ? body.repo : '', repoRoot);
        else if (typeof body.repo === 'string' && body.repo) storeRepo = body.repo;

        const id = crypto.randomUUID();
        const rows = await buildPartRows(id, parts, storeRepo);
        const meta = (body.meta as Record<string, unknown> | undefined) ?? null;
        db.tx(() => {
          db.insertReview({ id, repo: storeRepo, title, kind, meta });
          for (const r of rows) db.insertPart(r);
        });
        broadcast({ kind: 'add', id });
        return Response.json({ id }, { status: 201 });
      }

      const idMatch = path.match(/^\/api\/reviews\/([^/]+)(\/status|\/comments|\/revise)?$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const sub = idMatch[2];

        if (!sub && method === 'GET') {
          const review = db.getReview(id);
          return review ? Response.json(review) : bad(404, 'not found');
        }

        if (!sub && method === 'PATCH') {
          const body = await parseJson(req);
          const patch: { status?: ReviewStatus; title?: string; meta?: Record<string, unknown> | null } = {};
          if (body.status !== undefined) {
            if (!STATUSES.includes(body.status as ReviewStatus)) throw new HttpError(400, 'invalid status');
            patch.status = body.status as ReviewStatus;
          }
          if (typeof body.title === 'string') patch.title = body.title;
          if (body.meta !== undefined) patch.meta = (body.meta as Record<string, unknown> | null) ?? null;
          const next = db.patchReview(id, patch);
          if (next === null) return bad(404, 'not found');
          if (patch.status !== undefined) {
            notifyStatus(id, next);
            broadcast({ kind: 'update', id });
          }
          return Response.json({ status: next });
        }

        if (!sub && method === 'DELETE') {
          if (!db.deleteReview(id)) return bad(404, 'not found');
          broadcast({ kind: 'remove', id });
          return new Response(null, { status: 204 });
        }

        if (sub === '/status' && method === 'GET') {
          const cur = db.getStatus(id);
          if (cur == null) return bad(404, 'not found');
          const waitS = Math.min(Number(url.searchParams.get('wait')) || 0, 50);
          if (!waitS || cur !== 'pending') {
            return new Response(cur, { headers: { 'Content-Type': 'text/plain' } });
          }
          const final = await new Promise<string>((resolve) => {
            const set = statusWaiters.get(id) ?? new Set<(s: string) => void>();
            statusWaiters.set(id, set);
            const done = (s: string): void => {
              clearTimeout(timer);
              set.delete(done);
              resolve(s);
            };
            const timer = setTimeout(() => done(cur), waitS * 1000);
            set.add(done);
            req.signal.addEventListener('abort', () => done(cur));
          });
          return new Response(final, { headers: { 'Content-Type': 'text/plain' } });
        }

        if (sub === '/comments' && method === 'POST') {
          if (db.getStatus(id) == null) return bad(404, 'not found');
          const body = await parseJson(req);
          if (typeof body.body !== 'string' || !body.body.trim()) throw new HttpError(400, 'comment body is required');
          db.addComment({
            id: crypto.randomUUID(),
            review_id: id,
            part_id: typeof body.part_id === 'string' ? body.part_id : null,
            anchor: typeof body.anchor === 'string' ? body.anchor : null,
            body: body.body,
            author: typeof body.author === 'string' ? body.author : 'human',
          });
          broadcast({ kind: 'update', id });
          return Response.json({ ok: true }, { status: 201 });
        }

        if (sub === '/revise' && method === 'POST') {
          const review = db.getReview(id);
          if (!review) return bad(404, 'not found');
          const body = await parseJson(req);
          const parts = body.parts;
          if (Array.isArray(parts) && parts.length > 0) {
            const needsRepo = parts.some(
              (p) =>
                (p as Record<string, unknown>).type === 'diff' &&
                typeof (p as Record<string, unknown>).patch !== 'string',
            );
            const captureRepo = needsRepo
              ? resolveRepo(typeof body.repo === 'string' ? body.repo : (review.repo ?? ''), repoRoot)
              : review.repo;
            const rows = await buildPartRows(id, parts, captureRepo);
            db.replaceParts(id, rows);
          }
          const mergedMeta =
            body.meta && typeof body.meta === 'object'
              ? { ...(review.meta ?? {}), ...(body.meta as Record<string, unknown>) }
              : review.meta;
          db.patchReview(id, { status: 'pending', meta: mergedMeta });
          if (typeof body.note === 'string' && body.note.trim()) {
            db.addComment({
              id: crypto.randomUUID(),
              review_id: id,
              part_id: null,
              anchor: null,
              body: body.note,
              author: 'agent',
            });
          }
          notifyStatus(id, 'pending');
          broadcast({ kind: 'update', id });
          return Response.json({ status: 'pending' });
        }
      }

      const partMatch = path.match(/^\/api\/parts\/([^/]+)$/);
      if (partMatch && method === 'PUT') {
        const partId = decodeURIComponent(partMatch[1]);
        const type = db.getPartType(partId);
        if (type == null) return bad(404, 'not found');
        if (type === 'diff') return bad(400, 'diff parts are not editable');
        const body = await parseJson(req);
        if (typeof body.edited !== 'string') throw new HttpError(400, '`edited` must be a string');
        db.putPart(partId, body.edited);
        return Response.json({ ok: true });
      }

      if (method === 'POST' && path === '/api/cleanup') {
        const body = await parseJson(req);
        if (typeof body.olderThanDays !== 'number') throw new HttpError(400, '`olderThanDays` must be a number');
        const status = typeof body.status === 'string' ? (body.status as ReviewStatus) : undefined;
        const deleted = db.cleanup({ olderThanDays: body.olderThanDays, status });
        return Response.json({ deleted });
      }

      return bad(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return new Response(e.message, { status: e.status });
      console.error('[review] unhandled error:', e);
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
    }
  };
}
