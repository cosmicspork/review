# review

A small, local **pre-publish review queue**. Coding agents submit artifacts — code diffs, merge/pull requests, and tickets — and a human approves, edits, or rejects them in a browser **before** anything is published. The agent reads the verdict and the human-edited content back, then performs the real publish itself (`glab`, `gh`, `acli`, …).

`review` never talks to GitLab/GitHub/Jira and holds no tokens. It is a review gate, not a publisher.

- **Agent interface:** a small JSON HTTP API.
- **Human interface:** a single-page app (editorial dark/light theme, multi-theme, diff viewer, inline markdown editing, comments).
- **Storage:** one SQLite file. The queue is lock-free — diffs are snapshotted from `git` at submit time, so an agent can submit and keep working.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install
bun start            # serves http://localhost:4000
```

Open http://localhost:4000 and you have an empty queue. Submit something:

```sh
curl -s localhost:4000/api/reviews -H 'content-type: application/json' -d '{
  "repo": "'"$HOME"'/code/my-project",
  "title": "Debounce the file watcher",
  "kind": "code",
  "parts": [{ "type": "diff", "label": "Code changes", "diff": { "mode": "worktree" } }]
}'
# -> {"id":"…"}
```

The card appears in the queue. Approve it in the UI, then have the agent read it back.

The `id` from the response is also a **deep link**: `http://localhost:4000/reviews/<id>` opens the app with that review already selected, so an agent can point a human straight at the item it just submitted. The URL updates as you click through the queue, and reloading or sharing it reopens the same review (a stale id falls back to the first one).

### Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `REVIEW_PORT` | `4000` | HTTP port |
| `REVIEW_HOST` | `127.0.0.1` | bind address — loopback only by default; the queue holds unpublished diffs and the API can run `git` against repos under `REVIEW_REPO_ROOT` |
| `REVIEW_DB` | `~/.review/review.sqlite` | SQLite path (parent dir auto-created) |
| `REVIEW_REPO_ROOT` | `~/src` | repos must resolve under this root to be diffed |
| `REVIEW_THEME` | `~/.review/theme.json` | optional theme override merged over the built-ins |

## Submitting reviews (the agent contract)

`POST /api/reviews` with `{ repo?, title, kind, meta?, parts: [...] }`:

- **`kind`** — `code` · `mr` (GitLab merge request) · `pr` (GitHub pull request) · `ticket` (e.g. Jira). It only drives the label/icon; the parts carry the content.
- **`repo`** — absolute path. Required when any part captures a diff from git (see below); it must resolve under `REVIEW_REPO_ROOT` and contain a `.git`. Optional otherwise.
- **`meta`** — free-form JSON shown as chips: `provider`, `branch`, `sourceBranch`, `targetBranch`, `project`, `issueType`, `key`, …
- **`parts`** — an ordered list. Each is one of:

```jsonc
// 1. a git-captured diff (server runs git at submit time)
{ "type": "diff", "label": "Code changes", "diff": { "mode": "worktree" } }
//    mode: "worktree" (tracked changes vs HEAD + every untracked file),
//          "staged"   (the index), or
//          "range"    (requires "base" and "head" refs)
//    optional "paths": ["src/", "docs/x.md"] to scope it

// 2. a pre-built diff (no git access needed)
{ "type": "diff", "label": "Code changes", "patch": "diff --git a/… b/…\n…" }

// 3. markdown (MR/PR descriptions, notes)
{ "type": "markdown", "label": "MR description", "content": "## Summary\n…" }

// 4. ADF (Atlassian Document Format — Jira). Stored verbatim; a markdown
//    preview is derived for the human to read and edit.
{ "type": "adf", "label": "Ticket description", "adf": { "version": 1, "type": "doc", "content": [ … ] } }
```

`worktree` mode includes **untracked files** as full add-patches, so brand-new docs and files show up in the diff.

### Example: a GitLab merge request

```sh
curl -s localhost:4000/api/reviews -H 'content-type: application/json' -d '{
  "repo": "'"$HOME"'/code/my-project",
  "title": "Add request retry middleware",
  "kind": "mr",
  "meta": { "provider": "gitlab", "targetBranch": "main", "sourceBranch": "feat/retry" },
  "parts": [
    { "type": "diff", "label": "Code changes", "diff": { "mode": "worktree" } },
    { "type": "markdown", "label": "MR description", "content": "## Summary\n\nAdds a retry middleware." }
  ]
}'
```

A GitHub PR is identical with `"kind": "pr"` and `"provider": "github"`. A Jira ticket uses `"kind": "ticket"` with an `adf` part.

