import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createDb } from '../db.ts';

test('cleanup deletes resolved rows older than N days, keeps recent and pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-cl-'));
  const path = join(dir, 'c.sqlite');
  const db = createDb(path);
  db.insertReview({ id: 'old', repo: null, title: 'old', kind: 'code', meta: null });
  db.insertReview({ id: 'recent', repo: null, title: 'recent', kind: 'code', meta: null });
  db.insertReview({ id: 'pending', repo: null, title: 'pending', kind: 'code', meta: null });
  db.patchReview('old', { status: 'approved' });
  db.patchReview('recent', { status: 'approved' });

  // Backdate 'old' to 40 days ago through a second connection (resolved_at is otherwise "now").
  const raw = new Database(path);
  raw.query('UPDATE reviews SET resolved_at = ? WHERE id = ?').run(Date.now() - 40 * 86_400_000, 'old');
  raw.close();

  const deleted = db.cleanup({ olderThanDays: 30 });
  expect(deleted).toBe(1);
  expect(db.getStatus('old')).toBeNull();
  expect(db.getStatus('recent')).not.toBeNull();
  expect(db.getStatus('pending')).not.toBeNull();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('cleanup with a status filter only removes that status', () => {
  const db = createDb(':memory:');
  db.insertReview({ id: 'a', repo: null, title: 'a', kind: 'code', meta: null });
  db.insertReview({ id: 'b', repo: null, title: 'b', kind: 'code', meta: null });
  db.patchReview('a', { status: 'approved' });
  db.patchReview('b', { status: 'rejected' });
  const deleted = db.cleanup({ olderThanDays: 0, status: 'approved' });
  expect(deleted).toBe(1);
  expect(db.getStatus('a')).toBeNull();
  expect(db.getStatus('b')).not.toBeNull();
  db.close();
});
