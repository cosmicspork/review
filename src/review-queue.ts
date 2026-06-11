import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ReviewSummary } from '../db.ts';
import { KIND_ICON, STATUS_LABEL, ago, kindLabel, railColor } from './util.ts';

@customElement('review-queue')
export class ReviewQueue extends LitElement {
  @property({ attribute: false }) reviews: ReviewSummary[] = [];
  @property() activeId: string | null = null;
  @property() filter: 'all' | 'pending' | 'resolved' = 'all';

  createRenderRoot() {
    return this;
  }

  private select(id: string): void {
    this.dispatchEvent(new CustomEvent('select', { detail: { id }, bubbles: true, composed: true }));
  }

  render() {
    let list = this.reviews;
    if (this.filter === 'pending') list = list.filter((r) => r.status === 'pending');
    else if (this.filter === 'resolved') list = list.filter((r) => r.status !== 'pending');

    if (!list.length) return html`<div class="empty">no reviews</div>`;

    return html`${list.map(
      (r, i) => html`
        <button
          class="card ${r.id === this.activeId ? 'active' : ''} ${r.status !== 'pending' ? 'resolved' : ''}"
          style="--rail:${railColor(r.status)};animation-delay:${i * 45}ms"
          @click=${() => this.select(r.id)}
        >
          <div class="card-top">
            <span class="kind"><span class="ico">${KIND_ICON[r.kind] ?? '•'}</span>${kindLabel(r.kind)}</span>
            <span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span>
          </div>
          <h3>${r.title}</h3>
          <div class="card-meta">
            <span><b>${r.repo ? r.repo.split('/').pop() : '—'}</b></span>
            <span>${ago(r.created_at)}</span>
          </div>
        </button>
      `,
    )}`;
  }
}
