/**
 * Every keyboard shortcut in Polaris, in one table, and the rules for moving one.
 *
 * Each app declares its actions here with the keys they answer to out of the
 * box. A screen never compares `event.key` itself: it asks which of its actions
 * a press is (`shortcutMatching`), against the bindings this person has - the
 * defaults, then what their account moved, then what this one device moved.
 * The settings screen, the help sheet in every app and the hints in menus all
 * read the same table, so a moved key is moved everywhere at once.
 *
 * Why it is shaped like this, from how others do it:
 *
 * - **One action, several keys** (VS Code, whiteboard help screens): the calendar's
 *   Day view is both `1` and `D`. A binding list per action, not one key.
 * - **Fixed keys** (Gmail, every list): Enter opens, Escape backs out, the arrows
 *   move. They are listed but not movable, and nothing else may take them - a
 *   list whose Escape was moved somewhere is a list nobody can leave.
 * - **Kept on the account** (Gmail's custom shortcuts, VS Code keybindings with
 *   Settings Sync): the keys follow somebody to the next machine they sign in
 *   on. **A device may differ** (Discord's desktop keybinds are local; VS Code
 *   syncs keybindings per platform), because a laptop and a desktop keyboard are
 *   not the same keyboard - see `resolveShortcuts`.
 * - **Conflicts are per scope**: `D` can be Day in the calendar and something
 *   else in Drive, because both are never listening at once. A scope that is a
 *   prefix of another overlaps it (`tasks` is listening while `tasks.calendar`
 *   is drawn), and `global` overlaps everything.
 *
 * Bindings are written `Mod+Shift+k`: modifiers first in a fixed order, then the
 * key. `Mod` is Ctrl, or Cmd on a Mac - either is accepted, as every screen here
 * always accepted both. A letter is written lowercase and Shift is its own word;
 * a symbol is written as the character it types (`?`, `#`), since Shift is what
 * types it. Named keys keep the browser's names (`Delete`, `ArrowUp`, `F2`), and
 * the space bar is `Space`.
 *
 * Pure, and safe in the browser and on the server alike.
 */

import { z } from "zod";
import { LAUNCHER_SHORTCUTS } from "./launcher.js";

export * from "./key-binding.js";
import { bindingOfEvent, normalizeBinding, isBindable } from "./key-binding.js";

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** The apps a shortcut is listed under, in the order the settings list them. */
export const SHORTCUT_APPS = [
    "general",
    "mail",
    "tasks",
    "calendar",
    "drive",
    "viewer",
    "chat",
    "places",
    "databases",
    "vault",
    "office",
    "code"
] as const;

export type ShortcutApp = (typeof SHORTCUT_APPS)[number];

export interface ShortcutDefinition {
    /** `app.group.action`. Its words are `shortcuts.actions.<id>` in the catalog. */
    readonly id: string;
    readonly app: ShortcutApp;
    /** The box it is listed in on the help sheet: `shortcuts.groups.<group>`. */
    readonly group: string;
    /** Where it is listening - see the module comment for how scopes overlap. */
    readonly scope: string;
    /** The keys it answers to until somebody moves them. Empty for an action
     *  whose only keys are fixed. */
    readonly defaults: readonly string[];
    /** Keys it always answers to, that cannot be moved and nothing else may take. */
    readonly fixed?: readonly string[];
}

type Entry = [id: string, group: string, scope: string, defaults: string[], fixed?: string[]];

