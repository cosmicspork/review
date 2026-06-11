import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';
import type { ReviewComment } from '../db.ts';
import { ago } from './util.ts';

@customElement('comment-thread')
export class CommentThread extends LitElement {
  @property({ attribute: false }) comments: ReviewComment[] = [];
  @state() private draft = '';

  createRenderRoot() {
    return this;
  }

  private send(): void {
    const v = this.draft.trim();
    if (!v) return;
    this.dispatchEvent(new CustomEvent('comment', { detail: { body: v }, bubbles: true, composed: true }));
    this.draft = '';
  }

  render() {
    return html`
      <div class="comments">
        <div class="comments-head">Comments</div>
        <div class="cmt-list">
          ${this.comments.length === 0 ? html`<p class="edit-hint">No comments yet.</p>` : nothing}
          ${this.comments.map(
            (c) => html`
              <div class="cmt">
                <div class="cmt-top">
                  <span class="cmt-author ${c.author === 'agent' ? 'agent' : ''}">${c.author}</span>
                  ${c.anchor ? html`<span class="cmt-anchor">${c.anchor}</span>` : nothing}
                  <span class="cmt-time">${ago(c.created_at)}</span>
                </div>
                <div class="cmt-body">${unsafeHTML(marked.parse(c.body) as string)}</div>
              </div>
            `,
          )}
        </div>
        <div class="composer">
          <textarea
            placeholder="Leave a comment for the agent…"
            .value=${this.draft}
            @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="row"><button class="btn" @click=${() => this.send()}>Comment</button></div>
        </div>
      </div>
    `;
  }
}
