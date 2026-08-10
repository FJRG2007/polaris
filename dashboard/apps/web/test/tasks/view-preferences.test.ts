/**
 * Remembering how somebody left a Tasks screen.
 *
 * What is worth pinning down is not the round trip through storage but what
 * happens when it goes wrong: a value written by an older build, a key somebody
 * edited by hand, a browser that refuses to store anything at all. None of those
 * may take the board down, because a preference is a convenience and a screen
 * that will not open is not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    readViewPreferences,
    viewScopeKey,
    writeViewPreferences
} from "../../src/app/(app)/tasks/view-preferences";

const store = new Map<string, string>();

function useWorkingStorage(): void {
    vi.stubGlobal("window", {
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key)
        }
    });
}

const preferences = {
    type: "table",
    groupBy: "priority",
    sort: { field: "manual", direction: "desc" },
    filter: { match: "all", conditions: [] },
    showClosed: true
} as const;

describe("what a Tasks screen was left looking like", () => {
    beforeEach(() => {
        store.clear();
        useWorkingStorage();
    });

    it("has nothing to say about a screen this browser has never opened", () => {
        expect(readViewPreferences("list-1")).toBeNull();
    });

    it("gives back what was written", () => {
        writeViewPreferences("list-1", preferences);
        expect(readViewPreferences("list-1")).toEqual(preferences);
    });

    it("keeps one screen's arrangement out of another's", () => {
        writeViewPreferences("list-1", preferences);
        expect(readViewPreferences("list-2")).toBeNull();
    });

    it("forgets rather than throws when the stored value is not JSON", () => {
        store.set("polaris.tasks.view.list-1", "{ not json");
        expect(readViewPreferences("list-1")).toBeNull();
    });

    it("forgets a preference naming a view or a sort this build does not have", () => {
        store.set(
            "polaris.tasks.view.list-1",
            JSON.stringify({ ...preferences, type: "kanban-3d" })
        );
        expect(readViewPreferences("list-1")).toBeNull();

        store.set(
            "polaris.tasks.view.list-2",
            JSON.stringify({ ...preferences, sort: { field: "vibes", direction: "asc" } })
        );
        expect(readViewPreferences("list-2")).toBeNull();
    });

    it("fills in anything an older build never wrote, opening on priority", () => {
        store.set("polaris.tasks.view.list-1", JSON.stringify({ type: "list" }));
        expect(readViewPreferences("list-1")).toEqual({
            type: "list",
            groupBy: "status",
            sort: { field: "priority", direction: "asc" },
            filter: { match: "all", conditions: [] },
            showClosed: false
        });
    });

    it("says nothing when the browser refuses to store anything", () => {
        const refusing = {
            localStorage: {
                getItem: () => {
                    throw new Error("Access denied");
                },
                setItem: () => {
                    throw new Error("Quota exceeded");
                }
            }
        };
        vi.stubGlobal("window", refusing);
        expect(() => writeViewPreferences("list-1", preferences)).not.toThrow();
        expect(readViewPreferences("list-1")).toBeNull();
    });
});

describe("which screen a preference belongs to", () => {
    it("names the list when there is one", () => {
        expect(viewScopeKey("list-1", "space-1")).toBe("list-1");
    });

    it("falls back to the space for a screen that spans its lists", () => {
        expect(viewScopeKey(null, "space-1")).toBe("space-1");
    });

    it("names Everything outright, since it belongs to no space", () => {
        // Not "" - an empty key would put every screen with no space of its own
        // on top of each other.
        expect(viewScopeKey(null, "")).toBe("everything");
    });
});
