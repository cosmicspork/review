import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { FullReview, ReviewStatus } from '../db.ts';
import { STATUS_LABEL } from './util.ts';

@customElement('verdict-bar')
export class VerdictBar extends LitElement {
  @property({ attribute: false }) review!: FullReview;

  createRenderRoot() {
    return this;
  }

  private verdict(status: ReviewStatus): void {
    this.dispatchEvent(new CustomEvent('verdict', { detail: { status }, bubbles: true, composed: true }));
  }

  render() {
    const resolved = this.review.status !== 'pending';
    return html`
      <div class="verdict">
        <span class="label">${resolved ? `Resolved · ${STATUS_LABEL[this.review.status]}` : 'Verdict'}</span>
        <button class="vbtn approve" @click=${() => this.verdict('approved')}>Approve</button>
        <button class="vbtn changes" @click=${() => this.verdict('changes_requested')}>Request changes</button>
        <button class="vbtn reject" @click=${() => this.verdict('rejected')}>Reject</button>
      </div>
    `;
  }
}
