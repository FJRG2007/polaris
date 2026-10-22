import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    notification: { updateMany: vi.fn() },
    polarThread: { findFirst: vi.fn() }
}));
const notify = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));

import { translatorFor } from "@/lib/i18n/translate";
import { failedBody, noticePolarRunEnd, runNotice } from "@/lib/polar/run-notices";

const USER = "00000000-0000-4000-8000-000000000001";
const THREAD = "880b51c0-1166-4fe3-8530-98c3cb28776f";
const en = translatorFor("en-US", "polar");
const es = translatorFor("es-ES", "polar");

beforeEach(() => {
    db.notification.updateMany.mockReset().mockResolvedValue({ count: 1 });
    db.polarThread.findFirst.mockReset().mockResolvedValue({ title: "Tab", temporary: false });
    notify.mockReset().mockResolvedValue(undefined);
});

describe("polar run notices", () => {
    it("says which provider and model did not answer, and what to do", () => {
        const body = failedBody(
            en,
            { code: "provider", kind: "model", provider: "OpenRouter" },
            "MiniMax M3.1 Flash (free)"
        );
        expect(body).toBe(
            "The model did not answer (OpenRouter, MiniMax M3.1 Flash (free)). Ask again or pick another model."
        );
        expect(body).not.toContain("Open the chat");
        expect(failedBody(es, { code: "provider", kind: "rate", provider: "OpenRouter" }, null)).toContain(
            "OpenRouter"
        );
    });

    it("falls back to the plain sentence when the answer carried no provider failure", () => {
        expect(failedBody(en, null, "x")).toBe(en("notices.failedBody"));
        expect(runNotice(en, "failed", "T").level).toBe("danger");
    });

    it("sends the reason in a failed run's bell", async () => {
        await noticePolarRunEnd(
            {
                userId: USER,
                threadId: THREAD,
                state: "failed",
                watched: false,
                failure: { code: "provider", kind: "model", provider: "OpenRouter" }
            },
            "MiniMax M3.1 Flash (free)"
        );
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringContaining("OpenRouter, MiniMax M3.1 Flash (free)"),
                metadata: { threadId: THREAD, state: "failed" }
            })
        );
        expect(db.notification.updateMany).not.toHaveBeenCalled();
    });

    it("marks a failed run's bell read once the chat answers, watched or not", async () => {
        await noticePolarRunEnd({ userId: USER, threadId: THREAD, state: "done", watched: true });
        expect(db.notification.updateMany).toHaveBeenCalledWith({
            where: {
                userId: USER,
                type: "polar.chatReady",
                readAt: null,
                metadata: { contains: `"threadId":"${THREAD}","state":"failed"` }
            },
            data: { readAt: expect.any(Date) }
        });
        expect(notify).not.toHaveBeenCalled();
    });

    it("stores the metadata in the order the withdrawal looks for", () => {
        expect(JSON.stringify({ threadId: THREAD, state: "failed" })).toContain(
            `"threadId":"${THREAD}","state":"failed"`
        );
    });
});
