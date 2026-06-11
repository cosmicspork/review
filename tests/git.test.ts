import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiff, resolveRepo, HttpError } from '../git.ts';

let root: string;
let repo: string;

async function git(...args: string[]): Promise<void> {
  const p = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'ignore', stderr: 'ignore' });
  await p.exited;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rev-git-'));
  repo = join(root, 'proj');
  mkdirSync(repo);
  await git('init');
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  writeFileSync(join(repo, 'keep.ts'), 'export const a = 1;\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
  writeFileSync(join(repo, 'keep.ts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'NEW.md'), '# New\n\nbody line\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test('worktree diff includes tracked modification and untracked add-patch', async () => {
  const d = await captureDiff(repo, { mode: 'worktree' });
  expect(d).toContain('-export const a = 1;');
  expect(d).toContain('+export const a = 2;');
  expect(d).toContain('new file mode');
  expect(d).toContain('+++ b/NEW.md');
  expect(d).toContain('+# New');
});

test('staged diff includes only staged changes', async () => {
  await git('add', 'keep.ts');
  const d = await captureDiff(repo, { mode: 'staged' });
  expect(d).toContain('keep.ts');
  expect(d).not.toContain('NEW.md');
});

test('range mode rejects unsafe refs', async () => {
  await expect(captureDiff(repo, { mode: 'range', base: '..; rm -rf /', head: 'HEAD' })).rejects.toThrow(HttpError);
});

test('resolveRepo accepts a git repo under root', () => {
  expect(resolveRepo(repo, root)).toContain('proj');
});

test('resolveRepo rejects a path outside the root', () => {
  expect(() => resolveRepo('/etc', root)).toThrow(HttpError);
});

test('resolveRepo rejects a non-git directory', () => {
  expect(() => resolveRepo(root, root)).toThrow(HttpError);
});
