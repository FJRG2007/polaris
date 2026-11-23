# Launcher: Raycast parity

The Polaris launcher is meant to do what Raycast does, cut by what each surface
can actually do. This is the inventory: every Raycast core feature, where
Polaris stands on it, which surfaces can offer it, and what it maps to in
Polaris. A feature a surface cannot do is hidden there, never offered and then
refused.

Sources: the Raycast manual's core-feature and power-feature sections
(manual.raycast.com: Search Bar, Action Panel, Command Aliases & Hotkeys,
Snippets, Quicklinks, Clipboard History, Notes, Focus, File Search,
Applications, Extensions, Translate, Emoji & Symbols, Calendar, Calculator,
Screenshots, Window Management, Navigation, Hyper Key, Cloud Sync, Dynamic
Placeholders, System Commands, Script Commands, Themes, Auto Quit, Run, AI).
Third-party store extensions are not features; the extension platform is.

## The surfaces

| Surface | What it is | What only it can do |
| --- | --- | --- |
| Desktop | Alt+Space window (`desktop/src/main/launcher.ts`), showing the dashboard's palette or its own panel (`renderer/launcher.tsx`) | Programs, the system clipboard, the OS (lock, sleep, windows, files), system-wide keys |
| Web palette | Ctrl+K / Alt+Space in the dashboard (`components/command-palette.tsx`) | Everything in the instance: pages, records, people, commands |
| Browser extension | The on-page launcher (`apps/extension/src/entrypoints/launcher-ui.tsx`) | The page in front: its fields, its selection, its tab |
| Mobile app | The dashboard in the phone shell | Share sheet, widgets, the phone's own search |
| TV | The TV launcher (`tv/launcher`) | Remote-driven search over media and apps |

Rules every row below follows:

- One command registry, each command declaring the surfaces it runs on, and one
  ranking (`@polaris/core` `frecency`) used by every surface.
- The desktop stays light: nothing new on a timer, lists cached.
- Everything is set from Settings; nothing needs a terminal.

## Inventory

Status: **have** (works today), **partial** (some of it), **missing**.
Surfaces: D desktop, W web palette, E extension, M mobile, T TV.

