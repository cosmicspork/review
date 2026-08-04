import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { parse, html as renderFiles } from 'diff2html/lib-esm/diff2html';
import type { DiffFile } from 'diff2html/lib-esm/types';
import { closeTags, getLanguage, mergeStreams, nodeStream } from 'diff2html/lib-esm/ui/js/highlight.js-helpers';
import hljs from 'highlight.js';
import type { ReviewPart } from '../db.ts';

type DiffFormat = 'side-by-side' | 'line-by-line';

// A file opens on its own only while the diff has budget left; everything past that
// waits for a click. Rendering is what costs — ~340k DOM nodes for a full toolchain
// diff — not fetching or parsing. Since an open file is clamped to its own scroll
// window, the file count is what actually sets page length.
const OPEN_FILE_LINES = 800;
const OPEN_FILE_MAX = 10;
const OPEN_TOTAL_LINES = 2500;
const HELD_FILE_LINES = 1200;
const FRAME_BUDGET_MS = 10;
const PARSE_CACHE_MAX = 6;

const GENERATED =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|[^/]+\.min\.(?:js|css)|[^/]+\.map)$/;

const parseCache = new Map<string, DiffFile[]>();

function parseOnce(part: ReviewPart): DiffFile[] {
  const hit = parseCache.get(part.id);
  if (hit) return hit;
  const files = parse(part.content, { matching: 'lines' });
  parseCache.set(part.id, files);
  if (parseCache.size > PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value as string);
  return files;
}

const int = (n: number): string => n.toLocaleString('en-US');

interface FileRow {
  key: string;
  file: DiffFile;
  path: string;
  dir: string;
  base: string;
  added: number;
  deleted: number;
  lines: number;
  tag: '' | 'new' | 'gone' | 'moved' | 'binary';
  held: '' | 'large file' | 'generated file';
}

function toRow(file: DiffFile, i: number): FileRow {
  const path = file.isDeleted ? file.oldName : file.newName;
  const cut = path.lastIndexOf('/');
  const lines = file.blocks.reduce((n, b) => n + b.lines.length, 0);
  const tag = file.isNew ? 'new' : file.isDeleted ? 'gone' : file.isRename ? 'moved' : file.isBinary ? 'binary' : '';
  return {
    key: `${i}:${path}`,
    file,
    path,
    dir: cut < 0 ? '' : path.slice(0, cut + 1),
    base: cut < 0 ? path : path.slice(cut + 1),
    added: file.addedLines,
    deleted: file.deletedLines,
    lines,
    tag,
    held: GENERATED.test(path) ? 'generated file' : lines > HELD_FILE_LINES ? 'large file' : '',
  };
}

