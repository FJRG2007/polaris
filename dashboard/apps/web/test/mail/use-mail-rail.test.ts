// @vitest-environment jsdom

/**
 * Which mailboxes stay expanded in the rail across a reload.
 *
 * The failure this guards is a mailbox that was disconnected leaving its
 * expanded id in `localStorage` forever, growing toward the cap on a slot no
 * longer connected mailbox can ever reclaim - and a mailbox that is still
 * connected keeping its place regardless of render order.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useMailRailOpen } from "@/app/(app)/mail/use-mail-rail";

const KEY = "polaris.mail.rail.open";

/** The browser storage the rail's open state lives in. This environment does
 *  not ship one. */
function browserStorage() {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        writable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            }
        }
    });
}

beforeEach(() => browserStorage());

describe("the rail's remembered open mailboxes", () => {
    it("remembers a toggle across a reload", () => {
        const { result } = renderHook(() => useMailRailOpen(["alice"]));

        act(() => result.current.toggle("alice"));
        expect(result.current.open.has("alice")).toBe(true);
        expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual(["alice"]);
    });

    it("drops a mailbox that is no longer connected when the next write happens", () => {
        window.localStorage.setItem(KEY, JSON.stringify(["alice", "gone"]));
        const { result, rerender } = renderHook(({ mailboxes }) => useMailRailOpen(mailboxes), {
            initialProps: { mailboxes: ["alice"] as readonly string[] }
        });

        // Read on mount: both ids are open, "gone" included, because dropping it
        // happens on the way out rather than on the way in.
        expect(result.current.open.has("gone")).toBe(true);

        rerender({ mailboxes: ["alice"] });
        act(() => result.current.toggle("bob"));

        const kept = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
        expect(kept).not.toContain("gone");
    });

    it("keeps a mailbox that is still connected", () => {
        window.localStorage.setItem(KEY, JSON.stringify(["alice"]));
        const { result } = renderHook(() => useMailRailOpen(["alice", "bob"]));

        act(() => result.current.toggle("bob"));

        const kept = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
        expect(kept.sort()).toEqual(["alice", "bob"]);
    });
});
