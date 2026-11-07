/**
 * Which permissions a list shows: those of every Polaris always, and an app's
 * only while it is installed. Sharing and snippets are filed under Drive.
 */

import { describe, expect, it } from "vitest";
import {
    ORG_PERMISSION_APPS,
    ORG_PERMISSIONS,
    PERMISSION_APPS,
    PERMISSION_META,
    PERMISSIONS,
    listedOrgPermissions,
    listedPermissions
} from "../src/index.js";

describe("listedPermissions", () => {
    it("lists every permission when every app is installed", () => {
        expect(listedPermissions(PERMISSION_APPS)).toEqual([...PERMISSIONS]);
    });

    it("drops an uninstalled app's area and keeps the core ones", () => {
        const listed = listedPermissions(PERMISSION_APPS.filter((app) => app !== "status-pages"));
        expect(listed).not.toContain("status.manage");
        expect(
            listed.some((permission) => PERMISSION_META[permission].area === "Status pages")
        ).toBe(false);
        const none = listedPermissions([]);
        for (const area of ["Drive", "Management", "Apps", "Chat"]) {
            expect(none.some((permission) => PERMISSION_META[permission].area === area)).toBe(true);
        }
        expect(none).toContain("users.manage");
    });

    it("lists an app's permissions again once it is reinstalled, grants untouched", () => {
        const grants = new Set(["status.manage", "drive.read"]);
        expect(listedPermissions([])).not.toContain("status.manage");
        expect(listedPermissions(["status-pages"])).toContain("status.manage");
        expect([...grants]).toEqual(["status.manage", "drive.read"]);
    });

    it("splits Mail between the mailbox (core) and the mail server app", () => {
        const none = listedPermissions([]);
        expect(none).toContain("mail.use");
        expect(none).not.toContain("mailserver.manage");
    });

    it("lists an organization's CRM permissions only with the CRM installed", () => {
        expect(ORG_PERMISSION_APPS).toEqual(["crm"]);
        expect(listedOrgPermissions(["crm"])).toEqual([...ORG_PERMISSIONS]);
        expect(listedOrgPermissions([]).some((permission) => permission.startsWith("crm."))).toBe(
            false
        );
    });
});

describe("permission areas", () => {
    it("files sharing, drop points and snippets under Drive, after the files", () => {
        const areas = new Set(Object.values(PERMISSION_META).map((meta) => meta.area));
        expect(areas.has("Sharing")).toBe(false);
        expect(areas.has("Snippets")).toBe(false);
        const drive = PERMISSIONS.filter(
            (permission) => PERMISSION_META[permission].area === "Drive"
        );
        expect(drive).toEqual([
            "drive.read",
            "drive.write",
            "drive.delete",
            "connections.manage",
            "shares.create",
            "shares.manage",
            "requests.create",
            "requests.manage",
            "snippets.read",
            "snippets.write"
        ]);
    });
});
