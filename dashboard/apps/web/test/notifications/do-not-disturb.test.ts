/**
 * Do not disturb, taking effect: what still lands, what is held back, and what
 * breaks through.
 *
 * Every path that sounds or raises a notice asks the same two questions - is
 * this account in do not disturb, and is this arrival critical - so those are
 * asserted here, together with the stream that carries the server's answer to
 * every tab, so a tab that missed the change cannot ring.
 */

import { arrivalAlert } from "@/lib/chat/message-alert";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { arrivalsMayAlert, breaksDoNotDisturb } from "@polaris/core";

describe("what breaks through", () => {
    it("lets a critical event through and holds the rest", () => {
        expect(breaksDoNotDisturb("account.signin")).toBe(true);
        expect(breaksDoNotDisturb("deploy.failed")).toBe(false);
        expect(breaksDoNotDisturb("not.an.event")).toBe(false);
    });

    it("alerts for any arrival when not in do not disturb", () => {
        expect(arrivalsMayAlert(false, [{ type: "deploy.failed" }])).toBe(true);
    });

    it("stays silent in do not disturb unless one arrival is critical", () => {
        expect(arrivalsMayAlert(true, [{ type: "deploy.failed" }])).toBe(false);
        expect(arrivalsMayAlert(true, [])).toBe(false);
        expect(
            arrivalsMayAlert(true, [{ type: "deploy.failed" }, { type: "account.signin" }])
        ).toBe(true);
    });
});

describe("a chat message in do not disturb", () => {
    it("still shows its card, with no sound and no notice", () => {
        expect(
            arrivalAlert({ inThatChat: false, attended: false, soundOn: true, doNotDisturb: true })
        ).toEqual({ toast: true, sound: false, desktop: false });
    });

    it("is unchanged when do not disturb is off or unknown", () => {
        expect(arrivalAlert({ inThatChat: false, attended: false, soundOn: true })).toEqual({
            toast: true,
            sound: true,
            desktop: true
        });
    });
});

describe("the bell's stream", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    async function firstFrame(on: boolean | "fails"): Promise<Record<string, unknown>> {
        vi.doMock("@/lib/session", () => ({ backgroundUser: async () => ({ id: "ada" }) }));
        vi.doMock("@/lib/notifications/feed-reader", () => ({
            createFeedReader: () => ({ read: async () => [] })
        }));
        vi.doMock("@/lib/notifications/live-clients", () => ({
            closeLiveClient: () => undefined,
            liveClientChimes: () => true,
            openLiveClient: () => undefined,
            touchLiveClient: () => undefined
        }));
        vi.doMock("@/lib/workspace-scope", () => ({ openShelfFor: async () => "personal" }));
        vi.doMock("@/lib/i18n/reader-words", () => ({ readerWords: async () => () => "" }));
        vi.doMock("@/lib/presence-service", () => ({
            doNotDisturbOf: async () => {
                if (on === "fails") throw new Error("database away");
                return { on, reason: on ? "chosen" : null, until: null };
            }
        }));
        const { GET } = await import("@/app/api/notifications/stream/route");
        const abort = new AbortController();
        const response = await GET(
            new Request("http://polaris.test/api/notifications/stream?client=browser", {
                signal: abort.signal
            })
        );
        const reader = response.body!.getReader();
        const { value } = await reader.read();
        abort.abort();
        await reader.cancel().catch(() => undefined);
        const text = new TextDecoder().decode(value);
        return JSON.parse(text.replace(/^data: /, "").trim()) as Record<string, unknown>;
    }

    it("tells every tab the account is in do not disturb", async () => {
        expect((await firstFrame(true)).quiet).toBe(true);
    });

    it("says it is not, so a tab goes back to ringing", async () => {
        expect((await firstFrame(false)).quiet).toBe(false);
    });

    it("keeps the bell working when the answer cannot be read", async () => {
        const frame = await firstFrame("fails");
        expect(frame.items).toEqual([]);
        expect(frame.quiet).toBe(false);
    });
});