/** Every definition of one app, from a compact table. */
function app(name: ShortcutApp, entries: readonly Entry[]): ShortcutDefinition[] {
    return entries.map(([id, group, scope, defaults, fixed]) => ({
        id: `${name}.${id}`,
        app: name,
        group,
        scope,
        defaults,
        ...(fixed ? { fixed } : {})
    }));
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
    ...app("general", [
        // Alt+Space first, as launchers bind it; Ctrl/Cmd+K for when the OS or a
        // launcher keeps Alt+Space (`launcher.ts` explains both).
        ["commandPalette", "general", "global", [...LAUNCHER_SHORTCUTS]],
        // Every list with a name to change - a folder, a server, a note, a camera.
        ["rename", "general", "rename", ["F2"]],
        // The same lists' Delete, which asks before it removes anything - and
        // Backspace, which is the same key on a Mac laptop.
        ["delete", "general", "remove", ["Delete", "Backspace"]]
    ]),
    // Gmail's letters, which every mail client since has used.
    ...app("mail", [
        ["compose", "mailWrite", "mail", ["c"]],
        ["reply", "mailWrite", "mail", ["r"]],
        ["replyAll", "mailWrite", "mail", ["a"]],
        ["forward", "mailWrite", "mail", ["f"]],
        ["archive", "mailActions", "mail", ["e"]],
        ["trash", "mailActions", "mail", ["#"], ["Delete", "Backspace"]],
        ["junk", "mailActions", "mail", ["!"]],
        ["star", "mailActions", "mail", ["s"]],
        ["important", "mailActions", "mail", ["i"]],
        ["pin", "mailActions", "mail", ["p"]],
        ["mute", "mailActions", "mail", ["m"]],
        ["markUnread", "mailActions", "mail", ["u"]],
        ["next", "mailMove", "mail", ["j"], ["ArrowDown"]],
        ["previous", "mailMove", "mail", ["k"], ["ArrowUp"]],
        ["open", "mailMove", "mail", [], ["Enter"]],
        ["back", "mailMove", "mail", [], ["Escape"]],
        ["selectAll", "mailMove", "mail", ["Mod+a"]],
        ["search", "mailMove", "mail", ["/"]],
        ["refresh", "mailMove", "mail", ["g"]],
        ["help", "mailMove", "mail", ["?"]]
    ]),
    ...app("tasks", [
        ["new", "tasksList", "tasks", ["n"]],
        ["delete", "tasksList", "tasks", ["Delete"]],
        ["selectAll", "tasksList", "tasks", ["Mod+a"]],
        ["copy", "tasksList", "tasks", ["Mod+c"]],
        ["paste", "tasksList", "tasks", ["Mod+v"]],
        ["clearSelection", "tasksList", "tasks", [], ["Escape"]],
        ["rows.next", "tasksRows", "tasks.rows", ["j"], ["ArrowDown"]],
        ["rows.previous", "tasksRows", "tasks.rows", ["k"], ["ArrowUp"]],
        ["rows.open", "tasksRows", "tasks.rows", [], ["Enter"]],
        ["rows.select", "tasksRows", "tasks.rows", ["x"]],
        ["rows.leave", "tasksRows", "tasks.rows", [], ["Escape"]],
        // Google Calendar's own keys, so a hand that learned them there is home.
        ["calendar.day", "tasksCalendar", "tasks.calendar", ["d"]],
        ["calendar.week", "tasksCalendar", "tasks.calendar", ["w"]],
        ["calendar.month", "tasksCalendar", "tasks.calendar", ["m"]],
        ["calendar.year", "tasksCalendar", "tasks.calendar", ["y"]],
        ["calendar.schedule", "tasksCalendar", "tasks.calendar", ["a"]],
        ["calendar.fourDays", "tasksCalendar", "tasks.calendar", ["x"]],
        ["calendar.today", "tasksCalendar", "tasks.calendar", ["t"]],
        ["calendar.next", "tasksCalendar", "tasks.calendar", ["j"]],
        ["calendar.previous", "tasksCalendar", "tasks.calendar", ["k"]]
    ]),
    // The union of Nextcloud's and Google's.
    ...app("calendar", [
        ["previous", "calendarMove", "calendar", ["k", "p"]],
        ["next", "calendarMove", "calendar", ["j", "n"]],
        ["today", "calendarMove", "calendar", ["t"]],
        ["goTo", "calendarMove", "calendar", ["g"]],
        ["view.day", "calendarViews", "calendar", ["1", "d"]],
        ["view.week", "calendarViews", "calendar", ["2", "w"]],
        ["view.month", "calendarViews", "calendar", ["3", "m"]],
        ["view.year", "calendarViews", "calendar", ["4", "y"]],
        ["view.list", "calendarViews", "calendar", ["5", "l", "a"]],
        ["view.days", "calendarViews", "calendar", ["6", "x"]],
        ["create", "calendarEvents", "calendar", ["c"]],
        ["open", "calendarEvents", "calendar", ["e"]],
        ["delete", "calendarEvents", "calendar", ["Delete", "Backspace"]],
        ["undo", "calendarEvents", "calendar", ["z"]],
        ["copy", "calendarEvents", "calendar.grid", ["Mod+c"]],
        ["paste", "calendarEvents", "calendar.grid", ["Mod+v"]],
        ["search", "calendarApp", "calendar", ["/"]],
        ["refresh", "calendarApp", "calendar", ["r"]],
        ["settings", "calendarApp", "calendar", ["s"]],
        ["addCalendar", "calendarApp", "calendar", ["+"]],
        ["help", "calendarApp", "calendar", ["?"]],
        ["close", "calendarApp", "calendar", [], ["Escape"]],
        [
            "grid.moveFocus",
            "calendarGrid",
            "calendar.grid",
            [],
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
        ],
        ["grid.createHere", "calendarGrid", "calendar.grid", [], ["Enter"]],
        ["grid.menu", "calendarGrid", "calendar.grid", ["Shift+F10"], ["ContextMenu"]],
        ["editor.save", "calendarEditor", "calendar.editor", ["Mod+Enter", "Mod+s"]],
        ["editor.delete", "calendarEditor", "calendar.editor", ["Mod+Delete", "Mod+Backspace"]],
        ["editor.duplicate", "calendarEditor", "calendar.editor", ["Mod+d"]],
        ["stopwatch.startStop", "calendarClock", "clock", [], ["Space"]],
        ["stopwatch.lap", "calendarClock", "clock", ["l"]],
        ["stopwatch.reset", "calendarClock", "clock", ["r"]]
    ]),
    ...app("drive", [
        ["newFolder", "driveCreate", "drive", ["n"]],
        ["newFile", "driveCreate", "drive", ["f"]],
        ["uploadFiles", "driveCreate", "drive", ["u"]],
        ["uploadFolder", "driveCreate", "drive", ["Shift+u"]],
        ["requestFiles", "driveCreate", "drive", ["r"]],
        ["selectAll", "driveFiles", "drive", ["Mod+a"]],
        ["copy", "driveFiles", "drive", ["Mod+c"]],
        ["cut", "driveFiles", "drive", ["Mod+x"]],
        ["paste", "driveFiles", "drive", ["Mod+v"]],
        ["open", "driveFiles", "drive", [], ["Enter"]],
        ["delete", "driveFiles", "drive", ["Delete"]],
        ["clearSelection", "driveFiles", "drive", [], ["Escape"]]
    ]),
    // Whatever is being looked at: a file, a document, a deck, a picture.
    ...app("viewer", [
        ["find", "viewerRead", "viewer", ["Mod+f"]],
        ["previousFile", "viewerRead", "viewer.files", ["ArrowLeft"]],
        ["nextFile", "viewerRead", "viewer.files", ["ArrowRight"]],
        ["previousSlide", "viewerSlides", "viewer.slides", ["ArrowLeft"]],
        ["nextSlide", "viewerSlides", "viewer.slides", ["ArrowRight", "Space"]],
        ["firstSlide", "viewerSlides", "viewer.slides", ["Home"]],
        ["lastSlide", "viewerSlides", "viewer.slides", ["End"]],
        ["zoomIn", "viewerPictures", "viewer.picture", ["+", "="]],
        ["zoomOut", "viewerPictures", "viewer.picture", ["-"]]
    ]),
    ...app("chat", [
        ["reply", "chatMessages", "chat", ["r"]],
        ["edit", "chatMessages", "chat", ["F2"]],
        ["delete", "chatMessages", "chat", ["Delete"]],
        ["copy", "chatMessages", "chat", ["Mod+c"]],
        // Alt+M rather than Alt+D, which is the address bar in Chrome and Edge.
        ["dictate", "chatComposer", "chat", ["Alt+m"]],
        ["toggleMic", "chatCalls", "call", ["F9"]],
        ["toggleDeafen", "chatCalls", "call", ["F10"]]
    ]),
    ...app("places", [
        ["clips.selectAll", "placesClips", "places.clips", ["Mod+a"]],
        ["clips.delete", "placesClips", "places.clips", ["Delete"]],
        ["clips.open", "placesClips", "places.clips", [], ["Enter"]],
        ["clips.clearSelection", "placesClips", "places.clips", [], ["Escape"]]
    ]),
    ...app("databases", [["run", "databasesQuery", "databases", ["Mod+Enter"]]]),
    // On the entry that has focus in the list.
    ...app("vault", [
        ["copyPassword", "vaultItems", "vault", ["Mod+c"]],
        ["copyUsername", "vaultItems", "vault", ["Mod+Shift+c"]],
        ["edit", "vaultItems", "vault", ["F2"], ["Enter"]],
        ["delete", "vaultItems", "vault", ["Delete"]]
    ]),
    // The slides editor, on the slide being made. Google Slides' and
    // PowerPoint's keys, which are what anybody who has made a deck reaches for.
    ...app("office", [
        ["slides.undo", "officeSlides", "office.slides", ["Mod+z"]],
        ["slides.redo", "officeSlides", "office.slides", ["Mod+Shift+z", "Mod+y"]],
        ["slides.duplicate", "officeSlides", "office.slides", ["Mod+d"]],
        ["slides.delete", "officeSlides", "office.slides", [], ["Delete", "Backspace"]],
        ["slides.edit", "officeSlides", "office.slides", ["F2"], ["Enter"]],
        ["slides.deselect", "officeSlides", "office.slides", [], ["Escape"]],
        [
            "slides.nudge",
            "officeSlides",
            "office.slides",
            [],
            ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
        ],
        [
            "slides.nudgeFar",
            "officeSlides",
            "office.slides",
            [],
            ["Shift+ArrowUp", "Shift+ArrowDown", "Shift+ArrowLeft", "Shift+ArrowRight"]
        ],
        ["slides.present", "officeSlides", "office.slides", ["Mod+Enter"]],
        ["slides.presentFromStart", "officeSlides", "office.slides", ["Mod+Shift+Enter"]],
        ["slides.newSlide", "officeSlides", "office.slides", ["Mod+m"]],
        ["slides.help", "officeSlides", "office.slides", ["?"]],
        // The chosen box, as Google Slides formats and arranges one.
        ["slides.bold", "officeSlides", "office.slides", ["Mod+b"]],
        ["slides.italic", "officeSlides", "office.slides", ["Mod+i"]],
        ["slides.underline", "officeSlides", "office.slides", ["Mod+u"]],
        ["slides.align.left", "officeSlides", "office.slides", ["Mod+Shift+l"]],
        ["slides.align.center", "officeSlides", "office.slides", ["Mod+Shift+e"]],
        ["slides.align.right", "officeSlides", "office.slides", ["Mod+Shift+r"]],
        ["slides.bringForward", "officeSlides", "office.slides", ["Mod+ArrowUp"]],
        ["slides.sendBackward", "officeSlides", "office.slides", ["Mod+ArrowDown"]],
        ["slides.bringToFront", "officeSlides", "office.slides", ["Mod+Shift+ArrowUp"]],
        ["slides.sendToBack", "officeSlides", "office.slides", ["Mod+Shift+ArrowDown"]],
        ["slides.selectAll", "officeSlides", "office.slides", ["Mod+a"]],
        ["slides.group", "officeSlides", "office.slides", ["Mod+Alt+g"]],
        ["slides.ungroup", "officeSlides", "office.slides", ["Mod+Alt+Shift+g"]],
        // On the column of slides, with one of them focused.
        ["slideList.previous", "officeSlideList", "office.slideList", [], ["ArrowUp", "ArrowLeft"]],
        ["slideList.next", "officeSlideList", "office.slideList", [], ["ArrowDown", "ArrowRight"]],
        ["slideList.first", "officeSlideList", "office.slideList", [], ["Home"]],
        ["slideList.last", "officeSlideList", "office.slideList", [], ["End"]],
        ["slideList.moveUp", "officeSlideList", "office.slideList", ["Mod+ArrowUp"]],
        ["slideList.moveDown", "officeSlideList", "office.slideList", ["Mod+ArrowDown"]],
        ["slideList.duplicate", "officeSlideList", "office.slideList", ["Mod+d"]],
        ["slideList.delete", "officeSlideList", "office.slideList", [], ["Delete", "Backspace"]]
    ]),
    // Polar Code. OpenCode's keybinds (`session_new`, `session_list`,
    // `sidebar_toggle`, `model_list`, `command_list`, `session_interrupt`) sit
    // behind a Ctrl+X leader in a terminal; a browser keeps Ctrl+N/W/T/P, so
    // these take Alt instead, and Escape stops a turn only when pressed twice.
    ...app("code", [
        ["newSession", "codeSessions", "polar.code", ["Alt+n"]],
        ["nextSession", "codeSessions", "polar.code", ["Alt+ArrowDown"]],
        ["previousSession", "codeSessions", "polar.code", ["Alt+ArrowUp"]],
        ["interrupt", "codeSessions", "polar.code", ["Escape"]],
        ["focusComposer", "codeComposer", "polar.code", ["i"]],
        ["commands", "codeComposer", "polar.code", ["Mod+/"]],
        ["modelPicker", "codeComposer", "polar.code", ["Alt+m"]],
        ["toggleHistory", "codePanels", "polar.code", ["Alt+b"]],
        ["toggleWorkspace", "codePanels", "polar.code", ["Alt+w"]],
        ["help", "codePanels", "polar.code", ["?"]]
    ])
];

