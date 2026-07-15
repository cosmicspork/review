import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { FullReview, ReviewStatus, ReviewSummary } from '../db.ts';
import * as api from './api.ts';
import './review-queue.ts';
import './review-detail.ts';

interface ReviewThemeConfig {
  themes: Array<{ id: string; name: string }>;
  buildThemeVars: (theme: unknown) => void;
  MODE_KEY: string;
  THEME_KEY: string;
  mql: MediaQueryList;
}

declare global {
  interface Window {
    __reviewTheme?: ReviewThemeConfig;
  }
}

type Mode = 'auto' | 'light' | 'dark';
type Filter = 'all' | 'pending' | 'resolved';

const SAVE_DEBOUNCE_MS = 600;
const FILTERS: readonly Filter[] = ['all', 'pending', 'resolved'];
const MODES: readonly Mode[] = ['auto', 'light', 'dark'];

@customElement('review-app')
export class ReviewApp extends LitElement {
  @state() private reviews: ReviewSummary[] = [];
  @state() private activeId: string | null = null;
  @state() private active: FullReview | null = null;
  @state() private filter: Filter = 'all';
  @state() private mode: Mode = 'auto';
  @state() private themeId = '';
  @state() private scheme: 'light' | 'dark' = 'dark';
  @state() private toastMsg = '';
  @state() private toastShow = false;
  @state() private settingsOpen = false;

