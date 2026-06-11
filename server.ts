import chokidar from 'chokidar';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createDb } from './db.ts';
import { loadThemes } from './theme.ts';
import { createHandler, type AppBundle } from './routes.ts';

const HERE = import.meta.dir;
const expand = (p: string): string => p.replace(/^~(?=$|\/)/, homedir());

const PORT = Number(process.env.REVIEW_PORT ?? 4000);
const HOST = process.env.REVIEW_HOST ?? '127.0.0.1';
const DB_PATH = expand(process.env.REVIEW_DB ?? join(homedir(), '.review', 'review.sqlite'));
const REPO_ROOT = expand(process.env.REVIEW_REPO_ROOT ?? join(homedir(), 'src'));
const THEME_OVERRIDE = expand(process.env.REVIEW_THEME ?? join(homedir(), '.review', 'theme.json'));

const APP_ENTRY = join(HERE, 'src', 'app.ts');
const SRC_DIR = join(HERE, 'src');
const HTML_PATH = join(HERE, 'index.html');
const THEME_BUILTIN = join(HERE, 'theme.json');
const DIFF2HTML_CSS = Bun.resolveSync('diff2html/bundles/css/diff2html.min.css', HERE);

mkdirSync(SRC_DIR, { recursive: true });

const db = createDb(DB_PATH);
const themes = loadThemes(THEME_BUILTIN, THEME_OVERRIDE);
const indexHtml = (await Bun.file(HTML_PATH).text()).replace('/*__THEMES__*/[]', JSON.stringify(themes));

const bundle: AppBundle = { js: null, err: null };

async function buildAppBundle(): Promise<void> {
  try {
    const result = await Bun.build({
      entrypoints: [APP_ENTRY],
      target: 'browser',
      minify: true,
      sourcemap: 'inline',
    });
    if (!result.success || result.outputs.length === 0) {
      bundle.js = null;
      bundle.err = result.logs.map((l) => String(l)).join('\n') || 'unknown build error';
      console.error('[review] app bundle build failed:\n' + bundle.err);
      return;
    }
    bundle.js = await result.outputs[0].text();
    bundle.err = null;
    console.log(`[review] bundled src/app.ts (${bundle.js.length} bytes)`);
  } catch (e) {
    bundle.js = null;
    bundle.err = e instanceof Error ? e.message : String(e);
    console.error('[review] app bundle build threw:', bundle.err);
  }
}

function setupAppWatcher(): void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const trigger = (): void => {
    clearTimeout(pending ?? undefined);
    pending = setTimeout(() => {
      pending = null;
      buildAppBundle().catch((e) => console.error('[review] rebuild failed:', e));
    }, 80);
  };
  const watcher = chokidar.watch(SRC_DIR, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 30 },
  });
  watcher.on('add', trigger);
  watcher.on('change', trigger);
  watcher.on('unlink', trigger);
  watcher.on('error', (err) => console.error('[review] src watcher error:', err));
}

await buildAppBundle();
setupAppWatcher();

const handler = createHandler({
  db,
  repoRoot: REPO_ROOT,
  indexHtml,
  bundle,
  diff2htmlCssPath: DIFF2HTML_CSS,
});

const server = Bun.serve({ port: PORT, hostname: HOST, idleTimeout: 255, fetch: handler });

console.log(`[review] http://${HOST}:${server.port}  db: ${DB_PATH}  repos: ${REPO_ROOT}`);
