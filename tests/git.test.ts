import { test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiff, resolveRepo, HttpError } from '../git.ts';

let root: string;
let repo: string;
let externalRoot: string;
let linkedWorktree: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  await p.exited;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rev-git-'));
  repo = join(root, 'proj');
  mkdirSync(repo);
  await git(repo, 'init');
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'keep.ts'), 'export const a = 1;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'init');
  externalRoot = mkdtempSync(join(tmpdir(), 'rev-linked-'));
  linkedWorktree = join(externalRoot, 'linked');
  await git(repo, 'worktree', 'add', '--detach', linkedWorktree, 'HEAD');
  writeFileSync(join(repo, 'keep.ts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'NEW.md'), '# New\n\nbody line\n');
});
afterAll(async () => {
  if (existsSync(linkedWorktree)) await git(repo, 'worktree', 'remove', '--force', linkedWorktree);
  rmSync(externalRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('worktree diff includes tracked modification and untracked add-patch', async () => {
  const d = await captureDiff(repo, { mode: 'worktree' });
  expect(d).toContain('-export const a = 1;');
  expect(d).toContain('+export const a = 2;');
  expect(d).toContain('new file mode');
  expect(d).toContain('+++ b/NEW.md');
  expect(d).toContain('+# New');
});

test('staged diff includes only staged changes', async () => {
  await git(repo, 'add', 'keep.ts');
  const d = await captureDiff(repo, { mode: 'staged' });
  expect(d).toContain('keep.ts');
  expect(d).not.toContain('NEW.md');
});

test('range mode rejects unsafe refs', async () => {
  await expect(captureDiff(repo, { mode: 'range', base: '..; rm -rf /', head: 'HEAD' })).rejects.toThrow(HttpError);
});

test('resolveRepo accepts a linked worktree outside the root', () => {
  expect(resolveRepo(linkedWorktree, root)).toBe(realpathSync(linkedWorktree));
});

test('resolveRepo accepts a git repo under root', () => {
  expect(resolveRepo(repo, root)).toContain('proj');
});

test('resolveRepo rejects a path outside the root', () => {
  expect(() => resolveRepo('/etc', root)).toThrow(HttpError);
});

test('resolveRepo rejects a standalone git repository outside the root', async () => {
  const standalone = join(externalRoot, 'standalone');
  mkdirSync(standalone);
  await git(standalone, 'init');

  expect(() => resolveRepo(standalone, root)).toThrow(
    'repo is outside REVIEW_REPO_ROOT and is not a linked worktree of a repository within it',
  );
});

test('resolveRepo rejects a forged linked-worktree gitfile', () => {
  const forged = join(externalRoot, 'forged');
  const wrong = join(externalRoot, 'wrong');
  const forgedGitdir = join(repo, '.git', 'worktrees', 'forged');
  mkdirSync(forged);
  mkdirSync(wrong);
  mkdirSync(forgedGitdir, { recursive: true });
  writeFileSync(join(forged, '.git'), `gitdir: ${forgedGitdir}\n`);
  writeFileSync(join(forgedGitdir, 'gitdir'), join(wrong, '.git') + '\n');
  writeFileSync(join(wrong, '.git'), 'not a git directory\n');

  expect(() => resolveRepo(forged, root)).toThrow(
    'repo is outside REVIEW_REPO_ROOT and is not a linked worktree of a repository within it',
  );
});

test('resolveRepo rejects a linked-worktree gitfile symlink', () => {
  const symlinked = join(externalRoot, 'symlinked');
  mkdirSync(symlinked);
  symlinkSync(join(linkedWorktree, '.git'), join(symlinked, '.git'));

  expect(() => resolveRepo(symlinked, root)).toThrow(
    'repo is outside REVIEW_REPO_ROOT and is not a linked worktree of a repository within it',
  );
});

test('resolveRepo rejects a non-git directory', () => {
  expect(() => resolveRepo(root, root)).toThrow(HttpError);
});