const BY_ID = new Map(SHORTCUTS.map((definition) => [definition.id, definition]));

/** One definition by its id, or undefined for one that does not exist. */
export function shortcutDefinition(id: string): ShortcutDefinition | undefined {
    return BY_ID.get(id);
}

/** Whether somebody may move an action's keys: it has keys of its own to move. */
export function isRebindable(definition: ShortcutDefinition): boolean {
    return definition.defaults.length > 0;
}

// ---------------------------------------------------------------------------
// What somebody changed
// ---------------------------------------------------------------------------

/** What an account or a device moved: the whole list of keys of each action it
 *  changed. An empty list switches the action's movable keys off. Anything not
 *  named keeps its defaults. */
export type ShortcutOverrides = Readonly<Record<string, readonly string[]>>;

export const NO_SHORTCUT_OVERRIDES: ShortcutOverrides = {};

/** The most keys one action may hold. */
export const MAX_BINDINGS_PER_SHORTCUT = 4;

/** Every action's keys, from the defaults up: the account's changes, then this
 *  device's. Fixed keys are not in it - they never move. */
export function resolveShortcuts(
    account: ShortcutOverrides = NO_SHORTCUT_OVERRIDES,
    device: ShortcutOverrides = NO_SHORTCUT_OVERRIDES
): ReadonlyMap<string, readonly string[]> {
    const out = new Map<string, readonly string[]>();
    for (const definition of SHORTCUTS) {
        const chosen = device[definition.id] ?? account[definition.id] ?? definition.defaults;
        out.set(
            definition.id,
            chosen.flatMap((binding) => normalizeBinding(binding) ?? [])
        );
    }
    return out;
}