const CARET = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>`;

@customElement('diff-part')
export class DiffPart extends LitElement {
  @property({ attribute: false }) partData!: ReviewPart;
  @property() scheme: 'light' | 'dark' = 'dark';

  @state() private format: DiffFormat = 'side-by-side';
  @state() private open = new Set<string>();
  @state() private loaded = new Set<string>();
  @state() private full = new Set<string>();
  @state() private composerFor: string | null = null;

  private rows: FileRow[] = [];
  private peakChurn = 1;
  private bodies = new Map<string, HTMLDivElement>();
  private tall = new Set<string>();
  private queue: FileRow[] = [];
  private draining = false;
  private measuring = false;
  private composerDraft = '';
  private builtId?: string;
  private builtFormat?: DiffFormat;

  createRenderRoot() {
    return this;
  }

  willUpdate(): void {
    if (this.partData.id !== this.builtId) this.build();
    else if (this.format !== this.builtFormat) this.reformat();
  }

  updated(): void {
    this.syncBodies();
    this.enqueueMissing();
    // Whether a body outgrows its window is only knowable once it has been laid
    // out, so the check waits for a frame rather than re-entering this update.
    if (this.measuring) return;
    this.measuring = true;
    requestAnimationFrame(() => {
      this.measuring = false;
      this.measure();
    });
  }

  private build(): void {
    this.builtId = this.partData.id;
    this.builtFormat = this.format;
    this.bodies.clear();
    this.tall.clear();
    this.queue = [];
    this.full = new Set();
    this.loaded = new Set();
    this.composerFor = null;
    this.rows = parseOnce(this.partData).map(toRow);
    this.peakChurn = Math.max(1, ...this.rows.filter((r) => !r.held).map((r) => r.added + r.deleted));

    const open = new Set<string>();
    let budget = OPEN_TOTAL_LINES;
    for (const row of this.rows) {
      if (open.size >= OPEN_FILE_MAX) break;
      if (row.held || row.lines > OPEN_FILE_LINES || row.lines > budget) continue;
      budget -= row.lines;
      open.add(row.key);
    }
    this.open = open;
  }

  private reformat(): void {
    this.builtFormat = this.format;
    this.bodies.clear();
    this.tall.clear();
    this.queue = [];
  }

  private showsBody(row: FileRow): boolean {
    return this.open.has(row.key) && (!row.held || this.loaded.has(row.key));
  }

  // Bodies are built off the main render path, a frame at a time, so the header
  // list paints immediately when you switch reviews.
  private enqueueMissing(): void {
    const missing = this.rows.filter((r) => this.showsBody(r) && !this.bodies.has(r.key) && !this.queue.includes(r));
    if (!missing.length) return;
    this.queue.push(...missing);
    if (this.draining) return;
    this.draining = true;
    requestAnimationFrame(this.drain);
  }

  private drain = (): void => {
    const start = performance.now();
    let built = 0;
    while (this.queue.length && performance.now() - start < FRAME_BUDGET_MS) {
      const row = this.queue.shift() as FileRow;
      if (!this.showsBody(row) || this.bodies.has(row.key)) continue;
      this.bodies.set(row.key, this.buildBody(row));
      built++;
    }
    if (built) this.requestUpdate();
    if (this.queue.length) requestAnimationFrame(this.drain);
    else this.draining = false;
  };

  private buildBody(row: FileRow): HTMLDivElement {
    const scroll = document.createElement('div');
    scroll.className = 'dp-scroll';
    scroll.innerHTML = renderFiles([row.file], {
      drawFileList: false,
      matching: 'lines',
      outputFormat: this.format,
      colorScheme: 'light',
    } as never);
    scroll.querySelector('.d2h-file-header')?.remove();
    this.highlight(scroll, row.file);
    this.linkSides(scroll);
    return scroll;
  }

  private highlight(root: HTMLElement, file: DiffFile): void {
    const mapped = file.language ? getLanguage(file.language) : 'plaintext';
    const language = hljs.getLanguage(mapped) ? mapped : 'plaintext';
    root.querySelectorAll<HTMLElement>('.d2h-code-line-ctn').forEach((line) => {
      const text = line.textContent;
      if (text === null) return;
      const result = closeTags(hljs.highlight(text, { language, ignoreIllegals: true }) as never) as {
        value: string;
      };
      const original = nodeStream(line);
      if (original.length) {
        const scratch = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        scratch.innerHTML = result.value;
        result.value = mergeStreams(original, nodeStream(scratch), text);
      }
      line.classList.add('hljs');
      line.innerHTML = result.value;
    });
  }

  private linkSides(root: HTMLElement): void {
    const [left, right] = Array.from(root.querySelectorAll<HTMLElement>('.d2h-file-side-diff'));
    if (!left || !right) return;
    const sync = (e: Event): void => {
      const [from, to] = e.target === left ? [left, right] : [right, left];
      to.scrollTop = from.scrollTop;
      to.scrollLeft = from.scrollLeft;
    };
    left.addEventListener('scroll', sync);
    right.addEventListener('scroll', sync);
  }

  private syncBodies(): void {
    for (const [key, node] of this.bodies) {
      node.classList.toggle('d2h-dark-color-scheme', this.scheme === 'dark');
      node.classList.toggle('full', this.full.has(key));
    }
  }

  private measure(): void {
    let changed = false;
    for (const [key, node] of this.bodies) {
      if (!node.isConnected || this.full.has(key)) continue;
      const over = node.scrollHeight - node.clientHeight > 4;
      if (over === this.tall.has(key)) continue;
      if (over) this.tall.add(key);
      else this.tall.delete(key);
      changed = true;
    }
    if (changed) this.requestUpdate();
  }

  private mutate<T>(set: Set<T>, key: T, on: boolean): Set<T> {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  }

  private toggle(row: FileRow): void {
    this.open = this.mutate(this.open, row.key, !this.open.has(row.key));
  }

  private load(row: FileRow): void {
    this.loaded = this.mutate(this.loaded, row.key, true);
    this.open = this.mutate(this.open, row.key, true);
  }

  private setAll(on: boolean): void {
    this.open = on ? new Set(this.rows.map((r) => r.key)) : new Set();
  }

  private toggleFull(row: FileRow): void {
    this.full = this.mutate(this.full, row.key, !this.full.has(row.key));
  }

  private submitComment(row: FileRow): void {
    const body = this.composerDraft.trim();
    if (!body) return;
    this.dispatchEvent(
      new CustomEvent('comment', {
        detail: { part_id: this.partData.id, anchor: `${row.path}:1`, body },
        bubbles: true,
        composed: true,
      }),
    );
    this.closeComposer();
  }

  private closeComposer(): void {
    this.composerFor = null;
    this.composerDraft = '';
  }

  private openComposer(row: FileRow): void {
    this.composerDraft = '';
    this.composerFor = this.composerFor === row.key ? null : row.key;
  }

  // Width carries the file's share of the diff's churn, the split carries added vs
  // removed — so the weight of a 35-file diff is legible without reading the counts.
  // Held files are off the scale by definition, so they peg it.
  private renderGauge(row: FileRow): unknown {
    const churn = row.added + row.deleted;
    if (!churn) return html`<span class="dp-gauge" aria-hidden="true"></span>`;
    const share = row.held ? 1 : Math.min(1, churn / this.peakChurn);
    const width = Math.max(14, Math.round(Math.sqrt(share) * 100));
    return html`<span class="dp-gauge" aria-hidden="true">
      <span class="dp-gauge-bar" style="width:${width}%">
        <i class="i" style="flex:${row.added}"></i><i class="d" style="flex:${row.deleted}"></i>
      </span>
    </span>`;
  }

  private renderBody(row: FileRow): unknown {
    if (!this.open.has(row.key)) return nothing;
    if (row.held && !this.loaded.has(row.key)) {
      return html`<div class="dp-plate">
        <span class="dp-held">Held</span>
        <p class="dp-plate-copy">
          ${row.held === 'generated file' ? 'Generated file' : 'Large file'} — ${int(row.lines)} lines. Rendering it
          will take a moment.
        </p>
        <button class="btn on" @click=${() => this.load(row)}>Load diff</button>
      </div>`;
    }
    const node = this.bodies.get(row.key);
    if (!node) return html`<div class="dp-pending">Rendering…</div>`;
    const isFull = this.full.has(row.key);
    return html`${node}
      ${this.tall.has(row.key) || isFull
        ? html`<button class="dp-release" @click=${() => this.toggleFull(row)}>
            ${isFull ? 'Use a scroll window' : `Show all ${int(row.lines)} lines`}
          </button>`
        : nothing}`;
  }

  private renderFile(row: FileRow): unknown {
    const isOpen = this.open.has(row.key);
    return html`<section class="dp-file ${isOpen ? 'open' : ''}">
      <div class="dp-head">
        <button class="dp-disclose" aria-expanded=${isOpen} @click=${() => this.toggle(row)}>
          <span class="dp-caret">${CARET}</span>
          <span class="dp-path" title=${row.path}><span class="dp-dir">${row.dir}</span><span class="dp-base">${row.base}</span></span>
          ${row.tag ? html`<span class="dp-tag ${row.tag}">${row.tag === 'gone' ? 'deleted' : row.tag}</span>` : nothing}
          ${row.held && !this.loaded.has(row.key) ? html`<span class="dp-tag held">held</span>` : nothing}
          <span class="dp-spacer"></span>
          ${this.renderGauge(row)}
          <span class="dp-nums">
            <b class="add">+${int(row.added)}</b><b class="del">−${int(row.deleted)}</b>
          </span>
        </button>
        <button class="btn dp-cmt-open" @click=${() => this.openComposer(row)}>+ comment</button>
      </div>
      ${this.composerFor === row.key
        ? html`<div class="dp-cmt">
            <textarea
              placeholder="Comment on ${row.base}…"
              .value=${this.composerDraft}
              @input=${(e: Event) => (this.composerDraft = (e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <div class="row">
              <button class="btn" @click=${() => this.closeComposer()}>Cancel</button>
              <button class="btn on" @click=${() => this.submitComment(row)}>Add</button>
            </div>
          </div>`
        : nothing}
      ${this.renderBody(row)}
    </section>`;
  }

  render() {
    const added = this.rows.reduce((n, r) => n + r.added, 0);
    const deleted = this.rows.reduce((n, r) => n + r.deleted, 0);
    const shown = this.rows.filter((r) => this.open.has(r.key)).length;

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
        ${this.rows.length
          ? html`<div class="dp-rail">
                <span class="dp-count">${int(this.rows.length)} ${this.rows.length === 1 ? 'file' : 'files'}</span>
                <span class="dp-tally"><b class="add">+${int(added)}</b><b class="del">−${int(deleted)}</b></span>
                <span class="dp-spacer"></span>
                <span class="dp-count dp-shown">${shown} open</span>
                <button class="btn" @click=${() => this.setAll(true)}>Open all</button>
                <button class="btn" @click=${() => this.setAll(false)}>Close all</button>
              </div>
              <div class="dp-files">${this.rows.map((row) => this.renderFile(row))}</div>`
          : html`<pre class="dp-raw">${this.partData.content}</pre>`}
      </div>
    `;
  }
}
