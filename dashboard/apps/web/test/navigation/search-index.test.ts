/**
 * What the global search offers as destinations. The rules being protected: an
 * app whose landing page is also one of its sections must be listed once, not
 * twice under the same href; a non-administrator must never be shown a page the
 * server would refuse; nor must anyone be shown an app their role does not open;
 * and every page the left rail can reach has to be findable, since both are drawn
 * from the same registry.
 */

import { describe, expect, it } from "vitest";
import { APP_SECTIONS, POLARIS_APPS } from "@/lib/apps";
import { navigationEntries, resourceEntries } from "@/lib/search-index";

/** Every app, for the cases that are not about which apps are open. */
const ALL_APPS = POLARIS_APPS.map((app) => app.id);

describe("navigationEntries", () => {
    it("lists each destination once", () => {
        const hrefs = navigationEntries(true, ALL_APPS).map((entry) => entry.href);
        expect(hrefs.length).toBe(new Set(hrefs).size);
    });

    it("withholds the admin app and its pages from a normal user", () => {
        const hrefs = navigationEntries(false, ALL_APPS).map((entry) => entry.href);
        expect(hrefs).not.toContain("/admin");
        expect(hrefs).not.toContain("/admin/users");
        // Management owns these two despite living at the top level.
        expect(hrefs).not.toContain("/integrations");
        expect(hrefs).not.toContain("/settings");
        expect(navigationEntries(true, ALL_APPS).map((entry) => entry.href)).toContain("/admin/users");
    });

    it("withholds an app the role does not open, and the subjects inside it", () => {
        const hrefs = navigationEntries(false, ["drive"]).map((entry) => entry.href);
        expect(hrefs).toContain("/drive");
        expect(hrefs).not.toContain("/tasks");
        expect(hrefs).not.toContain("/apps/deploy");
        // Runners lives inside Apps, so it goes with it.
        expect(hrefs).not.toContain("/apps/runners/runs");
    });

    it("keeps a person's own account findable even when their role opens nothing", () => {
        const hrefs = navigationEntries(false, []).map((entry) => entry.href);
        expect(hrefs).toContain("/account");
        expect(hrefs).toContain("/account/security");
        expect(hrefs).not.toContain("/drive");
    });

    it("covers every section the left rail can reach", () => {
        const hrefs = new Set(navigationEntries(true, ALL_APPS).map((entry) => entry.href));
        for (const sections of Object.values(APP_SECTIONS)) {
            for (const section of sections) expect(hrefs.has(section.href)).toBe(true);
        }
        for (const app of POLARIS_APPS) expect(hrefs.has(app.href)).toBe(true);
    });

    it("carries an app's own name onto its landing section, so the app is searchable by it", () => {
        const files = navigationEntries(false, ALL_APPS).find((entry) => entry.href === "/drive");
        expect(files?.label).toBe("Files");
        expect(files?.keywords).toContain("Drive");
    });
});

describe("resourceEntries", () => {
    it("groups a service under Deploy and keeps where it lives", () => {
        const [entry] = resourceEntries([
            { id: "a1", kind: "service", label: "api", context: "Acme / production", href: "/apps/deploy/p1" }
        ]);
        expect(entry?.group).toBe("Deploy");
        expect(entry?.label).toBe("api");
        expect(entry?.context).toBe("Acme / production");
        expect(entry?.href).toBe("/apps/deploy/p1");
    });

    it("keys entries by kind and id, so two things named alike do not collide", () => {
        const entries = resourceEntries([
            { id: "1", kind: "project", label: "api", context: "", href: "/a" },
            { id: "1", kind: "service", label: "api", context: "", href: "/b" }
        ]);
        expect(entries[0]?.id).not.toBe(entries[1]?.id);
    });
});
