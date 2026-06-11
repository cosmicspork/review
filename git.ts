import { isAbsolute, join, sep } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type DiffMode = 'worktree' | 'staged' | 'range';

export interface DiffSpec {
  mode: DiffMode;
  base?: string;
  head?: string;
  paths?: string[];
}

const REF_RE = /^[A-Za-z0-9._/-]+$/;

async function run(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

export function resolveRepo(repo: string, root: string): string {
  if (!repo || !isAbsolute(repo)) throw new HttpError(400, 'repo must be an absolute path');
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(repo);
    realRoot = realpathSync(root);
  } catch {
    throw new HttpError(400, 'repo path does not exist');
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new HttpError(400, 'repo is outside REVIEW_REPO_ROOT');
  }
  if (!existsSync(join(real, '.git'))) throw new HttpError(400, 'repo is not a git repository');
  return real;
}

export async function captureDiff(repo: string, spec: DiffSpec): Promise<string> {
  const paths = spec.paths ?? [];
  for (const p of paths) {
    if (!p || p.startsWith('-')) throw new HttpError(400, `invalid path in diff spec: ${p}`);
  }
  const pathArgs = paths.length ? ['--', ...paths] : [];

  if (spec.mode === 'staged') {
    return (await run(['git', '-C', repo, 'diff', '--no-color', '--cached', ...pathArgs])).stdout;
  }

  if (spec.mode === 'range') {
    const { base, head } = spec;
    if (!base || !head || !REF_RE.test(base) || !REF_RE.test(head)) {
      throw new HttpError(400, 'range mode requires safe base and head refs');
    }
    return (await run(['git', '-C', repo, 'diff', '--no-color', base, head, ...pathArgs])).stdout;
  }

  // worktree (default): tracked changes vs HEAD + an add-patch for each untracked file.
  let out = (await run(['git', '-C', repo, 'diff', '--no-color', ...pathArgs])).stdout;
  const others = (
    await run(['git', '-C', repo, 'ls-files', '--others', '--exclude-standard', '-z', ...pathArgs])
  ).stdout;
  for (const file of others.split('\0').filter(Boolean)) {
    // `--no-index` exits 1 when files differ — expected here; the diff is on stdout regardless of code.
    out += (
      await run(['git', '-C', repo, 'diff', '--no-color', '--no-index', '--', '/dev/null', file])
    ).stdout;
  }
  return out;
}
