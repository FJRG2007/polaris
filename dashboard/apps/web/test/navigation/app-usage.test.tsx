// @vitest-environment jsdom

/**
 * How much this browser opens each app, which orders the app menu.
 *
 * What is asserted: an open is counted when the reader moves into an app, not
 * for every screen inside it; a stored history that does not parse reads as
 * none instead of breaking anything; a browser with no history yet starts from
 * its recent visits; and storage that refuses to be read or written costs the
 * order, never the page.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/drive";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { VisitRecorder } = await import("@/components/overview/visit-recorder");
const { readAppUsage, rememberAppOpen } = await import("@/lib/app-usage");

const KEY = "polaris.apps.usage";

afterEach(cleanup);

/** A storage of its own per test: jsdom's is not there in this environment. */
function stubStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">) {
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

beforeEach(() => {
    const kept = new Map<string, string>();
    stubStorage({
        getItem: (key) => kept.get(key) ?? null,
        setItem: (key, value) => void kept.set(key, value),
        removeItem: (key) => void kept.delete(key),
        clear: () => kept.clear()
    });
    pathname = "/drive";
});

describe("the app usage history", () => {
    it("counts an open each time the reader moves into an app, not each screen inside it", () => {
        window.localStorage.setItem(KEY, "{}");
        const view = render(<VisitRecorder />);
        pathname = "/drive/shared";
        view.rerender(<VisitRecorder />);
        pathname = "/chat";
        view.rerender(<VisitRecorder />);
        pathname = "/drive";
        view.rerender(<VisitRecorder />);
        const usage = readAppUsage();
        expect(Object.keys(usage).sort()).toEqual(["chat", "drive"]);
        expect(usage.drive!.score).toBeGreaterThan(1.99);
        expect(usage.drive!.score).toBeLessThanOrEqual(2);
        expect(usage.chat!.score).toBeLessThanOrEqual(1);
    });

    it("reads a corrupt history as none", () => {
        window.localStorage.setItem(KEY, "{not json");
        expect(readAppUsage()).toEqual({});
        window.localStorage.setItem(KEY, JSON.stringify({ chat: { score: "lots", at: 1 } }));
        expect(readAppUsage()).toEqual({});
        rememberAppOpen("chat");
        expect(readAppUsage().chat?.score).toBe(1);
    });

    it("starts from the recent visits when there is no history yet", () => {
        window.localStorage.setItem(
            "polaris.overview.recent",
            JSON.stringify([
                {
                    href: "/chat",
                    label: "Chat",
                    context: null,
                    visitedAt: "2026-01-02T00:00:00.000Z"
                },
                {
                    href: "/chat/x",
                    label: "x",
                    context: null,
                    visitedAt: "2026-01-01T00:00:00.000Z"
                },
                {
                    href: "/drive",
                    label: "Drive",
                    context: null,
                    visitedAt: "2026-01-01T00:00:00.000Z"
                }
            ])
        );
        const usage = readAppUsage();
        expect(Object.keys(usage).sort()).toEqual(["chat", "drive"]);
        expect(usage.chat!.at).toBe(Date.parse("2026-01-02T00:00:00.000Z"));
        expect(usage.chat!.score).toBeGreaterThan(usage.drive!.score);
    });

    it("costs the order, never the page, when storage refuses", () => {
        const refuse = () => {
            throw new Error("denied");
        };
        stubStorage({ getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse });
        expect(readAppUsage()).toEqual({});
        expect(() => rememberAppOpen("chat")).not.toThrow();
        expect(() => render(<VisitRecorder />)).not.toThrow();
    });
});
