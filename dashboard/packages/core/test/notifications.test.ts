import { describe, expect, it } from "vitest";
import * as notifications from "../src/schemas/notifications.js";
import { parseSmsConfig } from "../src/schemas/sms.js";

const {
    defaultRule,
    destinationInputSchema,
    detectWebhookFormat,
    isMuted,
    isNotificationEvent,
    maskWebhookUrl,
    NOTIFICATION_EVENTS,
    notificationEvent,
    parseNotificationPreferences,
    resolveRule,
    stringifyNotificationPreferences
} = notifications;

describe("event catalogue", () => {
    it("declares every event with a unique id", () => {
        const ids = NOTIFICATION_EVENTS.map((event) => event.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("refuses an id nothing declares, so an alert cannot skip the settings page", () => {
        expect(isNotificationEvent("deploy.failed")).toBe(true);
        expect(isNotificationEvent("deploy.exploded")).toBe(false);
        expect(notificationEvent("deploy.exploded")).toBeNull();
    });

    it("tells the owner about a failed deploy out of the box", () => {
        const event = notificationEvent("deploy.failed");
        expect(event?.defaults).toEqual({ inapp: true, email: true });
        expect(event?.level).toBe("danger");
    });

    it("stays quiet about a successful one", () => {
        expect(isMuted(defaultRule(notificationEvent("deploy.succeeded")!))).toBe(true);
    });
});

describe("rule resolution", () => {
    it("falls back to the catalogue default for an event never configured", () => {
        expect(resolveRule({}, "watch.alarm")).toEqual({ inapp: true, email: true, destinations: [] });
    });

    it("takes what the account saved over the default", () => {
        const saved = { "watch.alarm": { inapp: false, email: false, destinations: ["d1"] } };
        expect(resolveRule(saved, "watch.alarm")).toEqual({
            inapp: false,
            email: false,
            destinations: ["d1"]
        });
    });

    it("keeps the bell for a security event even when the account muted it", () => {
        const saved = { "account.signin": { inapp: false, email: false, destinations: [] } };
        expect(resolveRule(saved, "account.signin").inapp).toBe(true);
    });

    it("does not let a muted critical event keep its other channels", () => {
        const saved = { "scan.detection": { inapp: false, email: false, destinations: [] } };
        const rule = resolveRule(saved, "scan.detection");
        expect(rule.email).toBe(false);
        expect(isMuted(rule)).toBe(false);
    });

    it("does not hand back the stored array, so a caller cannot mutate the rules", () => {
        const saved = { "watch.ok": { inapp: true, email: false, destinations: ["d1"] } };
        resolveRule(saved, "watch.ok").destinations.push("d2");
        expect(saved["watch.ok"].destinations).toEqual(["d1"]);
    });
});

describe("stored preferences", () => {
    it("round-trips", () => {
        const rules = { "deploy.failed": { inapp: true, email: false, destinations: [] } };
        expect(parseNotificationPreferences(stringifyNotificationPreferences(rules))).toEqual(rules);
    });

    it("survives a null column, malformed JSON, and a rule for a dropped event", () => {
        expect(parseNotificationPreferences(null)).toEqual({});
        expect(parseNotificationPreferences("{not json")).toEqual({});
        expect(parseNotificationPreferences('{"gone.event":{"inapp":true,"email":false,"destinations":[]}}')).toEqual(
            {}
        );
    });
});

describe("webhook targets", () => {
    it("recognises the platforms whose body shape it knows", () => {
        expect(detectWebhookFormat("https://discord.com/api/webhooks/1/abc")).toBe("discord");
        expect(detectWebhookFormat("https://canary.discord.com/api/webhooks/1/abc")).toBe("discord");
        expect(detectWebhookFormat("https://hooks.slack.com/services/T/B/x")).toBe("slack");
        expect(detectWebhookFormat("https://example.com/hook")).toBe("generic");
        expect(detectWebhookFormat("not a url")).toBe("generic");
    });

    it("masks the part of the URL that is the credential", () => {
        const masked = maskWebhookUrl("https://discord.com/api/webhooks/12345/SECRETTOKEN");
        expect(masked).not.toContain("SECRETTOKEN");
        expect(masked).toBe("discord.com/api/webhooks/...");
    });

    it("refuses a plaintext endpoint", () => {
        const result = destinationInputSchema.safeParse({
            kind: "webhook",
            label: "Ops",
            url: "http://example.com/hook",
            format: "auto"
        });
        expect(result.success).toBe(false);
    });

    it("takes a number only in international form", () => {
        expect(
            destinationInputSchema.safeParse({ kind: "sms", label: "Phone", phone: "+34600111222" }).success
        ).toBe(true);
        expect(destinationInputSchema.safeParse({ kind: "sms", label: "Phone", phone: "600111222" }).success).toBe(
            false
        );
    });
});

describe("sms sender configuration", () => {
    it("accepts a well-formed Twilio account", () => {
        const result = parseSmsConfig("twilio", {
            accountSid: `AC${"a".repeat(32)}`,
            from: "+15550001111"
        });
        expect(result.ok).toBe(true);
    });

    it("rejects an unknown provider and a malformed sid", () => {
        expect(parseSmsConfig("nexmo", {}).ok).toBe(false);
        expect(parseSmsConfig("twilio", { accountSid: "AC123", from: "+15550001111" }).ok).toBe(false);
    });
});
