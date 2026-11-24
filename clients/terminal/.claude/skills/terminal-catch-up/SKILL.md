---
name: terminal-catch-up
description: Pull in what upstream Warp has changed since the last sync, port what matters to Polaris Terminal, and summarise the rest
disable-model-invocation: true
---

Bring Polaris Terminal (the terminal in `terminal/`) up to date with upstream. Work through the phases in order and report at the end. Paths below are from the Polaris repository root.

## 1. Refresh the reference checkout

The upstream tree lives at `terminal/references/repos/warp` and is git-ignored. It was cloned shallow, so deepen it before asking for history:

```bash
cd terminal/references/repos/warp
git rev-parse --is-shallow-repository        # if true:
git fetch --unshallow origin main || git fetch --depth=500 origin main
git fetch origin main --tags
```

If the directory is missing, clone it: `git clone https://github.com/warpdotdev/Warp.git terminal/references/repos/warp`.

## 2. Work out what is new

`terminal/docs/upstream-sync.md` records the last upstream commit Polaris Terminal was synced to. Read that SHA, then:

```bash
git -C terminal/references/repos/warp log --oneline <LAST_SYNCED>..origin/main
git -C terminal/references/repos/warp diff --stat <LAST_SYNCED>..origin/main
```

If the file has no SHA yet, use the commit the fork was imported from and say so.

## 3. Sort the changes

Group what you find, and be honest about which bucket each falls in:

- **Applies to Polaris Terminal** - the terminal itself, the renderer, PTY and shell handling, persistence, Windows-specific code, performance work, crash fixes.
- **Does not apply** - their cloud endpoints, auth, billing, telemetry, release and signing pipeline, their agent/factory infrastructure, anything reaching a `warp.dev` host. Polaris Terminal is detached from all of it.
- **Needs a decision** - changes that touch something Polaris Terminal deliberately altered. The list of those is in `terminal/docs/upstream-sync.md`; a GPU default and the block-table indexes are examples. Never silently revert one of Polaris Terminal's own fixes by taking an upstream change on top of it.

## 4. Port what applies

For each change worth taking, copy the upstream files in and re-apply the rename, which is what keeps the fork buildable:

```bash
python terminal/script/rebrand.py --dry-run    # inspect first
python terminal/script/rebrand.py
```

Read `terminal/script/rebrand.py`'s header before trusting it on new files: it deliberately preserves third-party repositories under the upstream organisation, the external crates whose package names carry the upstream brand, and the protobuf identifiers reached through `api::`. Renaming any of those breaks the build.

Ask the user before applying anything that changes behaviour they would notice, removes a feature, or lands on top of one of Polaris Terminal's own changes. Apply the rest yourself.

Verify from inside `terminal/` (its own workspace and toolchain) with `cargo check -p polaris-terminal` and, because that does not build test targets, `cargo check --workspace --all-targets`. That second one needs libclang; if it is unavailable locally, say so rather than claiming the tests compile.

## 5. Read what users are reporting

Upstream's tracker is the best source of symptoms Polaris Terminal inherits. Look for issues and merged PRs that match what Polaris Terminal is trying to fix - Windows performance, freezes, session restore, memory growth:

```bash
gh api -X GET search/issues -f q='repo:warpdotdev/warp is:issue windows performance' -f per_page=30 \
  --jq '.items[] | "\(.state)\t\(.comments)c\t#\(.number)\t\(.title)"'
gh pr list --repo warpdotdev/warp --state merged --limit 30 --search "performance OR windows OR freeze"
```

Prefer issues with a diagnosis in the comments over bare reports. When one names a root cause, check whether Polaris Terminal still has it.

## 6. Record and report

Update `terminal/docs/upstream-sync.md`: the new SHA, the date, what was ported, and what was deliberately skipped with the reason. That file is what makes the next run of this command cheap.

Then tell the user, in their language:

- What upstream changed that matters, in a few lines each.
- What you ported, and what you left.
- Anything user-reported that Polaris Terminal still has.
- Anything you need a decision on.

Do not commit unless the user asks. If you do commit, keep the ports in their own commits, separate from anything else.
