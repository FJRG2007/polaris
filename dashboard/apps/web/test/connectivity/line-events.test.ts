/**
 * What an automation is handed when the line comes back: the same event the
 * bell hears, plus how long it was down in words, so a ready-made notice does
 * not read "down for 7200 seconds".
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/automations/outbox", () => ({ emitAutomationEvent: async () => undefined }));
vi.mock("@/lib/notifications/operators", () => ({ notifyOperators: async () => undefined }));

const { automationPayload } = await import("@/lib/connectivity/line-events");

const AT = "2026-10-23T12:00:00.000Z";

describe("the connectivity automation payload", () => {
    it("says how long the line was down in words", () => {
        const payload = automationPayload({
            event: "up",
            kind: "line",
            since: "2026-10-23T10:00:00.000Z",
            at: AT,
            durationSeconds: 7200
        });
        expect(payload).toMatchObject({ durationSeconds: 7200, duration: "2 h" });
    });

    it("keeps short outages to the second", () => {
        const payload = automationPayload({
            event: "up",
            kind: "dns",
            since: "2026-10-23T11:55:48.000Z",
            at: AT,
            durationSeconds: 252
        });
        expect(payload.duration).toBe("4 min 12 s");
    });

    it("passes the other events through untouched", () => {
        const event = { event: "down", kind: "line", since: AT } as const;
        expect(automationPayload(event)).toEqual(event);
    });
});
