import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';
import type { ReviewPart } from '../db.ts';

@customElement('text-part')
export class TextPart extends LitElement {
  @property({ attribute: false }) partData!: ReviewPart;
  @state() private editing = false;
  @state() private draft = '';

  createRenderRoot() {
    return this;
  }

  private toggle(): void {
    if (!this.editing) {
      this.draft = this.partData.edited ?? this.partData.content;
      this.editing = true;
    } else {
      this.editing = false;
      this.emit(true);
    }
  }

  private emit(flush: boolean): void {
    this.dispatchEvent(
      new CustomEvent('edit-part', {
        detail: { part_id: this.partData.id, edited: this.draft, flush },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const icon = this.partData.type === 'adf' ? '◈' : '¶';
    const src = this.partData.edited ?? this.partData.content;
    const label = this.editing ? 'Done' : this.partData.edited != null ? 'Edit ✎' : 'Edit';
    return html`
      <div class="part">
        <div class="part-head">
          <span class="part-title">${icon} ${this.partData.label || 'Text'}</span>
          <div class="part-tools">
            <button class="btn ${this.editing ? 'on' : ''}" @click=${() => this.toggle()}>${label}</button>
          </div>
        </div>
        <div class="part-body md">
          ${this.editing
            ? html`<textarea
                class="md-edit"
                .value=${this.draft}
                @input=${(e: Event) => {
                  this.draft = (e.target as HTMLTextAreaElement).value;
                  this.emit(false);
                }}
                @blur=${() => this.emit(true)}
              ></textarea>`
            : html`<div class="md-render">${unsafeHTML(marked.parse(src) as string)}</div>
                ${this.partData.type === 'adf'
                  ? html`<details class="adf-raw">
                      <summary>raw ADF JSON (posted to the tracker)</summary>
                      <pre>${this.partData.raw || ''}</pre>
                    </details>`
                  : nothing}`}
        </div>
      </div>
    `;
  }
}