/** Every key an action answers to: its movable ones, then its fixed ones. */
export function keysOf(
    resolved: ReadonlyMap<string, readonly string[]>,
    id: string
): readonly string[] {
    const definition = BY_ID.get(id);
    if (!definition) return [];
    return [...(resolved.get(id) ?? definition.defaults), ...(definition.fixed ?? [])];
}

/** Whether two scopes are ever listening at the same time. */
export function scopesOverlap(left: string, right: string): boolean {
    if (left === "global" || right === "global") return true;
    return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

export interface ShortcutConflict {
    readonly binding: string;
    /** The actions holding it, in table order. */
    readonly ids: readonly string[];
}

/**
 * Every key two actions would both answer to while both are listening.
 *
 * A fixed key held by two actions in nested scopes is not a conflict - the list
 * and the rows inside it both answer Escape, and always have, each for its own
 * thing - but a movable key landing on anything another action answers to is.
 */
export function shortcutConflicts(
    resolved: ReadonlyMap<string, readonly string[]>
): ShortcutConflict[] {
    const holders: { binding: string; id: string; scope: string; fixed: boolean }[] = [];
    for (const definition of SHORTCUTS) {
        for (const binding of resolved.get(definition.id) ?? [])
            holders.push({ binding, id: definition.id, scope: definition.scope, fixed: false });
        for (const binding of definition.fixed ?? [])
            holders.push({ binding, id: definition.id, scope: definition.scope, fixed: true });
    }
    const found = new Map<string, Set<string>>();
    for (let a = 0; a < holders.length; a += 1) {
        for (let b = a + 1; b < holders.length; b += 1) {
            const left = holders[a]!;
            const right = holders[b]!;
            if (left.binding !== right.binding || left.id === right.id) continue;
            if (left.fixed && right.fixed) continue;
            if (!scopesOverlap(left.scope, right.scope)) continue;
            const ids = found.get(left.binding) ?? new Set<string>();
            ids.add(left.id).add(right.id);
            found.set(left.binding, ids);
        }
    }
    const order = new Map(SHORTCUTS.map((definition, at) => [definition.id, at]));
    return [...found].map(([binding, ids]) => ({
        binding,
        ids: [...ids].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    }));
}

/** The actions a binding would collide with if `id` took it, given what is
 *  resolved now. Empty when it is free. */
export function conflictsFor(
    resolved: ReadonlyMap<string, readonly string[]>,
    id: string,
    binding: string
): string[] {
    const definition = BY_ID.get(id);
    const normalized = normalizeBinding(binding);
    if (!definition || !normalized) return [];
    const out: string[] = [];
    for (const other of SHORTCUTS) {
        if (other.id === id || !scopesOverlap(definition.scope, other.scope)) continue;
        const held = [...(resolved.get(other.id) ?? []), ...(other.fixed ?? [])];
        if (held.includes(normalized)) out.push(other.id);
    }
    return out;
}

/**
 * A stored set of changes, read back defensively: only actions that exist and
 * may be moved, only bindings that parse and may be chosen, each once, and an
 * action equal to its defaults is no change at all. A set that would make two
 * actions collide is dropped whole rather than half-applied - the defaults
 * always work, a half-moved keyboard may not.
 *
 * A device's set is checked over the account's, `under` it: that is what it is
 * laid on, so a key the account moved away is free for the device to take.
 */
export function cleanShortcutOverrides(
    raw: unknown,
    under: ShortcutOverrides = NO_SHORTCUT_OVERRIDES
): ShortcutOverrides {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NO_SHORTCUT_OVERRIDES;
    const kept: Record<string, readonly string[]> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const definition = BY_ID.get(id);
        if (!definition || !isRebindable(definition) || !Array.isArray(value)) continue;
        const bindings = [
            ...new Set(
                value.flatMap((entry) =>
                    typeof entry === "string" && isBindable(entry) ? [normalizeBinding(entry)!] : []
                )
            )
        ].slice(0, MAX_BINDINGS_PER_SHORTCUT);
        if (sameBindings(bindings, definition.defaults)) continue;
        kept[id] = bindings;
    }
    return shortcutConflicts(resolveShortcuts(under, kept)).length > 0
        ? NO_SHORTCUT_OVERRIDES
        : kept;
}

