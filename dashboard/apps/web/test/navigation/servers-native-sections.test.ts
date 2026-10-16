/**
 * Security scans and Cloud servers are sections of Servers: in its rail for
 * whoever holds the permission their screens and actions ask, for nobody else,
 * with no install in front of them, and their old top-level addresses forward
 * to the new ones.
 */

import { join } from "node:path";
import config from "../../next.config.mjs";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { NATIVE_APPS } from "@/lib/apps/native-apps";
import { APP_SECTIONS, POLARIS_APPS, sectionOffered } from "@/lib/apps";
import { SECURITY_PERMISSION } from "@polaris-app/security-scans/src/lib/access";

const HREFS = Object.values(NATIVE_APPS);
const servers = APP_SECTIONS.apps ?? [];
const APPS = join(process.cwd(), "..");

describe("the Servers sections", () => {
    it("are in the Servers app's rail, grouped with the machines", () => {
        const fleet = servers.find((section) => section.href === "/apps/servers");
        for (const href of HREFS) {
            const section = servers.find((entry) => entry.href === href);
            expect(section, href).toBeDefined();
            expect(section!.group).toBe(fleet?.group);
            expect(section!.requiresApp).toBeUndefined();
        }
    });

    it("are no longer apps of their own in the switcher", () => {
        const ids = POLARIS_APPS.map((app) => app.id);
        expect(ids).not.toContain("security-scans");
        expect(ids).not.toContain("cloud-servers");
        expect(POLARIS_APPS.map((app) => app.href)).not.toContain("/security");
        expect(POLARIS_APPS.map((app) => app.href)).not.toContain("/cloud-servers");
    });

    it("ask the permission the screens and their actions enforce", () => {
        expect(SECURITY_PERMISSION).toBe("system.manage");
        const cloud = readFileSync(join(APPS, "cloud-servers/src/lib/service.ts"), "utf8");
        expect(cloud).toMatch(
            /requireCloudUser\(\) \{\s*return host\.session\.requirePermission\("system\.manage"\)/
        );
        for (const href of HREFS) {
            const section = servers.find((entry) => entry.href === href)!;
            expect(section.needs).toBe("system.manage");
            const without = { isAdmin: false, held: ["deploy.read"], installed: [] };
            const holder = { isAdmin: false, held: ["system.manage"], installed: [] };
            expect(sectionOffered(section, without), href).toBe(false);
            expect(sectionOffered(section, holder), href).toBe(true);
            expect(sectionOffered(section, { isAdmin: true, held: [], installed: [] }), href).toBe(
                true
            );
        }
    });

    it("are answered by a dashboard route and by the app's own page", () => {
        const pages = {
            "/apps/servers/security":
                "security-scans/src/routes/apps/servers/security/[[...path]]/page.tsx",
            "/apps/servers/cloud":
                "cloud-servers/src/routes/apps/servers/cloud/[[...path]]/page.tsx"
        };
        for (const [href, bundlePage] of Object.entries(pages)) {
            const route = join(process.cwd(), "src/app/(app)", href, "[[...path]]/page.tsx");
            expect(existsSync(route), route).toBe(true);
            expect(readFileSync(route, "utf8")).toContain(`renderAppPage("${href}"`);
            expect(existsSync(join(APPS, bundlePage)), bundlePage).toBe(true);
        }
    });
});

describe("the old addresses", () => {
    const forwards: Record<string, string> = {
        "/security": "/apps/servers/security",
        "/security/:path*": "/apps/servers/security/:path*",
        "/cloud-servers": "/apps/servers/cloud",
        "/cloud-servers/:path*": "/apps/servers/cloud/:path*"
    };

    it("forward to the sections, deep links included, never permanently", async () => {
        const redirects = (await config.redirects?.()) ?? [];
        for (const [source, destination] of Object.entries(forwards)) {
            const hit = redirects.find((redirect) => redirect.source === source);
            expect(hit, source).toBeDefined();
            expect(hit!.destination).toBe(destination);
            expect(hit!.permanent).toBe(false);
        }
    });

    it("are no longer screens of their own", () => {
        for (const old of ["security", "cloud-servers"]) {
            expect(existsSync(join(process.cwd(), "src/app/(app)", old))).toBe(false);
        }
    });
});
