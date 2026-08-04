import { test, expect } from 'bun:test';
import type { ReviewStatus, ReviewSummary } from '../db.ts';
import { diffNotices } from '../src/notify.ts';

function summary(id: string, status: ReviewStatus, title = id): ReviewSummary {
  return {
    id,
    repo: '/tmp/repo',
    title,
    kind: 'code',
    status,
    created_at: 1,
    updated_at: 2,
    counts: { parts: 1, comments: 0 },
  };
}

test('the first load is silent', () => {
  expect(diffNotices(null, [summary('a', 'pending'), summary('b', 'pending')])).toEqual([]);
});

test('an unseen pending review reads as new', () => {
  const notices = diffNotices([summary('a', 'pending')], [summary('b', 'pending', 'Fresh'), summary('a', 'pending')]);
  expect(notices).toEqual([{ id: 'b', kind: 'new', title: 'Fresh' }]);
});

test('a terminal review flipped back to pending reads as a re-review', () => {
  for (const was of ['changes_requested', 'rejected', 'approved'] as const) {
    const notices = diffNotices([summary('a', was)], [summary('a', 'pending', 'Round two')]);
    expect(notices).toEqual([{ id: 'a', kind: 'rereview', title: 'Round two' }]);
  }
});

test("a human's own verdict does not notify", () => {
  expect(diffNotices([summary('a', 'pending')], [summary('a', 'approved')])).toEqual([]);
  expect(diffNotices([summary('a', 'pending')], [summary('a', 'changes_requested')])).toEqual([]);
});

test('an unchanged queue notifies nothing', () => {
  const list = [summary('a', 'pending'), summary('b', 'approved')];
  expect(diffNotices(list, list)).toEqual([]);
});

test('a review still sitting resolved notifies nothing', () => {
  expect(diffNotices([summary('a', 'approved')], [summary('a', 'approved')])).toEqual([]);
});

test('a deleted review notifies nothing', () => {
  expect(diffNotices([summary('a', 'pending'), summary('b', 'pending')], [summary('a', 'pending')])).toEqual([]);
});

test('several arrivals in one fetch each notify', () => {
  const notices = diffNotices(
    [summary('a', 'rejected')],
    [summary('a', 'pending', 'Revised'), summary('b', 'pending', 'Brand new')],
  );
  expect(notices).toEqual([
    { id: 'a', kind: 'rereview', title: 'Revised' },
    { id: 'b', kind: 'new', title: 'Brand new' },
  ]);
});
