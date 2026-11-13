import { describe, expect, it } from "vitest";
import {
    ALERT_LIMITS,
    alertEventId,
    alertPriority,
    gotifyPriority,
    heldByQuietHours,
    holdKey,
    holdMuted,
    notificationEvent
} from "@polaris/core";
import {
    headerActions,
    parseAlertJson,
    parseGotify,
    parseNtfyJson,
    parseNtfyText,
    safeAlertUrl,
    type AlertMessage,
    type AlertParse
} from "@/lib/alerts/parse";

function ok(result: AlertParse): AlertMessage {
    expect(result.ok).toBe(true);
    return (result as { alert: AlertMessage }).alert;
}

const none = new URLSearchParams();

describe("severity", () => {
    it("reads ntfy's numbers and names", () => {
        expect(alertPriority(4)).toBe(4);
        expect(alertPriority("5")).toBe(5);
        expect(alertPriority("urgent")).toBe(5);
        expect(alertPriority("max")).toBe(5);
        expect(alertPriority("MIN")).toBe(1);
        expect(alertPriority("default")).toBe(3);
        expect(alertPriority(6)).toBeNull();
        expect(alertPriority("loud")).toBeNull();
    });

    it("folds Gotify's 0-10 onto 1-5", () => {
        expect([0, 1, 3, 4, 7, 8, 9, 10].map(gotifyPriority)).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
    });

    it("raises one catalogue event per severity, only urgent critical", () => {
        expect(alertEventId(1)).toBe("alerts.min");
        expect(alertEventId(5)).toBe("alerts.urgent");
        for (const priority of [1, 2, 3, 4] as const) {
            expect(notificationEvent(alertEventId(priority))?.critical).not.toBe(true);
        }
        expect(notificationEvent("alerts.urgent")?.critical).toBe(true);
    });

    it("lets urgent through quiet hours and holds the rest", () => {
        const quiet = { enabled: true, start: "00:00", end: "23:59", criticalBypass: true };
        const now = new Date("2026-11-13T12:00:00Z");
        expect(heldByQuietHours(quiet, now, "UTC", false)).toBe(true);
        expect(heldByQuietHours(quiet, now, "UTC", true)).toBe(false);
    });

    it("is muted by the reader's own mute on the group or one severity", () => {
        const now = new Date();
        const group = {
            mutes: { [holdKey({ kind: "group", id: "alerts" })]: { until: null } },
            schedules: {}
        };
        const one = {
            mutes: { [holdKey({ kind: "event", id: "alerts.low" })]: { until: null } },
            schedules: {}
        };
        expect(holdMuted(group, "alerts.high", now)).toBe(true);
        expect(holdMuted(one, "alerts.low", now)).toBe(true);
        expect(holdMuted(one, "alerts.high", now)).toBe(false);
    });
});

describe("ntfy text publish", () => {
    it("takes the body as the message and the fields from headers", () => {
        const headers = new Headers({
            Title: "Disk almost full",
            Priority: "high",
            Tags: "warning, disk,disk",
            Click: "https://example.com/disk",
            Actions: "view, Open, https://example.com/open; http, Restart, https://example.com/restart",
            Markdown: "yes",
            "X-Dedup-Key": "disk-srv"
        });
        expect(ok(parseNtfyText(headers, none, "Only **5%** left"))).toMatchObject({
            title: "Disk almost full",
            message: "Only **5%** left",
            priority: 4,
            tags: ["warning", "disk"],
            click: "https://example.com/disk",
            markdown: true,
            dedupKey: "disk-srv",
            actions: [{ label: "Open", url: "https://example.com/open" }]
        });
    });

    it("reads the short and X- spellings, and the query string", () => {
        const headers = new Headers({ "X-Priority": "1", t: "Hi" });
        expect(ok(parseNtfyText(headers, new URLSearchParams("tags=a"), "body"))).toMatchObject({
            priority: 1,
            title: "Hi",
            tags: ["a"]
        });
        expect(ok(parseNtfyText(new Headers(), new URLSearchParams("p=urgent"), "x")).priority).toBe(5);
    });

    it("leaves the severity to the topic when none is given, and refuses a nonsense one", () => {
        expect(ok(parseNtfyText(new Headers(), none, "x")).priority).toBeNull();
        expect(parseNtfyText(new Headers({ Priority: "9" }), none, "x").ok).toBe(false);
    });

    it("refuses an empty alert and too many tags, and cuts a long message", () => {
        expect(parseNtfyText(new Headers(), none, "  ").ok).toBe(false);
        const tags = Array.from({ length: ALERT_LIMITS.tags + 1 }, (_, i) => `t${i}`).join(",");
        expect(parseNtfyText(new Headers({ Tags: tags }), none, "x").ok).toBe(false);
        const long = ok(parseNtfyText(new Headers(), none, "a".repeat(10_000)));
        expect(long.message.length).toBe(ALERT_LIMITS.message);
    });

    it("strips control characters", () => {
        expect(ok(parseNtfyText(new Headers(), none, "a\u0007b")).message).toBe("ab");
    });
});

