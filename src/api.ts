import type { FullReview, ReviewStatus, ReviewSummary } from '../db.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function listReviews(): Promise<ReviewSummary[]> {
  const res = await fetch('/api/reviews');
  return (await res.json()) as ReviewSummary[];
}

export async function getReview(id: string): Promise<FullReview> {
  const res = await fetch(`/api/reviews/${id}`);
  return (await res.json()) as FullReview;
}

export async function patchReview(
  id: string,
  body: { status?: ReviewStatus; title?: string; meta?: Record<string, unknown> },
): Promise<void> {
  await fetch(`/api/reviews/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export async function postComment(
  id: string,
  body: { part_id?: string; anchor?: string; body: string },
): Promise<void> {
  await fetch(`/api/reviews/${id}/comments`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export async function putPart(partId: string, edited: string): Promise<void> {
  await fetch(`/api/parts/${partId}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ edited }) });
}