  private readonly theme = window.__reviewTheme!;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private toastTimer?: ReturnType<typeof setTimeout>;
  private es?: EventSource;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const m = localStorage.getItem(this.theme.MODE_KEY);
      if (m === 'auto' || m === 'light' || m === 'dark') this.mode = m;
    } catch {}
    const fallback = this.theme.themes[0]?.id ?? '';
    try {
      const id = localStorage.getItem(this.theme.THEME_KEY);
      this.themeId = this.theme.themes.some((t) => t.id === id) ? (id as string) : fallback;
    } catch {
      this.themeId = fallback;
    }
    this.applyMode();
    this.theme.mql.addEventListener('change', this.onMql);
    window.addEventListener('popstate', this.onPopState);
    this.activeId = ReviewApp.idFromPath();
    void this.boot();
    this.connectSse();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.theme.mql.removeEventListener('change', this.onMql);
    window.removeEventListener('popstate', this.onPopState);
    this.es?.close();
  }

  private static idFromPath(): string | null {
    const m = location.pathname.match(/^\/reviews\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Keep the address bar in step with the active review so it can be linked and reloaded.
  private syncUrl(id: string | null, replace = false): void {
    const path = id ? `/reviews/${id}` : '/';
    if (location.pathname === path) return;
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }

  private onPopState = (): void => {
    const id = ReviewApp.idFromPath();
    if (id === this.activeId) return;
    this.activeId = id;
    void this.fetchActive();
  };

  private async boot(): Promise<void> {
    const linked = this.activeId; // from the initial `/reviews/:id`, if any
    await this.fetchList();
    if (linked) {
      await this.fetchActive();
      if (!this.active) {
        // Deep-linked id no longer exists — fall back to the first review.
        this.activeId = this.reviews[0]?.id ?? null;
        this.syncUrl(this.activeId, true);
        if (this.activeId) await this.fetchActive();
      }
    }
  }

  private onMql = (): void => {
    if (this.mode === 'auto') this.applyMode();
  };

  private applyMode(): void {
    const resolved = this.mode === 'auto' ? (this.theme.mql.matches ? 'dark' : 'light') : this.mode;
    document.documentElement.dataset.theme = resolved;
    this.scheme = resolved;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    try {
      localStorage.setItem(this.theme.MODE_KEY, m);
    } catch {}
    this.applyMode();
  }

  private setTheme(id: string): void {
    this.themeId = id;
    try {
      localStorage.setItem(this.theme.THEME_KEY, id);
    } catch {}
    const theme = this.theme.themes.find((t) => t.id === id);
    if (theme) this.theme.buildThemeVars(theme);
  }

  private connectSse(): void {
    this.es = new EventSource('/api/events');
    this.es.onmessage = (e) => {
      try {
        this.onSse(JSON.parse(e.data) as { kind: string; id: string });
      } catch {}
    };
  }

  private onSse(ev: { kind: string; id: string }): void {
    void this.fetchList();
    if (ev.id === this.activeId) {
      if (ev.kind === 'remove') {
        this.activeId = null;
        this.active = null;
        this.syncUrl(null, true);
      } else {
        void this.fetchActive();
      }
    }
  }

  private async fetchList(): Promise<void> {
    this.reviews = await api.listReviews();
    if (!this.activeId && this.reviews.length) {
      this.activeId = this.reviews[0].id;
      this.syncUrl(this.activeId, true);
      void this.fetchActive();
    }
  }

  private async fetchActive(): Promise<void> {
    this.active = this.activeId ? await api.getReview(this.activeId) : null;
  }

  private select(id: string): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.syncUrl(id);
    void this.fetchActive();
  }

  private toast(msg: string): void {
    this.toastMsg = msg;
    this.toastShow = true;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastShow = false;
    }, 2400);
  }

  private debounce(key: string, fn: () => void, immediate: boolean): void {
    clearTimeout(this.timers.get(key));
    if (immediate) {
      this.timers.delete(key);
      fn();
      return;
    }
    this.timers.set(key, setTimeout(fn, SAVE_DEBOUNCE_MS));
  }

  private onVerdict = async (e: CustomEvent): Promise<void> => {
    const status = e.detail.status as ReviewStatus;
    if (!this.activeId) return;
    await api.patchReview(this.activeId, { status });
    this.toast(`Marked ${status.replace('_', ' ')} — agent will pick it up`);
    await this.fetchActive();
    await this.fetchList();
  };

  private onComment = async (e: CustomEvent): Promise<void> => {
    if (!this.activeId) return;
    await api.postComment(this.activeId, e.detail);
    this.toast('Comment added');
    await this.fetchActive();
  };

  private onEditPart = (e: CustomEvent): void => {
    const { part_id, edited, flush } = e.detail as { part_id: string; edited: string; flush: boolean };
    if (this.active) {
      const p = this.active.parts.find((x) => x.id === part_id);
      if (p) p.edited = edited;
    }
    this.debounce(`part:${part_id}`, () => void api.putPart(part_id, edited), flush);
  };

  private onTitle = (e: CustomEvent): void => {
    const { title, flush } = e.detail as { title: string; flush: boolean };
    const id = this.activeId;
    if (!id) return;
    if (flush) {
      if (this.active) this.active = { ...this.active, title };
      this.reviews = this.reviews.map((r) => (r.id === id ? { ...r, title } : r));
    }
    this.debounce(`title:${id}`, () => void api.patchReview(id, { title }), flush);
  };

  render() {
    const pending = this.reviews.filter((r) => r.status === 'pending').length;
    const themes = this.theme.themes;
    return html`
      <div class="app">
        <aside class="sidebar">
          <div class="side-head">
            <p class="eyebrow">Pre-publish</p>
            <h1>re<em>view</em></h1>
            <p class="count-line"><b>${pending}</b> pending</p>
          </div>
          <div class="filters">
            ${FILTERS.map(
              (f) => html`<button aria-pressed=${this.filter === f} @click=${() => (this.filter = f)}>
                ${f[0].toUpperCase()}${f.slice(1)}
              </button>`,
            )}
          </div>
          <div class="queue">
            <review-queue
              .reviews=${this.reviews}
              .activeId=${this.activeId}
              .filter=${this.filter}
              @select=${(e: CustomEvent) => this.select(e.detail.id)}
            ></review-queue>
          </div>
          <div class="side-foot">
            <button
              class="foot-toggle"
              aria-expanded=${this.settingsOpen}
              @click=${() => (this.settingsOpen = !this.settingsOpen)}
            >
              <span class="foot-label">Settings</span>
              <span class="cog">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
              </span>
            </button>
            <div class="foot-tray ${this.settingsOpen ? 'open' : ''}">
              ${themes.length > 1
                ? html`<div class="foot-row">
                    <span class="foot-label">Theme</span>
                    <select class="theme-select" @change=${(e: Event) => this.setTheme((e.target as HTMLSelectElement).value)}>
                      ${themes.map((t) => html`<option value=${t.id} ?selected=${t.id === this.themeId}>${t.name}</option>`)}
                    </select>
                  </div>`
                : nothing}
              <div class="foot-row">
                <span class="foot-label">Mode</span>
                <div class="seg">
                  ${MODES.map(
                    (m) => html`<button data-mode=${m} aria-pressed=${this.mode === m} @click=${() => this.setMode(m)}>
                      ${m[0].toUpperCase()}${m.slice(1)}
                    </button>`,
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
        ${this.active
          ? html`<review-detail
              .review=${this.active}
              .scheme=${this.scheme}
              @verdict=${this.onVerdict}
              @comment=${this.onComment}
              @edit-part=${this.onEditPart}
              @title-change=${this.onTitle}
            ></review-detail>`
          : html`<main class="detail"><div class="empty">select a review</div></main>`}
      </div>
      <div class="toast ${this.toastShow ? 'show' : ''}">${this.toastMsg}</div>
    `;
  }
}