/** Whether two lists of bindings are the same keys in the same order. */
export function sameBindings(left: readonly string[], right: readonly string[]): boolean {
    const a = left.map((binding) => normalizeBinding(binding) ?? binding);
    const b = right.map((binding) => normalizeBinding(binding) ?? binding);
    return a.length === b.length && a.every((binding, at) => binding === b[at]);
}

/** A save from the settings screen. The words are English and never shown:
 *  the screen checks the same rules first and says them in the reader's
 *  language; these are the server refusing a request that skipped it. */
export const shortcutOverridesSchema = z
    .record(z.string().max(80), z.array(z.string().max(40)).max(MAX_BINDINGS_PER_SHORTCUT))
    .superRefine((value, context) => {
        if (Object.keys(value).length > SHORTCUTS.length)
            context.addIssue({ code: "custom", message: "Too many shortcuts." });
        for (const [id, bindings] of Object.entries(value)) {
            const definition = BY_ID.get(id);
            if (!definition || !isRebindable(definition)) {
                context.addIssue({ code: "custom", message: "Not a shortcut.", path: [id] });
                continue;
            }
            for (const binding of bindings) {
                if (!isBindable(binding))
                    context.addIssue({ code: "custom", message: "Not a key.", path: [id] });
            }
        }
        const conflicts = shortcutConflicts(resolveShortcuts(value));
        if (conflicts.length > 0)
            context.addIssue({ code: "custom", message: "Two actions share a key." });
    });

