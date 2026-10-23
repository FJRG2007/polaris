/**
 * Watch's connectivity record, shared. An administrator reads all of it; a
 * person it was shared with reads it without the parts that name the network;
 * anybody else - including somebody whose share was taken back - reads nothing,
 * and only an administrator may hand it out.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => ({ capability: "" }));

vi.mock("@/lib/access/grants", () => ({
    grantedCapability: vi.fn(async () => held.capability),
    GrantError: class GrantError extends Error {}
}));

const { connectivityReach, sharedConnectivityReport } = await import("@/lib/connectivity/access");
const { sectionOffered, APP_SECTIONS } = await import("@/lib/apps");

const person = { id: "u1", isAdmin: false };

describe("who reads the connectivity record", () => {
    beforeEach(() => {
        held.capability = "";
    });

    it("lets an administrator in without a grant", async () => {
        expect(await connectivityReach({ id: "a1", isAdmin: true })).toBe("admin");
    });

    it("lets in somebody holding view, as shared", async () => {
        held.capability = "view";
        expect(await connectivityReach(person)).toBe("shared");
    });

    it("keeps out somebody with no grant, and somebody whose grant was taken back", async () => {
        expect(await connectivityReach(person)).toBeNull();
        held.capability = "view";
        expect(await connectivityReach(person)).toBe("shared");
        held.capability = "";
        expect(await connectivityReach(person)).toBeNull();
    });
});

describe("the record as a shared reader gets it", () => {
    const outage = {
        id: "o1",
        kind: "line" as const,
        startedAt: "2026-10-01T10:00:00.000Z",
        endedAt: "2026-10-01T10:05:00.000Z",
        lastSeenAt: "2026-10-01T10:05:00.000Z",
        lastUpAt: null,
        detectedBy: "probe 192.0.2.1",
        detail: "connect ETIMEDOUT 192.0.2.1:443",
        firstBack: "192.0.2.1",
        firstBackAt: null,
        closedBy: "watcher",
        blips: 0
    };

    it("drops what names the network and keeps how long it was down", () => {
        const shared = sharedConnectivityReport({
            open: outage,
            outages: [outage]
        } as unknown as Parameters<typeof sharedConnectivityReport>[0]);
        for (const one of [shared.open, ...shared.outages]) {
            expect(one).toMatchObject({
                detectedBy: null,
                detail: null,
                firstBack: null,
                closedBy: null,
                startedAt: outage.startedAt,
                endedAt: outage.endedAt
            });
        }
    });
});

describe("the Watch rail for somebody it was shared with", () => {
    const sections = APP_SECTIONS.watch ?? [];
    const connectivity = sections.find((one) => one.href === "/watch/connectivity");

    it("offers Connectivity on the grant, and nothing that needs deploy access", () => {
        const gate = { isAdmin: false, held: ["watch.connectivity"], installed: [] };
        expect(connectivity && sectionOffered(connectivity, gate)).toBe(true);
        const others = sections.filter((one) => one !== connectivity);
        expect(others.some((one) => sectionOffered(one, gate))).toBe(false);
    });

    it("hides Connectivity from somebody without the grant or the role", () => {
        const gate = { isAdmin: false, held: ["deploy.read"], installed: [] };
        expect(connectivity && sectionOffered(connectivity, gate)).toBe(false);
    });
});

describe("the connectivity subject", () => {
    it("is read-only, and may be handed out as a link that only shows", () => {
        expect(core.GRANT_CAPABILITIES["watch.connectivity"]).toEqual(["view"]);
        expect(core.isGrantLinkSubject("watch.connectivity")).toBe(true);
        expect(core.linkCapabilities("watch.connectivity")).toEqual(["view"]);
    });
});