describe("links", () => {
    it("keeps http and https only, with no credentials", () => {
        expect(safeAlertUrl("https://example.com/x")).toBe("https://example.com/x");
        expect(safeAlertUrl("javascript:alert(1)")).toBeNull();
        expect(safeAlertUrl("data:text/html,hi")).toBeNull();
        expect(safeAlertUrl("https://user:pw@example.com")).toBeNull();
        expect(safeAlertUrl(`https://example.com/${"a".repeat(ALERT_LIMITS.url)}`)).toBeNull();
        expect(headerActions("view, Bad, javascript:alert(1)")).toEqual([]);
    });

    it("drops an unsafe click link rather than the alert", () => {
        expect(ok(parseAlertJson({ message: "x", click: "javascript:alert(1)" })).click).toBeNull();
    });
});

describe("ntfy JSON publish", () => {
    it("takes its documented fields", () => {
        const alert = ok(
            parseNtfyJson({
                topic: "secret",
                message: "Down",
                title: "Kuma",
                priority: 5,
                tags: ["red_circle"],
                actions: [{ action: "view", label: "Open", url: "https://example.com" }]
            })
        );
        expect(alert).toMatchObject({ title: "Kuma", priority: 5, tags: ["red_circle"] });
        expect(alert.actions).toHaveLength(1);
    });

    it("refuses a field ntfy does not document", () => {
        expect(parseNtfyJson({ topic: "s", message: "x", surprise: 1 })).toEqual({
            ok: false,
            error: "Unknown field: surprise"
        });
    });
});

describe("Polaris JSON", () => {
    it("reads severity by name and a dedup key", () => {
        expect(ok(parseAlertJson({ message: "Build failed", severity: "urgent", dedupKey: "b-1" }))).toMatchObject(
            { priority: 5, dedupKey: "b-1" }
        );
    });

    it("is strict: unknown keys, wrong types and oversized fields are refused", () => {
        expect(parseAlertJson({ message: "x", topic: "s" }).ok).toBe(false);
        expect(parseAlertJson({ message: 5 }).ok).toBe(false);
        expect(parseAlertJson({ message: "x", title: "t".repeat(ALERT_LIMITS.title + 1) }).ok).toBe(false);
        expect(parseAlertJson([]).ok).toBe(false);
        expect(parseAlertJson(null).ok).toBe(false);
    });
});

describe("Gotify", () => {
    it("reads title, message, priority and the Markdown and click extras", () => {
        const alert = ok(
            parseGotify({
                title: "Backup",
                message: "**done**",
                priority: 8,
                extras: {
                    "client::display": { contentType: "text/markdown" },
                    "client::notification": { click: { url: "https://example.com" } }
                }
            })
        );
        expect(alert).toMatchObject({ title: "Backup", priority: 4, markdown: true, click: "https://example.com/" });
    });

    it("takes a form's string priority and refuses an unknown field", () => {
        expect(ok(parseGotify({ message: "x", priority: "10" })).priority).toBe(5);
        expect(parseGotify({ message: "x", appid: 1 }).ok).toBe(false);
    });
});
