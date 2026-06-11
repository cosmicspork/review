import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, type ReviewStatus } from './db.ts';

function main(): void {
  let days = Number.NaN;
  let status: ReviewStatus | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--days=')) days = Number(arg.slice('--days='.length));
    else if (arg.startsWith('--status=')) status = arg.slice('--status='.length) as ReviewStatus;
  }
  if (!Number.isFinite(days)) {
    console.error('usage: bun run cleanup.ts --days=N [--status=approved|changes_requested|rejected]');
    process.exit(1);
  }
  const dbPath = (process.env.REVIEW_DB ?? join(homedir(), '.review', 'review.sqlite')).replace(
    /^~(?=$|\/)/,
    homedir(),
  );
  const db = createDb(dbPath);
  const deleted = db.cleanup({ olderThanDays: days, status });
  db.close();
  console.log(`deleted ${deleted}`);
}

if (import.meta.main) main();
