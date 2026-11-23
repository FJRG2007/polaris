/**
 * Every notification group wears a mark: an app's real logo, or one of the
 * explicit non-app marks. A group added to the catalogue without one fails
 * here, rather than reaching Account > Notifications as a bare name.
 */

import * as core from "@polaris/core";
import { hasAppLogo } from "@polaris/ui";
import { POLARIS_APPS } from "@/lib/apps";
import { describe, expect, it } from "vitest";
import { APP_ALIASES, aliasedAppId } from "@/lib/app-aliases";
import {
    NON_APP_GROUPS,
    notificationGroupGate,
    notificationGroupMark,
    visibleNotificationGroups
} from "@/lib/notifications/group-apps";

describe("notification group marks", () => {
    it.each(core.NOTIFICATION_GROUPS)("%s resolves to an app logo or an explicit mark", (group) => {
        const mark = notificationGroupMark(group);
        if (mark.kind === "app") expect(hasAppLogo(mark.appId), `${group} -> ${mark.appId}`).toBe(true);
        else expect(Object.values(NON_APP_GROUPS)).toContain(mark.kind);
    });

    it("draws each group as the app the registry says owns its alerts", () => {
        for (const app of POLARIS_APPS) {
            for (const group of app.notificationGroups ?? []) {
                expect(notificationGroupMark(group), group).toEqual({ kind: "app", appId: app.id });
            }
        }
    });

    it("names only real apps in the alias table", () => {
        for (const [name, appId] of Object.entries(APP_ALIASES)) {
            expect(hasAppLogo(appId), `${name} -> ${appId}`).toBe(true);
        }
        expect(aliasedAppId("mail")).toBe("mail");
    });
});

describe("which groups an account sees", () => {
    it("hides an app's groups from an account that cannot open it", () => {
        const visible = visibleNotificationGroups(new Set(["mail", "tasks"]));
        expect(visible).toContain("mail");
        expect(visible).toContain("tasks");
        expect(visible).not.toContain("deploy");
        expect(visible).not.toContain("network");
        expect(visible).not.toContain("agents");
        expect(visible).not.toContain("people");
    });

    it("always shows Polaris, security and alerts, which reach people outside any app", () => {
        const visible = visibleNotificationGroups(new Set());
        expect(visible).toEqual(["security", "alerts", "system"]);
        expect(notificationGroupGate("alerts")).toBeNull();
    });

    it("shows every group to an account that opens every app", () => {
        const all = new Set(POLARIS_APPS.map((app) => app.id));
        expect(visibleNotificationGroups(all)).toEqual([...core.NOTIFICATION_GROUPS]);
    });
});
