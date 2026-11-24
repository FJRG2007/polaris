# Diagnosed bugs

What Rook was forked to fix, how each cause was established, and what was changed. One file per bug.

Every entry records the measurement the diagnosis rests on, because the point of these notes is to be able to tell later whether a change actually helped, and to avoid re-deriving the same investigation.

| Bug | Symptom it caused | State |
| --- | --- | --- |
| [Windows renders on the integrated GPU](windows-renders-on-the-integrated-gpu.md) | Typing, scrolling, selecting text and switching panes all stutter | Fixed |
| [The blocks table has no index](blocks-table-has-no-index.md) | A full table scan after every command and at startup | Fixed |
| [The session is not saved on shutdown](session-not-saved-on-shutdown.md) | Tabs, names and order lost after a restart - usually all but one. Four causes: no save on close, a dispatch silently discarded, a shutdown saving its own teardown, and Windows reaching every shell before the window - winit drops the session messages - so each tab closed as its shell died | Fixed |
| [A pane retains every block it ever made](panes-retain-every-block.md) | Gets worse the longer it runs, worse still with more panes and more agent output | Fixed |
| [The CLI-agent plugin makes everything slower](cli-agent-plugin-hooks-are-slow.md) | Every tool call, prompt and turn pauses once the Claude Code plugin is installed | Fixed |
| [A finished block keeps its output in dense cell storage](finished-blocks-keep-dense-cell-storage.md) | Memory far above what the visible text accounts for, growing with everything ever printed | Fixed |
| [The window stops responding while another program writes many files](main-thread-stalls-on-file-floods.md) | "Not responding" for 20 s to 3 min while a build, checkout or worktree fills a repository open in a tab: one stat per new file, on the UI thread | Fixed |
| [A restored pane comes back in the home directory](restored-panes-lose-their-directory.md) | Tabs restore, but each in the home directory rather than its own: a pane whose shell has not bootstrapped yet is saved as having no directory, and a short restart erases every one of them | Fixed |
| [`.git/info/exclude` is never loaded](git-info-exclude-is-never-loaded.md) | Whatever an agent excludes there - its worktrees, above all - counts as tracked, so every file it writes reaches the main thread, the subscribers, the tree and the search | Fixed |
| [The command still running at quit is missing from the restored session](running-command-lost-at-quit.md) | A command still executing when Rook quit - typically an agent such as `claude` left open overnight - is absent from the next launch while everything before it comes back | Fixed |

## Writing one of these

Keep the measurement. "It felt faster" cannot be checked by the next person; `2.14 ms -> 0.02 ms on a 76 MB database` can. State what was ruled out as well as what was found, and say plainly what a fix does not cover.
