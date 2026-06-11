import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { FullReview } from '../db.ts';
import { KIND_ICON, STATUS_LABEL, kindLabel } from './util.ts';
import './diff-part.ts';
import './text-part.ts';
import './comment-thread.ts';
import './verdict-bar.ts';

@customElement('review-detail')
export class ReviewDetail extends LitElement {
  @property({ attribute: false }) review!: FullReview;
  @property() scheme: 'light' | 'dark' = 'dark';

  createRenderRoot() {
    return this;
  }

  private emitTitle(value: string, flush: boolean): void {
    this.dispatchEvent(
      new CustomEvent('title-change', { detail: { title: value, flush }, bubbles: true, composed: true }),
    );
  }

  render() {
    const r = this.review;
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const chips: Array<[string, unknown]> = [['repo', r.repo]];
    if (m.provider) chips.push(['via', m.provider]);
    if (m.branch) chips.push(['branch', m.branch]);
    if (m.sourceBranch) chips.push(['source', m.sourceBranch]);
    if (m.targetBranch) chips.push(['target', m.targetBranch]);
    if (m.project) chips.push(['project', m.project]);
    if (m.issueType) chips.push(['type', m.issueType]);
    if (m.key) chips.push(['key', m.key]);
    const parts = [...r.parts].sort((a, b) => a.seq - b.seq);

    return html`
      <main class="detail">
        <div class="detail-scroll">
          <div class="dhead">
            <div class="kindrow">
              <span class="kind"><span class="ico">${KIND_ICON[r.kind]}</span>${kindLabel(r.kind, m.provider as string)}</span>
              <span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span>
            </div>
            <input
              class="title-edit"
              .value=${r.title}
              @input=${(e: Event) => this.emitTitle((e.target as HTMLInputElement).value, false)}
              @blur=${(e: Event) => this.emitTitle((e.target as HTMLInputElement).value, true)}
            />
            <p class="edit-hint">editable — your changes are what the agent reads back</p>
          </div>
          <div class="chips">
            ${chips
              .filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => html`<span class="chip"><span class="k">${k}</span>${v}</span>`)}
          </div>
          ${parts.map((p) =>
            p.type === 'diff'
              ? html`<diff-part .partData=${p} .scheme=${this.scheme}></diff-part>`
              : html`<text-part .partData=${p}></text-part>`,
          )}
          <comment-thread .comments=${r.comments}></comment-thread>
        </div>
        <verdict-bar .review=${r}></verdict-bar>
      </main>
    `;
  }
}
