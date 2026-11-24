# Polar Code vs Claude Code: parity inventory

What the Code surface of the Claude Code desktop app offers, and where Polar Code
stands on each. Sources, read 2026-11-24:

- Desktop app: https://code.claude.com/docs/en/desktop
- Checkpoints and `/rewind`: https://code.claude.com/docs/en/checkpointing

"Has" and "partial" are from the files named, read in the source; "missing" means
nothing in `dashboard/apps/web/src/components/polar` implements it. A row marked
"unverified" was found by name only and needs a closer look before it is relied on.

## Composer

| Claude Code | Source | Polar Code today |
| --- | --- | --- |
| "+" menu: Add files or photos (Ctrl+U) | desktop | Has - `composer-plus-menu.tsx` (Chat and Code share it) |
| "+" menu: Add folder | desktop | Has - same menu |
| "+" menu: Slash commands | desktop | Has - same menu opens the "/" list |
| "+" menu: Plugins / Connectors / Skills, with "needs attention" | desktop | Has - submenu to settings, counts connectors that need sign-in |
| "+" menu opens the panes (Browser, Files, Terminal, ...) | desktop | Has - a session's "+" opens Files, Preview, Browser (own container), Changes, Terminal in `polar-code-workspace.tsx` |
| @mention files | desktop | Unverified |
| Attachments by drag and drop and paste | desktop | Has - `polar-panel.tsx` |
| Suggested prompt (Tab) | desktop | Has in Chat (`composer.suggestion`), Code unverified |
| Permission mode selector (Manual, Accept edits, Plan, Auto, Bypass) | desktop | Partial - `code-start-options.tsx` mode, set of modes differs |
| Model picker | desktop | Has - `code-model-picker.tsx` |
| Effort menu | desktop | Has - `api/polar/code/effort` |
| Environment selector (Local, SSH, Cloud, WSL) | desktop | Partial - "Runs on" (Polaris or an enrolled computer) |
| Project folder control | desktop | Has - repository and branch chip |
| Worktree toggle | desktop | Missing |
| Usage ring | desktop | Partial - `polar-usage.tsx` |
| Stop, and corrections mid-task | desktop | Has - `interrupt`, `queue` routes |

## Panes

| Claude Code | Source | Polar Code today |
| --- | --- | --- |
| Browser pane (Ctrl+Shift+B), Dev servers menu | desktop | Partial - `polar-code-browser.tsx`; no dev-server menu |
| Auto-verify changes | desktop | Missing |
| Changes (diff view) with line comments | desktop | Unverified - diff named in `polar-code.tsx` |
| Terminal (Ctrl+`) | desktop | Has - `shell-tabs.ts`, `polar-code-workspace.tsx` |
| Files pane (view, edit, auto save) | desktop | Partial - `polar-code-workspace.tsx`; editing unverified |
| Plan pane | desktop | Partial - plan asks in `polar-code-asks.tsx` |
| Background tasks / subagent pane | desktop | Has - `polar-code-subagents.tsx` |
| Side chat (`/btw`, Ctrl+;) | desktop | Missing |
| Session details: Environment, Changes, Context | desktop | Partial - `polar-code-context.tsx` |
| Minimize, expand, pop out a pane | desktop | Missing |
| iOS Simulator | desktop | Missing (macOS only upstream) |

## Session

| Claude Code | Source | Polar Code today |
| --- | --- | --- |
| Rewind: Restore code and conversation / conversation / code | checkpointing | Missing in Code; Chat has "Rewind here" (conversation) |
| Summarize from here / up to here | checkpointing | Partial - `/compact` of the whole thread |
| Checkpoint per prompt, kept with the session | checkpointing | Missing |
| Split view, new window | desktop | Missing |
| Archive, auto-archive after PR | desktop | Partial - remove from history |
| Transcript view modes | desktop | Partial - transcript export |
| Create PR, Auto-fix, Merge when ready, CI status | desktop | Partial - PR named in `polar-code.tsx`, rest unverified |
| Remote Control, Dispatch from phone | desktop | Has - web and mobile reach the same session |
| Notifications when a session finishes | desktop | Unverified |
| Computer use | desktop | Missing |
