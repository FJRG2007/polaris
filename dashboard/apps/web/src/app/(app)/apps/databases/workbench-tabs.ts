"use client";

/**
 * What somebody has open in a database, and why it is still open tomorrow.
 *
 * A database client is not a page you read, it is a bench you work at: three
 * tables and the statement joining them, all at once, because the answer is in
 * the comparison rather than in any one of them. A single pane that swaps its
 * contents turns that into a sequence of round trips - open, read, remember,
 * open the other, compare against memory - and remembering a column of values
 * is exactly what nobody can do.
 *
 * So what is open stays open, and it stays open in this browser. Which tables
 * somebody is looking at is a fact about the afternoon they are having, not
 * about the database: the person beside them is looking at different ones, and
 * neither of them wants the other's. That makes `localStorage` the right home
 * rather than a shortcut, and it makes every read of it guarded - a private
 * window, cleared site data or a browser told to block storage all throw here
 * rather than returning nothing.
 *
 * The half-written statement is the part worth the trouble. A reload that loses
 * a table's rows costs a second; a reload that loses ten minutes of a query
 * costs the ten minutes, so the statement travels with the tab and is written
 * down with it.
 *
 * Everything here is a pure function over the state, so the awkward parts -
 * which tab is in front after closing the one that was, opening a table that is
 * already open - can be asserted rather than clicked through.
 */

/**
 * One thing open on the bench.
 *
 * A table tab carries the schema it was opened from rather than reading the one
 * currently picked in the sidebar. They are different questions: the sidebar is
 * where somebody is browsing now, a tab is what they opened then, and tying the
 * second to the first is how a tab silently starts asking a different schema for
 * a table of the same name.
 */
export type WorkbenchTab =
    | {
          readonly id: string;
          readonly kind: "table";
          readonly namespace: string | null;
          readonly relation: string;
      }
    | { readonly id: string; readonly kind: "query"; readonly statement: string }
    | { readonly id: string; readonly kind: "stats" };

export interface TabState {
    readonly tabs: readonly WorkbenchTab[];
    /** Which one is in front. Null only while nothing is open at all. */
    readonly activeId: string | null;
}

export const NO_TABS: TabState = { tabs: [], activeId: null };

/** A table is one tab however many times it is clicked, so its id is derived
 *  rather than drawn: clicking a name in the sidebar twice brings the tab
 *  forward instead of opening a second copy of it. */
export function tableTabId(namespace: string | null, relation: string): string {
    return `table:${namespace ?? ""}.${relation}`;
}

/** Activity is one view of the whole connection, so there is only ever one. */
const STATS_ID = "stats";

/** Statements are not derived from anything - two of them are two different
 *  pieces of work even when they start out identical - so their tabs get an id
 *  of their own. */