/** Changes with one action's keys set; back to no change when they are its
 *  defaults. */
export function withBindings(
    overrides: ShortcutOverrides,
    id: string,
    bindings: readonly string[]
): ShortcutOverrides {
    const definition = BY_ID.get(id);
    const next: Record<string, readonly string[]> = { ...overrides };
    if (!definition || sameBindings(bindings, definition.defaults)) delete next[id];
    else next[id] = bindings.flatMap((binding) => normalizeBinding(binding) ?? []);
    return next;
}

/** Changes with one action put back on its defaults. */
export function withoutOverride(overrides: ShortcutOverrides, id: string): ShortcutOverrides {
    if (!(id in overrides)) return overrides;
    const next: Record<string, readonly string[]> = { ...overrides };
    delete next[id];
    return next;
}

// ---------------------------------------------------------------------------
// Pressing
// ---------------------------------------------------------------------------

/**
 * Which of `ids` a press is, or null when it is none of them. The first one in
 * `ids` wins when two could answer - which only happens between scopes that are
 * never listening at once.
 */
export function shortcutMatching(
    resolved: ReadonlyMap<string, readonly string[]>,
    event: Parameters<typeof bindingOfEvent>[0],
    ids: readonly string[]
): string | null {
    const pressed = bindingOfEvent(event);
    if (!pressed) return null;
    for (const id of ids) if (keysOf(resolved, id).includes(pressed)) return id;
    return null;
}

/** Whether a press is `id`. */
export function isShortcut(
    resolved: ReadonlyMap<string, readonly string[]>,
    event: Parameters<typeof bindingOfEvent>[0],
    id: string
): boolean {
    return shortcutMatching(resolved, event, [id]) === id;
}

/** The keymap Mail kept on its own before every app shared this table, as
 *  changes here - so somebody who moved a key in Mail finds it moved still. */
export function overridesFromMailKeymap(
    keymap: Readonly<Partial<Record<string, string>>>
): ShortcutOverrides {
    const out: Record<string, readonly string[]> = {};
    for (const [command, key] of Object.entries(keymap)) {
        if (typeof key !== "string") continue;
        const id = `mail.${command}`;
        const definition = BY_ID.get(id);
        if (!definition || !isRebindable(definition)) continue;
        // Mail told `A` from `a` by the character: the capital was Shift.
        const binding = normalizeBinding(
            [...key].length === 1 && key !== key.toLowerCase() ? `Shift+${key}` : key
        );
        if (binding && !sameBindings([binding], definition.defaults)) out[id] = [binding];
    }
    return out;
}
