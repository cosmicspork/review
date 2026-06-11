import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui';
import type { ReviewPart } from '../db.ts';

type DiffFormat = 'side-by-side' | 'line-by-line';

@customElement('diff-part')
export class DiffPart extends LitElement {
  @property({ attribute: false }) partData!: ReviewPart;
  @property() scheme: 'light' | 'dark' = 'dark';
  @state() private format: DiffFormat = 'side-by-side';

  private host: Ref<HTMLDivElement> = createRef();
  private drawnId?: string;
  private drawnFormat?: DiffFormat;
  private drawnScheme?: string;

  createRenderRoot() {
    return this;
  }

  firstUpdated(): void {
    this.draw();
  }

  updated(): void {
    if (this.partData.id !== this.drawnId || this.format !== this.drawnFormat || this.scheme !== this.drawnScheme) {
      this.draw();
    }
  }

  private draw(): void {
    const el = this.host.value;
    if (!el) return;
    el.innerHTML = '';
    const ui = new Diff2HtmlUI(el, this.partData.content, {
      drawFileList: true,
      matching: 'lines',
      outputFormat: this.format,
      highlight: true,
      fileListToggle: true,
      fileListStartVisible: false,
      fileContentToggle: true,
      colorScheme: this.scheme,
    } as never);
    ui.draw();
    try {
      ui.highlightCode();
    } catch {}
    this.attachCommentButtons(el);
    this.drawnId = this.partData.id;
    this.drawnFormat = this.format;
    this.drawnScheme = this.scheme;
  }

  private attachCommentButtons(el: HTMLElement): void {
    el.querySelectorAll<HTMLElement>('.d2h-file-header').forEach((fh) => {
      if (fh.querySelector('.d2h-cmt')) return;
      const name = (fh.querySelector('.d2h-file-name')?.textContent || 'file').trim();
      const btn = document.createElement('button');
      btn.className = 'btn d2h-cmt';
      btn.textContent = '+ comment';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openComposer(fh, name);
      });
      fh.appendChild(btn);
    });
  }

  private openComposer(fh: HTMLElement, name: string): void {
    const next = fh.nextElementSibling;
    if (next && next.classList.contains('d2h-cmt-box')) {
      next.querySelector('textarea')?.focus();
      return;
    }
    const box = document.createElement('div');
    box.className = 'd2h-cmt-box';
    const ta = document.createElement('textarea');
    ta.placeholder = `Comment on ${name}…`;
    const row = document.createElement('div');
    row.className = 'row';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => box.remove());
    const add = document.createElement('button');
    add.className = 'btn on';
    add.textContent = 'Add';
    add.addEventListener('click', () => {
      const v = ta.value.trim();
      if (!v) return;
      this.dispatchEvent(
        new CustomEvent('comment', {
          detail: { part_id: this.partData.id, anchor: `${name}:1`, body: v },
          bubbles: true,
          composed: true,
        }),
      );
      box.remove();
    });
    row.append(cancel, add);
    box.append(ta, row);
    fh.insertAdjacentElement('afterend', box);
    ta.focus();
  }

  render() {
    return html`
      <div class="part">
        <div class="part-head">
          <span class="part-title">◧ ${this.partData.label || 'Diff'}</span>
          <div class="part-tools">
            <button class="btn ${this.format === 'side-by-side' ? 'on' : ''}" @click=${() => (this.format = 'side-by-side')}>
              Side-by-side
            </button>
            <button class="btn ${this.format === 'line-by-line' ? 'on' : ''}" @click=${() => (this.format = 'line-by-line')}>
              Unified
            </button>
          </div>
        </div>
        <div class="part-body diff-wrap" ${ref(this.host)}></div>
      </div>
    `;
  }
}
