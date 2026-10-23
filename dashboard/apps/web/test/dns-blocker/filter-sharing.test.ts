/**
 * The network filter's statistics shared with somebody who is not an
 * administrator (`dns.filter`): they read the totals and the domains, never
 * which device asked, and only an administrator hands them out.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ held: "" }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/access/grants", () => ({
    grantedCapability: vi.fn(async () => state.held),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn(), requireNote: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));

const { dnsFilterReach, sharedDnsHistory } = await import("@/lib/dns-blocker/access");
const { requireMayShare, subjectHref } = await import("@/lib/access/sharing-service");

type Sharer = Parameters<typeof requireMayShare>[0];

describe("the network filter's statistics, shared", () => {
    beforeEach(() => {
        state.held = "";
    });

    it("are reached by an administrator, by a grant, and by nobody else", async () => {
        expect(await dnsFilterReach({ id: "a", isAdmin: true })).toBe("admin");
        expect(await dnsFilterReach({ id: "b", isAdmin: false })).toBeNull();
        state.held = "view";
        expect(await dnsFilterReach({ id: "b", isAdmin: false })).toBe("shared");
    });

    it("never name a device on the network", () => {
        const history = {
            days: 30,
            queries: 10,
            blocked: 2,
            blockedPercent: 20,
            timeline: { allowed: [], blocked: [] },
            topPermitted: [{ name: "example.test", count: 8 }],
            topBlocked: [{ name: "ads.example.test", count: 2 }],
            topClients: [{ name: "192.0.2.10", count: 10 }],
            topBlockedClients: [{ name: "192.0.2.10", count: 2 }],
            blockedBy: [],
            clientNames: [{ address: "192.0.2.10", name: "laptop" }]
        } as never;
        const shared = sharedDnsHistory(history);
        expect(shared).toMatchObject({ queries: 10, topClients: [], topBlockedClients: [], clientNames: [] });
        expect(shared.topPermitted).toHaveLength(1);
    });

    it("are handed out by an administrator only, and lead to the filter", async () => {
        const as = (isAdmin: boolean) => ({ id: "u", isAdmin }) as Sharer;
        await expect(requireMayShare(as(false), "dns.filter", core.DNS_FILTER_ID)).rejects.toThrow();
        await expect(requireMayShare(as(true), "dns.filter", "elsewhere")).rejects.toThrow();
        await expect(requireMayShare(as(true), "dns.filter", core.DNS_FILTER_ID)).resolves.toBeUndefined();
        expect(subjectHref("dns.filter", core.DNS_FILTER_ID)).toBe("/apps/network-filter");
    });
});