## Waiting for the verdict

Two ways for the agent to block until the human decides:

**`bin/review-wait`** (POSIX sh, needs only `curl`):

```sh
review/bin/review-wait <review-id>
#   --interval=3                 seconds between polls
#   --timeout=0                  give up after N seconds (0 = forever)
#   --host=http://localhost:4000
```

It long-polls and, on a terminal status, prints the status to **stderr** and the full review JSON to **stdout**, then exits 0.

**Or poll directly:** `GET /api/reviews/:id/status?wait=45` holds the connection until the status changes (or ~45 s elapse) and returns the current status as plain text.

Once terminal, fetch `GET /api/reviews/:id` and read each part's **`edited ?? content`** — that is the human-approved text. For `adf` parts the original ADF is in `raw`, so you can re-derive ADF from the edited markdown or post `raw` unchanged. Comments are in `comments[]`. Then publish however you normally would.

### If the human requests changes

On `changes_requested` or `rejected`, address the feedback and call:

```sh
curl -s localhost:4000/api/reviews/<id>/revise -H 'content-type: application/json' -d '{
  "note": "Addressed the feedback.",
  "parts": [ { "type": "diff", "diff": { "mode": "worktree" } } ]
}'
```

This re-snapshots the parts, flips the review back to `pending`, **keeps the existing comments**, and (with `note`) leaves an agent comment. The human sees one evolving thread instead of a new queue item — and `review-wait` can be run again.

## API reference

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/reviews` | Submit; returns `{id}` (201). |
| `GET` | `/api/reviews` | Queue summaries, pending first. |
| `GET` | `/api/reviews/:id` | Full review + parts + comments. |
| `GET` | `/api/reviews/:id/status?wait=N` | Status as text; long-polls up to N (≤50) seconds. |
| `PATCH` | `/api/reviews/:id` | `{status?, title?, meta?}`. |
| `PUT` | `/api/parts/:id` | `{edited}` — human edit (markdown/adf parts only). |
| `POST` | `/api/reviews/:id/comments` | `{part_id?, anchor?, body, author?}`. |
| `POST` | `/api/reviews/:id/revise` | `{parts?, meta?, note?}` — re-snapshot, back to pending. |
| `DELETE` | `/api/reviews/:id` | Delete + cascade. |
| `POST` | `/api/cleanup` | `{olderThanDays, status?}` — prune resolved reviews. |
| `GET` | `/api/health` | `{ok, service, version, uptime_s, reviews:{total,pending}}` JSON (200, or 503 if the DB is unqueryable). |
| `GET` | `/health` | The same check as an HTML status page for humans (`open localhost:4000/health`). |

An agent can confirm the server is up before submitting with `curl -fsS localhost:4000/api/health`; both routes query SQLite, so a 200 attests the store is readable, not merely that the port is open.

## Cleanup

Resolved reviews pile up; prune the old ones:

```sh
bun run cleanup.ts --days=30                 # delete reviews resolved >30 days ago
bun run cleanup.ts --days=0 --status=approved # purge all approved
```

## Theming

`theme.json` ships two themes (`warm-editorial`, `cobalt`). Each theme only specifies a colour palette and three fonts; everything else (diff colours, syntax highlighting, gradients) is derived. Drop a `theme.json` at `REVIEW_THEME` (`~/.review/theme.json` by default) to override a built-in theme by `id` or add your own. The UI shows a theme picker when more than one theme is configured, plus an Auto / Light / Dark control (Auto follows the OS; choices persist in the browser).

## Running it persistently

`review` is just a Bun process — keep it alive however you like (a terminal, `tmux`, a supervisor). On macOS a LaunchAgent works well. Create `~/Library/LaunchAgents/dev.review.server.plist` (adjust the paths) and `launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.review.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>/absolute/path/to/review/server.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REVIEW_PORT</key><string>4000</string>
    <key>REVIEW_REPO_ROOT</key><string>/Users/you/code</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.review/logs/server.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.review/logs/server.err.log</string>
</dict>
</plist>
```

The plist is machine-specific — keep it out of version control.

## Development

```sh
bun dev        # hot-reload server; src/app.ts rebuilds on change
bun test       # unit + API tests
```

`server.ts` is a single `Bun.serve` router; `routes.ts` holds the handler (factored so tests can call it without a socket); `db.ts` is the SQLite layer; `git.ts` captures diffs; `src/` is the [Lit](https://lit.dev) SPA, bundled at runtime to `/app.js`.

## License

MIT.