| Raycast feature | Status | Surfaces | Polaris mapping and notes |
| --- | --- | --- | --- |
| Root search (one field for everything) | have | D W E | The palette everywhere; desktop adds apps, clipboard, web |
| Frecency ranking (used most and lately first) | partial | D W E M T | Desktop ranks by use (`launcher-usage`); web palette keeps recent searches only. Next: the palette reads the same ranking |
| Favorites (pinned commands on top) | missing | D W E | Pin a row; stored on the account so it follows the person |
| Hide / rename results | missing | D W E | Per-row "Hide" and an alias; stored on the account (desktop apps: on the computer) |
| Command aliases | missing | D W E | Alias per command, matched before the ranking |
| Hotkey per command / app | missing | D | System-wide accelerator per command (desktop only; a page cannot hold a global key) |
| Hyper key | missing | D | OS-level remap; not Polaris's to do without a driver. Hidden |
| Action panel (more than one action per row) | partial | D W | Web rows have secondary actions (copy link, forget recent); desktop rows have one |
| Fallback commands (when nothing matches) | have | D | "Ask Polar" and "Search the web" close every list; engine chosen in Settings |
| Applications (launch, search) | have | D | `launcher-apps.ts` and store games (`launcher-stores.ts`), with icons |
| Auto quit apps | missing | D | Would need a timer watching foreground apps; against "stays light". Not planned |
| Calculator: arithmetic | have | D W | `quick-answer.ts` (desktop), `lib/search/calculate.ts` (web) |
| Calculator: units | have | D | Desktop quick answers; web palette lacks units |
| Calculator: currency | missing | D W | Needs a rates source the instance serves; cached, never fetched per keystroke |
| Calculator: time zones, dates | partial | W | Web palette clock rows; desktop missing |
| Clipboard history | have | D | Encrypted store, retention in Settings, "clip" prefix, clear |
| Clipboard: paste into the front app | missing | D | Needs a synthetic keystroke after hiding; per-OS |
| Clipboard: pinned entries | missing | D | Pin flag on the stored entry |
| Clipboard: images, files | missing | D | Text only today |
| Snippets | partial | W | Drive snippets are shared code files, not expansion text |
| Snippet text expansion | missing | D E | Desktop system-wide needs a keyboard hook (heavy, AV-sensitive); extension can expand in page fields |
| Dynamic placeholders ({date}, {clipboard}) | missing | D W E | Part of snippets and quicklinks |
| Quicklinks (saved URL with a query slot) | missing | D W E M | Stored on the account, `{query}` placeholder, opened by name |
| File search | partial | D W | Web: Drive results through the palette scopes. Desktop: local files missing (OS index: Windows Search, Spotlight `mdfind`, `locate`) |
| Window management (halves, thirds, maximize, move to display) | missing | D | Native window APIs per OS; macOS needs Accessibility permission |
| System commands (lock, sleep, restart, shut down, log out, empty bin) | have | D | Registry in `@polaris/core` `launcher-commands`, per-OS programs in `desktop/src/shared/system-commands.ts`; restart, shut down, log out and empty bin ask first. Hidden where the OS has no dependable command (lock on macOS, log out on Linux without a session id) |
| Script commands | missing | D | Run a user script from the launcher; needs a sandbox and a Settings screen to add them |
| Run (shell command) | missing | D | Same boundary as script commands |
| Extensions and store | partial | D W E | Polaris apps marketplace and the app extension registry (`docs/app-boundaries.md`); apps do not yet contribute launcher commands |
| Navigation (open a setting, a page) | have | D W E | Pages and the resource index |
| Emoji and symbols | missing | D W E | Static table in core, search by name; copy or insert |
| Translate | partial | W | The Translate app; no inline launcher answer yet |
| Dictionary / define word | missing | W | Not in Polaris; would need a source |
| Calendar (my schedule, join meeting) | partial | W | The Calendar app; no "next meeting" row or join action in the launcher |
| Notes / floating notes | partial | W D | The Notes app; a floating always-on-top note is desktop only |
| Focus sessions / do not disturb | missing | D W M | Polaris notification quiet hours exist per account; a timed focus from the launcher is missing |
| Screenshots search | missing | D | Desktop only; needs an index of the screenshots folder |
| AI: quick AI / chat | have | D W | "Ask Polar" opens Polar with the question; answers inline missing |
| AI commands (preset prompts on the selection) | missing | D W E | Polar presets run on the selection; the extension can read the page selection |
| AI extensions, MCP, agents | partial | W | Polar tools and MCP; not reachable as launcher commands |
| Dictation | partial | D | Voice widget exists; not wired to the launcher |
| Screen awareness | missing | D | Screen capture to Polar; needs consent each time |
| Contacts | have | W | "@" scope finds people |
| Themes | have | D W E | The dashboard's theme; the launcher follows it |
| Import / export settings | partial | W | Whole-Polaris export covers account data; launcher settings on the computer are not included |
| Cloud sync | have | W E | Account-stored data follows the person; desktop-only lists (clipboard, app use) stay on the computer by design |
| Teams: shared quicklinks and snippets | missing | W | Org-scoped quicklinks and snippets once those exist |
| Deeplinks to commands | partial | D | `polaris://` opens pages; not commands |
| iOS keyboard, widgets, share extension | missing | M | Mobile shell; out of the launcher's scope until the mobile app carries native surfaces |
| Games | have | D | Store games and game mode (the key goes to the game) |

## Ranked gaps

1. Extensions contribute commands (marketplace apps declare launcher commands
   with their surfaces).
2. Window management (desktop).
3. File search on the desktop (OS index).
4. Quicklinks and aliases.
5. Snippets with text expansion (extension in pages first; desktop needs a hook).
6. Hotkey per command.
7. Frecency in the web palette and the extension (desktop done).
8. Calculator currency and time zones on the desktop.
9. Emoji and symbol picker.
10. Clipboard: paste into the front app, pinned entries.
11. AI answers inline and AI commands.
12. Floating notes.
13. Calendar: next meeting and join.
14. Script commands.
15. Focus sessions.
16. Hide and rename results.

## Landed

| Slice | Surface | Where |
| --- | --- | --- |
| Frecency ranking | D | `packages/core/src/frecency.ts`, `desktop/src/main/launcher-usage.ts` |
| System commands | D (own panel and the dashboard's palette in the window) | `packages/core/src/launcher-commands.ts`, `desktop/src/shared/system-commands.ts`, `apps/web/src/lib/search/search-host.ts` |
