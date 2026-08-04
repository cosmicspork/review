import type { ReviewSummary } from '../db.ts';

export type NoticeKind = 'new' | 'rereview';
export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
}

const NOTICE_TITLE: Record<NoticeKind, string> = {
  new: 'New review',
  rereview: 'Ready for re-review',
};

export const PREF_KEY = 'review-notify';
const BASE_TITLE = 'review · pre-publish queue';

// The two moments worth interrupting a human for, derived by diffing consecutive
// queue fetches rather than from SSE payloads — a dropped stream then costs at most
// a delay, not a missed notice. `prev == null` is the first load, which is never
// announced. Only an agent can drive either transition: the verdict bar emits
// terminal statuses only, so a human's own click can't notify them.
export function diffNotices(prev: ReviewSummary[] | null, next: ReviewSummary[]): Notice[] {
  if (!prev) return [];
  const before = new Map(prev.map((r) => [r.id, r.status]));
  const notices: Notice[] = [];
  for (const r of next) {
    if (r.status !== 'pending') continue;
    const was = before.get(r.id);
    if (was === undefined) notices.push({ id: r.id, kind: 'new', title: r.title });
    else if (was !== 'pending') notices.push({ id: r.id, kind: 'rereview', title: r.title });
  }
  return notices;
}

export function noticeLabel(kind: NoticeKind): string {
  return NOTICE_TITLE[kind];
}

export function notifySupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notifyPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {}
}

export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!notifySupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

// Skipped while the human is already looking at the queue — the toast and the badge
// carry it from there.
export function showNotice(notice: Notice, onClick: (id: string) => void): void {
  if (!notifySupported() || !notifyPref() || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const n = new Notification(noticeLabel(notice.kind), { body: notice.title, tag: notice.id });
    n.onclick = () => {
      window.focus();
      n.close();
      onClick(notice.id);
    };
  } catch {}
}

function faviconHref(badged: boolean): string {
  const dot = badged ? `<circle cx="50" cy="14" r="13" fill="#f0a734" stroke="#14110d" stroke-width="4"/>` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#14110d"/>` +
    `<text x="33" y="47" font-family="Georgia,serif" font-style="italic" font-size="46" text-anchor="middle" fill="#f0a734">r</text>` +
    `${dot}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function applyBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (link) link.href = faviconHref(count > 0);
}
