/**
 * Muting a whole app: which holds it sets, what reads as muted, and that the
 * stored holds keep parsing with the new `app:` kind beside the old ones.
 */

import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";
import { POLARIS_APPS } from "@/lib/apps";
import { applyAppMute, appMuteState, appMuteTargets, mutableApp } from "@/lib/app-mutes";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const EMPTY: core.NotificationHolds = { mutes: {}, schedules: {} };

describe("the app to notification mapping", () => {
    it("maps each app to the groups it owns", () => {
        expect(appMuteTargets("mail")).toEqual([{ kind: "group", id: "mail" }]);
        expect(appMuteTargets("tasks")).toEqual([{ kind: "group", id: "tasks" }]);
        expect(appMuteTargets("home")).toEqual([{ kind: "group", id: "places" }]);
        expect(appMuteTargets("apps")).toEqual([
            { kind: "group", id: "deploy" },
            { kind: "group", id: "agents" }
        ]);
    });

    it("gives Chat a hold of its own, since its messages are not events", () => {
        expect(appMuteTargets("chat")).toEqual([{ kind: "app", id: "chat" }]);
    });

    it("offers nothing for an app with no notifications, or one it does not know", () => {
        expect(mutableApp("vault")).toBe(false);
        expect(mutableApp("account")).toBe(false);
        expect(mutableApp("no-such-app")).toBe(false);
    });

    it("never hands one group to two apps, so muting one never silences another", () => {
        const owners = new Map<string, string>();
        for (const app of POLARIS_APPS) {
            for (const group of app.notificationGroups ?? []) {
                expect(owners.get(group), `${group} is ${owners.get(group)}'s`).toBeUndefined();
                owners.set(group, app.id);
                expect(core.NOTIFICATION_GROUPS).toContain(group);
            }
        }
    });
});

describe("muting and unmuting an app", () => {
    it("mutes every group the app owns until the same end", () => {
        const holds = applyAppMute(EMPTY, "apps", "8h", NOW);
        const until = "2026-11-12T18:00:00.000Z";
        expect(holds.mutes).toEqual({ "group:deploy": { until }, "group:agents": { until } });
        expect(appMuteState(holds, "apps", NOW)).toEqual({ muted: true, until });
    });

    it("lasts until turned back on with off", () => {
        const holds = applyAppMute(EMPTY, "chat", "off", NOW);
        expect(holds.mutes).toEqual({ "app:chat": { until: null } });
        expect(appMuteState(holds, "chat", NOW)).toEqual({ muted: true, until: null });
    });

    it("unmutes without touching other mutes or schedules", () => {
        const start: core.NotificationHolds = {
            mutes: { "group:mail": { until: null }, "group:tasks": { until: null } },
            schedules: { "group:mail": { days: 31, startMinute: 540, endMinute: 1080 } }
        };
        const holds = applyAppMute(start, "mail", null, NOW);
        expect(holds.mutes).toEqual({ "group:tasks": { until: null } });
        expect(holds.schedules).toEqual(start.schedules);
    });

    it("reads as unmuted once the mute ran out, or when only part of it is muted", () => {
        const lapsed = applyAppMute(EMPTY, "mail", "1h", NOW);
        expect(appMuteState(lapsed, "mail", new Date(NOW.getTime() + 61 * 60_000)).muted).toBe(false);
        const partly: core.NotificationHolds = { mutes: { "group:deploy": { until: null } }, schedules: {} };
        expect(appMuteState(partly, "apps", NOW).muted).toBe(false);
    });
});

describe("stored holds with the app kind", () => {
    it("parses app:chat beside the existing keys and drops an unknown app", () => {
        const raw = JSON.stringify({
            mutes: {
                "app:chat": { until: null },
                "app:nothing": { until: null },
                "group:mail": { until: "2030-01-01T00:00:00.000Z" },
                "weird:key": { until: null }
            },
            schedules: {},
            extra: true
        });
        expect(core.parseNotificationHolds(raw).mutes).toEqual({
            "app:chat": { until: null },
            "group:mail": { until: "2030-01-01T00:00:00.000Z" }
        });
    });

    it("an app hold never holds back a catalogue event", () => {
        const holds = applyAppMute(EMPTY, "chat", "off", NOW);
        expect(core.holdMuted(holds, "chat.callMissed", NOW)).toBe(false);
        expect(core.appHoldMuted(holds, "chat", NOW)).toBe(true);
    });
});
