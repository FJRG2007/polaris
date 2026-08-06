/**
 * What the browser remembers between searches.
 *
 * Two things are being protected. A stored entry is untrusted input that ends up
 * being navigated to, so anything that is not a path inside Polaris has to be
 * dropped on the way back in rather than drawn as somewhere to click. And the
 * list has to stay the handful somebody recognizes: opening the same task twice
 * is one memory, not two, and the cap holds however much is written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT_SEARCHES, mergeRecentSearches, recentSearchKey, type RecentSearch } from "@polaris/core";
import {
    clearRecentSearches,
    forgetRecentSearch,
    mergeIntoStore,
    readRecentSearches,
    rememberSearch
} from "@/lib/search/recent";

const STORE_KEY = "polaris.search.recent";

/** The narrow slice of `window` the store actually touches. */
function fakeWindow() {
    const cells = new Map<string, string>();
    return {
        cells,
        localStorage: {
            getItem: (key: string) => cells.get(key) ?? null,
            setItem: (key: string, value: string) => void cells.set(key, value),
            removeItem: (key: string) => void cells.delete(key)
        }
    };
}

let store = fakeWindow();

beforeEach(() => {
    store = fakeWindow();
    vi.stubGlobal("window", store);
});

function stored(): unknown {
    return JSON.parse(store.cells.get(STORE_KEY) ?? "[]");
}

describe("remembering a search", () => {
    it("keeps what was opened, newest first", () => {
        rememberSearch({ kind: "result", scope: "tasks", term: "release", label: "Ship 2.1", href: "/tasks/t/a" });
        const list = rememberSearch({ kind: "result", scope: null, term: "", label: "Servers", href: "/apps/servers" });
        expect(list.map((entry) => entry.label)).toEqual(["Servers", "Ship 2.1"]);
        expect(readRecentSearches()).toHaveLength(2);
    });

    it("counts opening the same thing again as one memory", () => {
        rememberSearch({ kind: "result", scope: "tasks", term: "a", label: "Ship 2.1", href: "/tasks/t/a" });
        const list = rememberSearch({ kind: "result", scope: "tasks", term: "b", label: "Ship 2.1", href: "/tasks/t/a" });
        expect(list).toHaveLength(1);
        expect(list[0]?.term).toBe("b");
    });

    it("tells a remembered query apart from a remembered result", () => {
        rememberSearch({ kind: "query", scope: "tasks", term: "release", label: "release", href: null });
        const list = rememberSearch({
            kind: "result",
            scope: "tasks",
            term: "release",
            label: "Ship 2.1",
            href: "/tasks/t/a"
        });
        expect(list).toHaveLength(2);
    });

    it("holds the cap however much is written", () => {
        for (let index = 0; index < MAX_RECENT_SEARCHES + 8; index += 1) {
            rememberSearch({ kind: "result", scope: null, term: "", label: `Page ${index}`, href: `/p/${index}` });
        }
        expect(readRecentSearches()).toHaveLength(MAX_RECENT_SEARCHES);
    });

    it("forgets one entry, and all of them", () => {
        rememberSearch({ kind: "result", scope: null, term: "", label: "Servers", href: "/apps/servers" });
        rememberSearch({ kind: "result", scope: null, term: "", label: "Drive", href: "/drive" });
        const key = recentSearchKey({ kind: "result", scope: null, term: "", href: "/drive" });
        expect(forgetRecentSearch(key).map((entry) => entry.label)).toEqual(["Servers"]);
        clearRecentSearches();
        expect(readRecentSearches()).toEqual([]);
    });
});

describe("reading back what was stored", () => {
    it("drops an entry pointing anywhere but inside Polaris", () => {
        store.cells.set(
            STORE_KEY,
            JSON.stringify([
                { kind: "result", scope: null, term: "", label: "Real", href: "/drive", usedAt: "2026-08-06T10:00:00Z" },
                {
                    kind: "result",
                    scope: null,
                    term: "",
                    label: "Script",
                    // eslint-disable-next-line no-script-url
                    href: "javascript:alert(1)",
                    usedAt: "2026-08-06T11:00:00Z"
                },
                {
                    kind: "result",
                    scope: null,
                    term: "",
                    label: "Elsewhere",
                    href: "//evil.example/steal",
                    usedAt: "2026-08-06T12:00:00Z"
                },
                {
                    kind: "result",
                    scope: null,
                    term: "",
                    label: "Backslash",
                    // The URL parser reads this as an authority too, so it is
                    // the same escape wearing a different slash.
                    href: "/\\evil.example/steal",
                    usedAt: "2026-08-06T13:00:00Z"
                }
            ])
        );
        expect(readRecentSearches().map((entry) => entry.label)).toEqual(["Real"]);
    });

    it("survives a store holding something that is not a list of searches", () => {
        store.cells.set(STORE_KEY, "not json at all");
        expect(readRecentSearches()).toEqual([]);
        store.cells.set(STORE_KEY, JSON.stringify({ nope: true }));
        expect(readRecentSearches()).toEqual([]);
        store.cells.set(STORE_KEY, JSON.stringify([{ kind: "result" }]));
        expect(readRecentSearches()).toEqual([]);
    });

    it("works with no storage at all", () => {
        vi.stubGlobal("window", {
            localStorage: {
                getItem: () => {
                    throw new Error("denied");
                },
                setItem: () => {
                    throw new Error("denied");
                }
            }
        });
        expect(readRecentSearches()).toEqual([]);
        expect(() => rememberSearch({ kind: "query", scope: null, term: "x", label: "x", href: null })).not.toThrow();
    });
});

describe("merging the account's copy", () => {
    it("keeps the newer of two sightings of the same search", () => {
        const older: RecentSearch = {
            kind: "result",
            scope: "tasks",
            term: "old",
            label: "Ship 2.1",
            href: "/tasks/t/a",
            usedAt: "2026-08-01T10:00:00.000Z"
        };
        const newer: RecentSearch = { ...older, term: "new", usedAt: "2026-08-06T10:00:00.000Z" };
        expect(mergeRecentSearches([older], [newer])).toEqual([newer]);
    });

    it("brings across what only the account had, and stores the result", () => {
        rememberSearch({ kind: "result", scope: null, term: "", label: "Drive", href: "/drive" });
        const merged = mergeIntoStore([
            {
                kind: "result",
                scope: "servers",
                term: "lirio",
                label: "lirio-0",
                href: "/apps/servers",
                usedAt: "2026-08-06T09:00:00.000Z"
            }
        ]);
        expect(merged.map((entry) => entry.label)).toContain("lirio-0");
        expect(Array.isArray(stored())).toBe(true);
        expect(readRecentSearches().map((entry) => entry.label)).toContain("lirio-0");
    });
});
