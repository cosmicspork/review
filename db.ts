import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected';
export type ReviewKind = 'code' | 'mr' | 'pr' | 'ticket';
export type PartType = 'diff' | 'markdown' | 'adf';

export const TERMINAL_STATUSES: readonly ReviewStatus[] = ['approved', 'changes_requested', 'rejected'];

export interface ReviewPart {
  id: string;
  review_id: string;
  seq: number;
  type: PartType;
  label: string | null;
  content: string;
  raw: string | null;
  edited: string | null;
}

export interface ReviewComment {
  id: string;
  review_id: string;
  part_id: string | null;
  anchor: string | null;
  body: string;
  author: string;
  created_at: number;
}

export interface ReviewSummary {
  id: string;
  repo: string | null;
  title: string;
  kind: ReviewKind;
  status: ReviewStatus;
  created_at: number;
  updated_at: number;
  counts: { parts: number; comments: number };
}

export interface FullReview {
  id: string;
  repo: string | null;
  title: string;
  kind: ReviewKind;
  status: ReviewStatus;
  meta: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  parts: ReviewPart[];
  comments: ReviewComment[];
}

export interface InsertReviewInput {
  id: string;
  repo: string | null;
  title: string;
  kind: ReviewKind;
  meta: Record<string, unknown> | null;
}

export interface InsertPartInput {
  id: string;
  review_id: string;
  seq: number;
  type: PartType;
  label: string | null;
  content: string;
  raw: string | null;
}

export interface AddCommentInput {
  id: string;
  review_id: string;
  part_id: string | null;
  anchor: string | null;
  body: string;
  author: string;
}

export interface PatchReviewInput {
  status?: ReviewStatus;
  title?: string;
  meta?: Record<string, unknown> | null;
}

export interface CleanupInput {
  olderThanDays: number;
  status?: ReviewStatus;
}

export interface ReviewDb {
  insertReview(input: InsertReviewInput): void;
  insertPart(input: InsertPartInput): void;
  replaceParts(reviewId: string, parts: InsertPartInput[]): void;
  listReviews(): ReviewSummary[];
  getReview(id: string): FullReview | null;
  getStatus(id: string): ReviewStatus | null;
  getPartType(id: string): PartType | null;
  patchReview(id: string, input: PatchReviewInput): ReviewStatus | null;
  putPart(id: string, edited: string): boolean;
  addComment(input: AddCommentInput): void;
  deleteReview(id: string): boolean;
  cleanup(input: CleanupInput): number;
  tx(fn: () => void): void;
  close(): void;
}

