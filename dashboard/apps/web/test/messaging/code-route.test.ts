import { describe, expect, it } from "vitest";
import { NO_CODE_SENDER, resolveCodeRoute } from "@/lib/messaging/code-route";

const sender = { id: "admin-sender", platform: "whatsapp", status: "connected" };

describe("resolveCodeRoute", () => {
    it("uses the administrator's sender first", () => {
        expect(resolveCodeRoute("whatsapp", { adminSender: sender, ownChannel: { id: "own" } })).toEqual({
            channelId: "admin-sender",
            via: "admin"
        });
    });

    it("falls back to the person's own connected channel", () => {
        expect(resolveCodeRoute("whatsapp", { adminSender: null, ownChannel: { id: "own" } })).toEqual({
            channelId: "own",
            via: "own"
        });
    });

    it("skips a picked sender that is disconnected or on another platform", () => {
        const down = { ...sender, status: "disconnected" };
        expect(resolveCodeRoute("whatsapp", { adminSender: down, ownChannel: { id: "own" } })).toMatchObject({
            channelId: "own"
        });
        expect(resolveCodeRoute("telegram", { adminSender: sender, ownChannel: null })).toMatchObject({
            channelId: null
        });
    });

    it("names the Integrations page when nothing can send", () => {
        const route = resolveCodeRoute("whatsapp", { adminSender: null, ownChannel: null });
        expect(route).toEqual({ channelId: null, blocker: NO_CODE_SENDER.whatsapp });
        expect(NO_CODE_SENDER.whatsapp).toContain("Integrations > Messaging");
        expect(NO_CODE_SENDER.telegram).toContain("Integrations > Messaging");
    });
});