function draftId(): string {
    return `query:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function focused(state: TabState, id: string): TabState {
    return { tabs: state.tabs, activeId: id };
}

function appended(state: TabState, tab: WorkbenchTab): TabState {
    return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/** Open a table, or bring it forward if it is already open. */
export function openTable(state: TabState, namespace: string | null, relation: string): TabState {
    const id = tableTabId(namespace, relation);
    if (state.tabs.some((tab) => tab.id === id)) return focused(state, id);
    return appended(state, { id, kind: "table", namespace, relation });
}

/** A new, empty statement. Always new: somebody asking for one has something
 *  else to write, and handing them the one they already have would put it on
 *  top of what is in it. */
export function openQuery(state: TabState, statement = ""): TabState {
    return appended(state, { id: draftId(), kind: "query", statement });
}

export function openStats(state: TabState): TabState {
    if (state.tabs.some((tab) => tab.id === STATS_ID)) return focused(state, STATS_ID);
    return appended(state, { id: STATS_ID, kind: "stats" });
}

export function focusTab(state: TabState, id: string): TabState {
    if (!state.tabs.some((tab) => tab.id === id)) return state;
    return focused(state, id);
}

/**
 * Close one.
 *
 * Where the focus lands afterwards is the whole of this function. It goes to the
 * neighbour on the right, and to the left only when there is no right - which is
 * what every browser and every editor does, and therefore what the hand already
 * expects. Closing a tab that was not in front changes nothing about what is.
 */
export function closeTab(state: TabState, id: string): TabState {
    const at = state.tabs.findIndex((tab) => tab.id === id);
    if (at < 0) return state;
    const tabs = state.tabs.filter((tab) => tab.id !== id);
    if (state.activeId !== id) return { tabs, activeId: state.activeId };
    const next = tabs[at] ?? tabs[at - 1] ?? null;
    return { tabs, activeId: next?.id ?? null };
}

/** Everything except one, which is the "I have a dozen of these open and I want
 *  this one" gesture. The survivor is what is in front afterwards, whether or
 *  not it was before. */
export function closeOthers(state: TabState, id: string): TabState {
    const kept = state.tabs.find((tab) => tab.id === id);
    if (!kept) return state;
    return { tabs: [kept], activeId: kept.id };
}

/** What is currently typed into a statement tab. Kept on the tab so that
 *  switching away and back - and reloading - does not empty the box. */
export function writeStatement(state: TabState, id: string, statement: string): TabState {
    let changed = false;
    const tabs = state.tabs.map((tab) => {
        if (tab.id !== id || tab.kind !== "query" || tab.statement === statement) return tab;
        changed = true;
        return { ...tab, statement };
    });
    return changed ? { tabs, activeId: state.activeId } : state;
}

/** The label on the tab. A table is its own name; the schema is not repeated
 *  there, because it is the same schema for almost every tab and a strip of
 *  `public.` is a strip of nothing. */
export function tabTitle(tab: WorkbenchTab, shape: string): string {
    if (tab.kind === "table") return tab.relation;
    if (tab.kind === "stats") return "Activity";
    return shape === "sql" ? "SQL" : "Command";
}

/** The whole of what a tab points at, for the tooltip - where the schema does
 *  belong, because that is the question a tooltip is asked. */
export function tabSubtitle(tab: WorkbenchTab): string {
    if (tab.kind !== "table") return "";
    return tab.namespace ? `${tab.namespace}.${tab.relation}` : tab.relation;
}

function keyFor(connectionId: string): string {
    return `polaris:db-tabs:${connectionId}`;
}

/**
 * What was open last time, if any of it can be trusted.
 *
 * Anything in storage is somebody else's writing as far as this is concerned -
 * an older version of Polaris, a hand-edited value, a half-written entry from a
 * tab that was killed mid-write - so every field is checked and whatever does
 * not check out is dropped rather than repaired. A bench that opens with two of
 * its three tabs is a small loss; one that opens on a crash is not.
 */
export function readTabState(connectionId: string): TabState {
    try {
        const raw = window.localStorage.getItem(keyFor(connectionId));
        if (!raw) return NO_TABS;
        const parsed: unknown = JSON.parse(raw);
        return sanitizeTabState(parsed);
    } catch {
        return NO_TABS;
    }
}

/** The check itself, kept apart from the storage so it can be tested without
 *  one. */
export function sanitizeTabState(value: unknown): TabState {
    if (typeof value !== "object" || value === null) return NO_TABS;
    const record = value as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(record.tabs)) return NO_TABS;
    const tabs: WorkbenchTab[] = [];
    const seen = new Set<string>();
    for (const entry of record.tabs) {
        const tab = sanitizeTab(entry);
        // A duplicated id would give two tabs one identity, and everything
        // downstream - focus, close, the React key - would pick the first of
        // them and leave the other unreachable.
        if (!tab || seen.has(tab.id)) continue;
        seen.add(tab.id);
        tabs.push(tab);
    }
    const first = tabs[0];
    if (!first) return NO_TABS;
    const wanted = typeof record.activeId === "string" ? record.activeId : null;
    const active = wanted && seen.has(wanted) ? wanted : first.id;
    return { tabs, activeId: active };
}

function sanitizeTab(value: unknown): WorkbenchTab | null {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) return null;
    if (entry.kind === "stats") return { id: entry.id, kind: "stats" };
    if (entry.kind === "query") {
        return {
            id: entry.id,
            kind: "query",
            statement: typeof entry.statement === "string" ? entry.statement : ""
        };
    }
    if (entry.kind === "table" && typeof entry.relation === "string" && entry.relation.length > 0) {
        return {
            id: entry.id,
            kind: "table",
            namespace: typeof entry.namespace === "string" ? entry.namespace : null,
            relation: entry.relation
        };
    }
    return null;
}

export function writeTabState(connectionId: string, state: TabState): void {
    try {
        if (state.tabs.length === 0) {
            window.localStorage.removeItem(keyFor(connectionId));
            return;
        }
        window.localStorage.setItem(keyFor(connectionId), JSON.stringify(state));
    } catch {
        // The bench is on the screen either way; it simply will not be there
        // after a reload, which is the right thing to lose silently.
    }
}