interface ReviewRow {
  id: string;
  repo: string | null;
  title: string;
  kind: ReviewKind;
  status: ReviewStatus;
  meta: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface SummaryRow {
  id: string;
  repo: string | null;
  title: string;
  kind: ReviewKind;
  status: ReviewStatus;
  created_at: number;
  updated_at: number;
  parts: number;
  comments: number;
}

const DAY_MS = 86_400_000;

export function createDb(path: string): ReviewDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      repo TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      meta TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS parts (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      content TEXT NOT NULL,
      raw TEXT,
      edited TEXT
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      part_id TEXT,
      anchor TEXT,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_sort ON reviews(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_parts_review ON parts(review_id, seq);
    CREATE INDEX IF NOT EXISTS idx_comments_review ON comments(review_id, created_at);
  `);

  const stmts = {
    insertReview: db.query(
      `INSERT INTO reviews (id, repo, title, kind, status, meta, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL)`,
    ),
    insertPart: db.query(
      `INSERT INTO parts (id, review_id, seq, type, label, content, raw, edited)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ),
    deletePartsByReview: db.query(`DELETE FROM parts WHERE review_id = ?`),
    listReviews: db.query(
      `SELECT r.id, r.repo, r.title, r.kind, r.status, r.created_at, r.updated_at,
              (SELECT COUNT(*) FROM parts p WHERE p.review_id = r.id) AS parts,
              (SELECT COUNT(*) FROM comments c WHERE c.review_id = r.id) AS comments
       FROM reviews r
       ORDER BY (CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END), r.updated_at DESC`,
    ),
    getReview: db.query(`SELECT * FROM reviews WHERE id = ?`),
    getParts: db.query(`SELECT * FROM parts WHERE review_id = ? ORDER BY seq ASC`),
    getComments: db.query(`SELECT * FROM comments WHERE review_id = ? ORDER BY created_at ASC`),
    getStatus: db.query(`SELECT status FROM reviews WHERE id = ?`),
    getPartType: db.query(`SELECT type FROM parts WHERE id = ?`),
    putPart: db.query(`UPDATE parts SET edited = ? WHERE id = ?`),
    touchByPart: db.query(
      `UPDATE reviews SET updated_at = ? WHERE id = (SELECT review_id FROM parts WHERE id = ?)`,
    ),
    addComment: db.query(
      `INSERT INTO comments (id, review_id, part_id, anchor, body, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    touchReview: db.query(`UPDATE reviews SET updated_at = ? WHERE id = ?`),
    deleteReview: db.query(`DELETE FROM reviews WHERE id = ?`),
  };

  const insertReview = (input: InsertReviewInput): void => {
    const now = Date.now();
    stmts.insertReview.run(
      input.id,
      input.repo,
      input.title,
      input.kind,
      input.meta == null ? null : JSON.stringify(input.meta),
      now,
      now,
    );
  };

  const insertPart = (input: InsertPartInput): void => {
    stmts.insertPart.run(
      input.id,
      input.review_id,
      input.seq,
      input.type,
      input.label,
      input.content,
      input.raw,
    );
  };

  return {
    insertReview,
    insertPart,

    replaceParts(reviewId, parts) {
      const run = db.transaction((rows: InsertPartInput[]) => {
        stmts.deletePartsByReview.run(reviewId);
        for (const p of rows) insertPart(p);
      });
      run(parts);
    },

    listReviews() {
      const rows = stmts.listReviews.all() as SummaryRow[];
      return rows.map((r) => ({
        id: r.id,
        repo: r.repo,
        title: r.title,
        kind: r.kind,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        counts: { parts: r.parts, comments: r.comments },
      }));
    },

    getReview(id) {
      const row = stmts.getReview.get(id) as ReviewRow | null;
      if (!row) return null;
      return {
        id: row.id,
        repo: row.repo,
        title: row.title,
        kind: row.kind,
        status: row.status,
        meta: row.meta == null ? null : (JSON.parse(row.meta) as Record<string, unknown>),
        created_at: row.created_at,
        updated_at: row.updated_at,
        resolved_at: row.resolved_at,
        parts: stmts.getParts.all(id) as ReviewPart[],
        comments: stmts.getComments.all(id) as ReviewComment[],
      };
    },

    getStatus(id) {
      const row = stmts.getStatus.get(id) as { status: ReviewStatus } | null;
      return row ? row.status : null;
    },

    getPartType(id) {
      const row = stmts.getPartType.get(id) as { type: PartType } | null;
      return row ? row.type : null;
    },

    patchReview(id, input) {
      const current = stmts.getStatus.get(id) as { status: ReviewStatus } | null;
      if (!current) return null;
      const sets: string[] = [];
      const values: unknown[] = [];
      let nextStatus = current.status;
      if (input.status !== undefined) {
        nextStatus = input.status;
        sets.push('status = ?');
        values.push(input.status);
        sets.push('resolved_at = ?');
        values.push(TERMINAL_STATUSES.includes(input.status) ? Date.now() : null);
      }
      if (input.title !== undefined) {
        sets.push('title = ?');
        values.push(input.title);
      }
      if (input.meta !== undefined) {
        sets.push('meta = ?');
        values.push(input.meta == null ? null : JSON.stringify(input.meta));
      }
      sets.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      db.query(`UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`).run(...(values as never[]));
      return nextStatus;
    },

    putPart(id, edited) {
      const result = stmts.putPart.run(edited, id);
      if (result.changes === 0) return false;
      stmts.touchByPart.run(Date.now(), id);
      return true;
    },

    addComment(input) {
      stmts.addComment.run(
        input.id,
        input.review_id,
        input.part_id,
        input.anchor,
        input.body,
        input.author,
        Date.now(),
      );
      stmts.touchReview.run(Date.now(), input.review_id);
    },

    deleteReview(id) {
      return stmts.deleteReview.run(id).changes > 0;
    },

    cleanup({ olderThanDays, status }) {
      const cutoff = Date.now() - olderThanDays * DAY_MS;
      if (status) {
        return db
          .query(`DELETE FROM reviews WHERE resolved_at IS NOT NULL AND resolved_at <= ? AND status = ?`)
          .run(cutoff, status).changes;
      }
      return db
        .query(`DELETE FROM reviews WHERE resolved_at IS NOT NULL AND resolved_at <= ?`)
        .run(cutoff).changes;
    },

    tx(fn) {
      db.transaction(fn)();
    },

    close() {
      db.close();
    },
  };
}
