# `.git/info/exclude` is never loaded, so excluded subtrees count as tracked

**Symptom.** Everything an agent writes into a directory recorded in
`.git/info/exclude` - typically its own worktrees - is treated as a tracked
change: every path reaches the main thread, every subscriber, the file tree and
the file search, for as long as the repository is open in a tab.

This is the other half of
[main-thread-stalls-on-file-floods.md](main-thread-stalls-on-file-floods.md),
which that document named in its own "What this does not cover".

## Cause

`gitignores_for_directory` (`crates/repo_metadata/src/entry.rs`) built the
gitignore set from exactly two sources: `<dir>/.gitignore` and the user's global
gitignore. It never read `<repo>/.git/info/exclude`, which git applies with
identical semantics - only the file's location differs.

That one function feeds both consumers, so a single omission covered both:

- `Repository::new` stores the result in `self.gitignores`, which
  `Repository::check_gitignore_status` uses to tag every path in every
  filesystem event.
- `repo_watch_filter` passes it to `should_watch_repo_directory`, the descend
  predicate deciding which directories get a watch registered.

The file matters because it is the only one of the three a tool can add patterns
to without touching a file under version control. Claude Code records its
`.claude/` worktree root there rather than in `.gitignore`, and Rook itself
writes the skill symlinks it publishes into the same file
(`app/src/ai/agent_sdk/driver/harness/skill_dirs_publish.rs`).

## Fix

`gitignores_for_directory` now loads the exclude file as a third source.

Two details decide whether the patch works at all:

- **Anchoring.** `Gitignore::new(path)` roots patterns at the file's *parent*,
  which for `<repo>/.git/info/exclude` is `<repo>/.git/info`. A pattern
  `.claude/` would then be matched against `<repo>/.git/info/.claude`, never
  fire, and the change would look applied while doing nothing. The file is built
  through `GitignoreBuilder::new(<repo>)` instead, so it is anchored at the
  working tree.
- **Worktrees.** In a linked worktree `<root>/.git` is a file pointing at that
  worktree's gitdir, and git reads `info/exclude` from the *common* git
  directory. The pointer is resolved and the common directory is then found the
  way git finds it: a `commondir` file inside the gitdir names it, and without
  that file the gitdir is itself the common one. So a worktree opened in its own
  tab gets the same patterns the main working tree does. Looking for an ancestor
  named `.git` instead would answer for the usual layout only - a worktree of a
  bare `<name>.git` repository, which is the layout agent worktrees use, has no
  such ancestor and would load nothing at all, and a submodule (`.git` ->
  `<super>/.git/modules/<name>`) would be handed the superproject's file, its
  patterns anchored at the submodule root, while its own was never read.

The parse goes through `gitignore_cache`, whose entries are now keyed by
`(anchor root, file)` rather than by file alone: one exclude file is shared by
every linked worktree of a repository while each anchors it at its own root, so
a file-only key would hand the second worktree a matcher anchored at the first
one's root and mark the wrong paths ignored.

## What this does not cover

- **On Windows the flood itself remains.** The descend predicate that prunes
  gitignored directories is consulted only by the inotify backend; the fork's
  own `WatchFilter` documents this, and `windows.rs` applies only the emit
  predicate - which looks at `.git/` internals, not at gitignores. So
  `ReadDirectoryChangesW` keeps reporting every path under an excluded subtree
  and each one still crosses the main thread. What this fix removes is the work
  downstream of the tag: the file tree, the file search and every subscriber now
  skip those paths. On Linux it also stops the watch registration. Suppressing
  the events at the source on Windows means teaching the emit predicate about
  gitignores, which changes what subscribers see and is a separate change.
- **An edit to either ignore file still needs a restart to affect tagging.**
  `Repository::gitignores` is built once in `Repository::new` and never rebuilt;
  the tree-building path re-reads on each registration, so the two can disagree
  until the directory is registered again. That predates this change.

## Upstream

This code is upstream Warp's, unchanged, and the same defect is present there.
