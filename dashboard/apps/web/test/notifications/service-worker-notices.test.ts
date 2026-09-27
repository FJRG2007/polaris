/**
 * The service worker's side of a notice with buttons: the real `public/sw.js`,
 * run against a stand-in for the worker's globals.
 *
 * What is pinned: a press on "Mark as read" makes the request the page put on
 * the notice, with nobody's tab needed, and only a request to this Polaris's own
 * API; a press on the notice itself brings an open window forward and tells it
 * where to go, or opens one when there is none.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(join(__dirname, "../../public/sw.js"), "utf8");

function worker(windows: { focused: boolean; told: unknown[] }[]) {
    const listeners = new Map<string, (event: unknown) => void>();
    const fetched: { url: string; init: RequestInit }[] = [];
    const opened: string[] = [];
    const focused: number[] = [];
    const self = {
        addEventListener: (name: string, handler: (event: unknown) => void) =>
            listeners.set(name, handler),
        clients: {
            matchAll: async () =>
                windows.map((one, index) => ({
                    focused: one.focused,
                    focus: async () => {
                        focused.push(index);
                        return undefined;
                    },
                    postMessage: (message: unknown) => one.told.push(message)
                })),
            openWindow: async (href: string) => {
                opened.push(href);
            },
            claim: async () => undefined
        },
        skipWaiting: async () => undefined
    };
    runInNewContext(SOURCE, {
        self,
        caches: {},
        fetch: async (url: string, init: RequestInit) => {
            fetched.push({ url, init });
            return new Response(null, { status: 204 });
        },
        Response,
        Request,
        Array,
        JSON,
        Promise
    });
    const click = async (action: string, data: unknown) => {
        const waits: Promise<unknown>[] = [];
        const close = vi.fn();
        listeners.get("notificationclick")?.({
            action,
            notification: { data, close },
            waitUntil: (promise: Promise<unknown>) => waits.push(promise)
        });
        await Promise.all(waits);
        return close;
    };
    return { click, fetched, opened, focused };
}

const READ = {
    id: "read",
    text: "Mark as read",
    request: { url: "/api/chat/channels/c1/read", body: { messageId: "m1" } }
};

describe("a press on a notice the service worker drew", () => {
    it("makes the button's request with no tab open, and takes the notice down", async () => {
        const sw = worker([]);
        const close = await sw.click("read", { href: "/chat/c/c1/m1", actions: [READ] });
        expect(close).toHaveBeenCalled();
        expect(sw.fetched).toHaveLength(1);
        expect(sw.fetched[0]!.url).toBe("/api/chat/channels/c1/read");
        expect(sw.fetched[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin" });
        expect(sw.fetched[0]!.init.body).toBe(JSON.stringify({ messageId: "m1" }));
        expect(sw.opened).toEqual([]);
    });

    it("makes no request anywhere but this Polaris's API", async () => {
        const sw = worker([]);
        const elsewhere = { ...READ, request: { url: "https://elsewhere.test/steal", body: {} } };
        await sw.click("read", { actions: [elsewhere] });
        expect(sw.fetched).toEqual([]);
    });

    it("brings an open window forward on the notice's page", async () => {
        const behind = { focused: false, told: [] as unknown[] };
        const sw = worker([behind]);
        await sw.click("", { href: "/chat/c/c1/m1", actions: [READ] });
        expect(sw.focused).toEqual([0]);
        expect(behind.told).toEqual([{ kind: "polaris-notice-open", href: "/chat/c/c1/m1" }]);
        expect(sw.fetched).toEqual([]);
    });

    it("opens a window on the notice's page when none is open", async () => {
        const sw = worker([]);
        await sw.click("", { href: "/chat/c/c1/m1", actions: [READ] });
        expect(sw.opened).toEqual(["/chat/c/c1/m1"]);
    });
});
