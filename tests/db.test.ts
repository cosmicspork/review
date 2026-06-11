import { test, expect } from 'bun:test';
import { createDb } from '../db.ts';

test('patchReview sets resolved_at on a terminal status and clears it on pending', () => {
  const db = createDb(':memory:');
  db.insertReview({ id: 'r1', repo: null, title: 'A', kind: 'code', meta: null });
  db.patchReview('r1', { status: 'approved' });
  expect(db.getReview('r1')!.resolved_at).not.toBeNull();
  db.patchReview('r1', { status: 'pending' });
  expect(db.getReview('r1')!.resolved_at).toBeNull();
  db.close();
});

test('patchReview returns null for a missing review', () => {
  const db = createDb(':memory:');
  expect(db.patchReview('nope', { status: 'approved' })).toBeNull();
  db.close();
});

test('listReviews sorts pending first, then by updated_at desc', () => {
  const db = createDb(':memory:');
  db.insertReview({ id: 'resolved', repo: null, title: 'r', kind: 'code', meta: null });
  db.insertReview({ id: 'pending', repo: null, title: 'p', kind: 'code', meta: null });
  db.patchReview('resolved', { status: 'approved' });
  const ids = db.listReviews().map((r) => r.id);
  expect(ids[0]).toBe('pending');
  expect(ids[ids.length - 1]).toBe('resolved');
  db.close();
});

test('getPartType resolves type and putPart reports a missing part', () => {
  const db = createDb(':memory:');
  db.insertReview({ id: 'r', repo: null, title: 't', kind: 'code', meta: null });
  db.insertPart({ id: 'p', review_id: 'r', seq: 0, type: 'diff', label: null, content: 'x', raw: null });
  expect(db.getPartType('p')).toBe('diff');
  expect(db.getPartType('nope')).toBeNull();
  expect(db.putPart('nope', 'x')).toBe(false);
  expect(db.putPart('p', 'edited')).toBe(true);
  db.close();
});

test('replaceParts swaps parts but keeps comments', () => {
  const db = createDb(':memory:');
  db.insertReview({ id: 'r', repo: null, title: 't', kind: 'code', meta: null });
  db.insertPart({ id: 'p1', review_id: 'r', seq: 0, type: 'markdown', label: null, content: 'old', raw: null });
  db.addComment({ id: 'c1', review_id: 'r', part_id: null, anchor: null, body: 'keep me', author: 'human' });
  db.replaceParts('r', [{ id: 'p2', review_id: 'r', seq: 0, type: 'markdown', label: null, content: 'new', raw: null }]);
  const full = db.getReview('r')!;
  expect(full.parts.length).toBe(1);
  expect(full.parts[0].content).toBe('new');
  expect(full.comments.some((c) => c.body === 'keep me')).toBe(true);
  db.close();
});

test('deleting a review cascades to parts and comments', () => {
  const db = createDb(':memory:');
  db.insertReview({ id: 'r', repo: null, title: 't', kind: 'code', meta: null });
  db.insertPart({ id: 'p', review_id: 'r', seq: 0, type: 'markdown', label: null, content: 'x', raw: null });
  db.addComment({ id: 'c', review_id: 'r', part_id: null, anchor: null, body: 'b', author: 'human' });
  expect(db.deleteReview('r')).toBe(true);
  expect(db.getReview('r')).toBeNull();
  expect(db.getPartType('p')).toBeNull();
  db.close();
});
