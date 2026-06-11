import type { ReviewKind, ReviewStatus } from '../db.ts';

export const KIND_ICON: Record<string, string> = { code: '±', mr: '⎇', pr: '⎇', ticket: '◈' };

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes',
  rejected: 'Rejected',
};

export function kindLabel(kind: ReviewKind, provider?: string): string {
  if (kind === 'code') return 'Code';
  if (kind === 'mr') return 'Merge Request';
  if (kind === 'pr') return 'Pull Request';
  if (kind === 'ticket') return provider ? `Ticket · ${provider[0].toUpperCase()}${provider.slice(1)}` : 'Ticket';
  return kind;
}

export function ago(ts: number): string {
  const d = Date.now() - ts;
  const min = 60_000;
  const hr = 3_600_000;
  const day = 86_400_000;
  if (d < min) return 'just now';
  if (d < hr) return `${Math.floor(d / min)}m ago`;
  if (d < day) return `${Math.floor(d / hr)}h ago`;
  return `${Math.floor(d / day)}d ago`;
}

export function railColor(status: ReviewStatus): string {
  if (status === 'approved') return 'var(--st-approved)';
  if (status === 'changes_requested') return 'var(--st-changes)';
  if (status === 'rejected') return 'var(--st-rejected)';
  return 'var(--st-pending)';
}
