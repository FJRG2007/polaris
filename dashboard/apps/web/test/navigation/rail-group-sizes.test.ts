/**
 * The Management and Apps rails stay readable.
 *
 * Management once drew thirteen entries under one Platform heading, and Apps nine
 * under Machines: a heading that long is a list to read through rather than a
 * place the eye lands. This holds every heading of the two rails - the ungrouped
 * entries at the top included - to a size that can be taken in at a glance, keeps
 * each heading's entries together in the order they are declared, and keeps every
 * screen the two rails offered before they were regrouped - Management's now one
 * level down, inside the area its rail entry opens.
 */

import { describe, expect, it } from "vitest";
import { APP_SECTIONS, APP_SUBAPPS, type AppSection } from "@/lib/apps";

/** The most entries one heading may hold. */
const MAX_PER_HEADING = 8;

/** Every screen the two rails listed before the regrouping. */
const PREVIOUS: Record<string, string[]> = {
    admin: [
        "/admin",
        "/admin/activity",
        "/admin/evidence",
        "/admin/users",
        "/admin/groups",
        "/admin/organizations",
        "/admin/roles",
        "/admin/policies",
        "/admin/security",
        "/admin/sso",
        "/admin/inbox",
        "/admin/email",
        "/admin/chat",
        "/admin/safety",
        "/admin/consumption",
        "/admin/billing",
        "/admin/domains",
        "/admin/display",
        "/admin/agents",
        "/admin/storage",
        "/admin/retention",
        "/admin/uploads",
        "/admin/integrations",
        "/admin/integrations/models",
        "/admin/diagnostics",
        "/admin/settings",
        "/admin/setup"
    ],
    apps: [
        "/apps/deploy",
        "/apps/marketplace",
        "/apps/servers",
        "/apps/servers/compare",
        "/apps/servers/insights",
        "/apps/servers/rollouts",
        "/apps/servers/security",
        "/apps/servers/cloud",
        "/apps/runners",
        "/apps/tunnels",
        "/apps/agents",
        "/apps/code",
        "/apps/firewall",
        "/apps/analytics",
        "/apps/telemetry",
        "/apps/databases",
        "/apps/containers",
        "/apps/backups",
        "/apps/mail-server",
        "/apps/dns-blocker"
    ]
};

/** The rail's headings in drawing order, the ungrouped entries under "". */
function headings(sections: readonly AppSection[]): Map<string, AppSection[]> {
    const byHeading = new Map<string, AppSection[]>();
    for (const section of sections.filter((entry) => !entry.hidden)) {
        const key = section.group ?? "";
        byHeading.set(key, [...(byHeading.get(key) ?? []), section]);
    }
    return byHeading;
}

describe.each(Object.keys(PREVIOUS))("the %s rail", (rail) => {
    const sections = APP_SECTIONS[rail] ?? [];

    it(`holds no more than ${MAX_PER_HEADING} entries under any heading`, () => {
        const over = [...headings(sections)]
            .filter(([, items]) => items.length > MAX_PER_HEADING)
            .map(([group, items]) => `${group || "(ungrouped)"}: ${items.length}`);
        expect(over).toEqual([]);
    });

    it("draws more than one heading, each with more than one entry", () => {
        const groups = headings(sections);
        expect(groups.size).toBeGreaterThan(rail === "admin" ? 1 : 3);
        for (const [group, items] of groups) expect(items.length, group).toBeGreaterThan(1);
    });

    it("declares each heading's entries side by side", () => {
        const order = sections.map((section) => section.group ?? "");
        const runs = order.filter((group, index) => index === 0 || order[index - 1] !== group);
        expect(runs).toEqual([...new Set(runs)]);
    });

    it("still offers every screen it offered before", () => {
        const hrefs = sections.map((section) => section.href);
        // A subject whose base this rail lists is reached through it.
        const nested = APP_SUBAPPS.filter((subapp) => hrefs.includes(subapp.base)).flatMap(
            (subapp) => subapp.sections.map((section) => section.href)
        );
        expect(PREVIOUS[rail]!.filter((href) => ![...hrefs, ...nested].includes(href))).toEqual([]);
        expect(new Set(hrefs).size).toBe(hrefs.length);
    });
});

describe("the Management rail", () => {
    it("opens on its areas rather than every screen", () => {
        expect((APP_SECTIONS.admin ?? []).filter((entry) => !entry.hidden).length).toBeLessThanOrEqual(10);
    });
});
