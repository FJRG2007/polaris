// @vitest-environment jsdom

/**
 * What a new email's desktop notice says, and when it is raised.
 *
 * The notice used to carry the sender's bare name as its title, which read as a
 * chat message or anything else in the system's notice centre. And the cursor
 * stood still while Polaris had somebody's attention, so the first frame after
 * they looked away announced every unread message since - up to an hour late.
 * A frame seen while watched now moves the cursor instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import english from "../../messages/en-US/components.json";
import spanish from "../../messages/es-ES/components.json";

let watched = false;
const notices: { title: string; body: string; tag: string }[] = [];

vi.mock("@/lib/desktop-notify", () => ({
    canNotify: () => true,
    tabIsWatched: () => watched,
    closeDesktopNotice: () => undefined,
    notifyDesktop: async (input: { title: string; body: string; tag: string }) => {
        notices.push(input);
    }
}));
vi.mock("@/lib/notifications/browser-notices", () => ({ noticeAllowed: () => true }));

const { noticeMailFrame, SHARED_CURSOR_KEY } = await import("@/components/mail-unread");

const asked: string[] = [];
let answer = { cursor: "2026-11-06T10:00:00.000Z", named: [] as unknown[], more: 0 };

/** The English catalog, with its one placeholder filled. */
const t = ((key: string, values?: Record<string, unknown>) => {
    const leaf = key
        .split(".")
        .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)[part],
            english
        ) as string;
    return leaf.replace("{from}", String(values?.from ?? ""));
}) as unknown as Parameters<typeof noticeMailFrame>[2];

/** A storage of its own: the test environment's may be missing or shared. */
function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        key: (index: number) => Array.from(items.keys())[index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, String(value)),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear()
    };
}

beforeEach(() => {
    watched = false;
    notices.length = 0;
    asked.length = 0;
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    answer = { cursor: "2026-11-06T10:00:00.000Z", named: [], more: 0 };
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify(answer), { status: 200 });
    });
});

describe("the notice's title", () => {
    it("says it is an email and who it is from", async () => {
        answer = {
            cursor: "2026-11-06T10:05:00.000Z",
            named: [{ threadId: "t1", from: "Ana", subject: "Invoice for March" }],
            more: 0
        };
        await noticeMailFrame({ current: "2026-11-06T10:00:00.000Z" }, true, t);
        expect(notices).toEqual([
            expect.objectContaining({
                title: "New email from Ana",
                body: "Invoice for March",
                tag: "mail:t1"
            })
        ]);
    });

    it("keeps a very long sender inside what the desktop app accepts", async () => {
        answer = {
            cursor: "2026-11-06T10:05:00.000Z",
            named: [{ threadId: "t1", from: "x".repeat(500), subject: "Hi" }],
            more: 0
        };
        await noticeMailFrame({ current: "2026-11-06T10:00:00.000Z" }, true, t);
        expect(notices[0]?.title.length).toBeLessThanOrEqual(200);
    });

    it("is worded as mail in every language", () => {
        expect(english.mailUnread.from).toBe("New email from {from}");
        expect(spanish.mailUnread.from).toBe("Correo nuevo de {from}");
    });
});

describe("the cursor", () => {
    it("moves past mail that arrived while somebody was looking, announcing nothing", async () => {
        watched = true;
        const cursor = { current: "2026-11-06T09:00:00.000Z" };
        answer = { cursor: "2026-11-06T10:00:00.000Z", named: [], more: 0 };
        await noticeMailFrame(cursor, true, t);
        expect(asked).toEqual(["/api/mail/arrivals"]);
        expect(cursor.current).toBe("2026-11-06T10:00:00.000Z");
        expect(window.localStorage.getItem(SHARED_CURSOR_KEY)).toBe("2026-11-06T10:00:00.000Z");
        expect(notices).toEqual([]);
    });

    it("so the first frame after looking away asks only from then on", async () => {
        const cursor = { current: "2026-11-06T09:00:00.000Z" };
        watched = true;
        await noticeMailFrame(cursor, false, t);
        watched = false;
        await noticeMailFrame(cursor, true, t);
        expect(asked[1]).toBe(
            `/api/mail/arrivals?since=${encodeURIComponent("2026-11-06T10:00:00.000Z")}`
        );
    });

    it("stands still while nobody is looking, so unseen mail is announced", async () => {
        const cursor = { current: "2026-11-06T09:00:00.000Z" };
        await noticeMailFrame(cursor, false, t);
        expect(asked).toEqual([]);
        expect(cursor.current).toBe("2026-11-06T09:00:00.000Z");
    });

    it("never moves backwards behind what another tab already announced", async () => {
        watched = true;
        window.localStorage.setItem(SHARED_CURSOR_KEY, "2026-11-06T11:00:00.000Z");
        const cursor = { current: "2026-11-06T09:00:00.000Z" };
        await noticeMailFrame(cursor, false, t);
        expect(window.localStorage.getItem(SHARED_CURSOR_KEY)).toBe("2026-11-06T11:00:00.000Z");
    });
});
