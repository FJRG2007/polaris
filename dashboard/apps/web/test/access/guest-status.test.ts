/**
 * A NAS, a server or a domain seen through a link: its name and whether it is
 * up, never where it is reached, and nothing at all once the link is not in
 * force.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "00000000-0000-4000-8000-0000000000e1";

let reach: unknown = null;

vi.mock("@/lib/access/grants", () => ({ linkReach: async () => reach }));
vi.mock("@polaris/db", () => ({
    prisma: {
        domain: {
            findUnique: async () => ({
                hostname: "shop.example.test",
                healthStatus: "up",
                healthCheckedAt: new Date("2026-01-01T10:00:00Z")
            })
        }
    }
}));
vi.mock("@/lib/machines/machine-access", () => ({
    lendableServer: async () => ({ id: ID, ownerId: "owner", name: "Rack 1" }),
    domainOwner: async () => ({ id: ID, ownerId: "owner", hostname: "shop.example.test" })
}));
vi.mock("@/lib/watch-overview-service", () => ({
    getWatchServers: async () => [
        { id: ID, name: "Rack 1", detail: "root@10.0.0.5", state: "down" }
    ]
}));
vi.mock("@/lib/nas/nas-service", () => ({
    nasRow: async () => ({ id: ID, name: "Vault", ownerId: "owner", placeId: null }),
    readNas: async () => ({
        status: { ok: true, value: { uptimeSeconds: 7200, hostname: "unas.lan" } }
    })
}));

const { forgetGuestReadings, guestStatusView } = await import("@/lib/access/guest-status");

function live(subjectType: string) {
    return {
        standing: "live",
        subjectType,
        subjectId: ID,
        note: "",
        grant: { id: "g1", capability: "view", actions: ["watch"], until: null, counted: false }
    };
}

beforeEach(() => {
    reach = null;
    forgetGuestReadings();
});

describe("a watch-only link", () => {
    it("shows a server's name and state, never its address", async () => {
        reach = live("place.server");
        const view = await guestStatusView("t");
        expect(view).toMatchObject({ kind: "server", name: "Rack 1", state: "down" });
        expect(JSON.stringify(view)).not.toContain("10.0.0.5");
    });

    it("shows a NAS's uptime, never its host name", async () => {
        reach = live("place.nas");
        const view = await guestStatusView("t");
        expect(view).toMatchObject({
            kind: "nas",
            name: "Vault",
            state: "up",
            uptimeSeconds: 7200
        });
        expect(JSON.stringify(view)).not.toContain("unas.lan");
    });

    it("shows a domain up or down", async () => {
        reach = live("place.domain");
        expect(await guestStatusView("t")).toMatchObject({ kind: "domain", state: "up" });
    });

    it("shows nothing outside its hours, expired, spent or taken back", async () => {
        for (const standing of ["closed", "expired", "spent", "waiting"]) {
            reach = { ...live("place.server"), standing };
            expect(await guestStatusView("t")).toBeNull();
        }
        reach = null;
        expect(await guestStatusView("t")).toBeNull();
    });

    it("is nothing for a door's or a camera's link", async () => {
        reach = live("place.device");
        expect(await guestStatusView("t")).toBeNull();
    });
});
