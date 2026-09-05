/**
 * The bench somebody left open, and what happens to it.
 *
 * Tabs are one of those things nobody notices until they behave differently from
 * every other tabbed thing: close the one in front and the focus should land on
 * its right-hand neighbour, click a table already open and it should come
 * forward rather than open twice. The cases here are those - the ones a hand
 * expects without being able to say so - plus the reading of storage, which is
 * the only place in this feature where the input is somebody else's writing.
 */

import { describe, expect, it } from "vitest";
import * as bench from "../../src/app/(app)/apps/databases/workbench-tabs";

/** Three tables open, the last of them in front. */
function threeTables(): bench.TabState {
    return bench.openTable(bench.openTable(bench.openTable(bench.NO_TABS, "public", "users"), "public", "orders"), "public", "items");
}

describe("opening", () => {
    it("brings a table that is already open forward instead of opening it twice", () => {
        const state = bench.openTable(threeTables(), "public", "users");
        expect(state.tabs).toHaveLength(3);
        expect(state.activeId).toBe(state.tabs[0]?.id);
    });

    it("treats the same name in another schema as another table", () => {
        // Which it is. A tab carries the schema it was opened from precisely so
        // that these two can be on screen at once.
        const state = bench.openTable(threeTables(), "audit", "users");
        expect(state.tabs).toHaveLength(4);
    });

    it("gives every statement its own tab", () => {
        const state = bench.openQuery(bench.openQuery(bench.NO_TABS));
        expect(state.tabs).toHaveLength(2);
        expect(state.tabs[0]?.id).not.toBe(state.tabs[1]?.id);
    });

    it("has only one activity view however many times it is asked for", () => {
        const state = bench.openStats(bench.openStats(threeTables()));
        expect(state.tabs.filter((tab) => tab.kind === "stats")).toHaveLength(1);
        expect(state.activeId).toBe("stats");
    });

    it("ignores a request to focus something that is not open", () => {
        const state = threeTables();
        expect(bench.focusTab(state, "table:public.nothing")).toBe(state);
    });
});

describe("closing", () => {
    it("moves the focus to the neighbour on the right", () => {
        const state = bench.focusTab(threeTables(), "table:public.orders");
        const after = bench.closeTab(state, "table:public.orders");
        expect(after.activeId).toBe("table:public.items");
    });

    it("moves it to the left only when there is nothing on the right", () => {
        const after = bench.closeTab(threeTables(), "table:public.items");
        expect(after.activeId).toBe("table:public.orders");
    });

    it("leaves the focus alone when the closed tab was not in front", () => {
        const after = bench.closeTab(threeTables(), "table:public.users");
        expect(after.activeId).toBe("table:public.items");
        expect(after.tabs).toHaveLength(2);
    });

    it("ends with nothing in front once the last one goes", () => {
        const after = bench.closeTab(bench.openTable(bench.NO_TABS, null, "users"), "table:.users");
        expect(after.tabs).toHaveLength(0);
        expect(after.activeId).toBeNull();
    });

    it("keeps and focuses the survivor when the others go", () => {
        const after = bench.closeOthers(threeTables(), "table:public.users");
        expect(after.tabs).toHaveLength(1);
        expect(after.activeId).toBe("table:public.users");
    });
});

describe("the statement on a tab", () => {
    it("is kept on the tab it was typed into", () => {
        const opened = bench.openQuery(bench.openQuery(bench.NO_TABS));
        const first = opened.tabs[0];
        const state = bench.writeStatement(opened, first?.id ?? "", "select 1");
        expect(state.tabs[0]).toMatchObject({ statement: "select 1" });
        expect(state.tabs[1]).toMatchObject({ statement: "" });
    });

    it("changes nothing when the text is what it already was", () => {
        // The panel hands its text up on a timer, so this is asked far more
        // often than it is answered - and a new object each time is a write to
        // storage and a re-render each time.
        const opened = bench.openQuery(bench.NO_TABS, "select 1");
        expect(bench.writeStatement(opened, opened.tabs[0]?.id ?? "", "select 1")).toBe(opened);
    });

    it("is not written onto a tab that is not a statement", () => {
        const before = threeTables();
        expect(bench.writeStatement(before, "table:public.users", "select 1")).toBe(before);
    });
});

describe("what the label says", () => {
    it("names the table, without repeating the schema every tab shares", () => {
        expect(bench.tabTitle({ id: "x", kind: "table", namespace: "public", relation: "users" }, "sql")).toBe("users");
    });

    it("says what the database speaks rather than always saying SQL", () => {
        expect(bench.tabTitle({ id: "x", kind: "query", statement: "" }, "keyvalue")).toBe("Command");
    });
});

describe("reading what was stored", () => {
    it("keeps what checks out and drops what does not", () => {
        const state = bench.sanitizeTabState({
            tabs: [
                { id: "table:public.users", kind: "table", namespace: "public", relation: "users" },
                { id: "broken", kind: "table" },
                { id: "", kind: "stats" },
                "nonsense",
                { id: "query:1", kind: "query" }
            ],
            activeId: "query:1"
        });
        expect(state.tabs.map((tab) => tab.id)).toEqual(["table:public.users", "query:1"]);
        // A query with no statement in storage opens with an empty box rather
        // than not opening.
        expect(state.tabs[1]).toMatchObject({ kind: "query", statement: "" });
        expect(state.activeId).toBe("query:1");
    });

    it("refuses to hand back two tabs with one id", () => {
        const state = bench.sanitizeTabState({
            tabs: [
                { id: "stats", kind: "stats" },
                { id: "stats", kind: "stats" }
            ],
            activeId: "stats"
        });
        expect(state.tabs).toHaveLength(1);
    });

    it("falls back to the first tab when the stored focus is gone", () => {
        const state = bench.sanitizeTabState({
            tabs: [{ id: "stats", kind: "stats" }],
            activeId: "table:public.users"
        });
        expect(state.activeId).toBe("stats");
    });

    it("opens empty on anything it cannot read", () => {
        expect(bench.sanitizeTabState(null)).toEqual(bench.NO_TABS);
        expect(bench.sanitizeTabState({ tabs: "everything" })).toEqual(bench.NO_TABS);
        expect(bench.sanitizeTabState({ tabs: [{ id: "x", kind: "wat" }] })).toEqual(bench.NO_TABS);
    });
});
