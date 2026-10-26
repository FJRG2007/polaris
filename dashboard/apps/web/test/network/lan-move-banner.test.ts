/**
 * What the "Polaris is now at <address>" banner shows: the newest recorded move
 * while it is recent, and nothing for an old move, a history an older build
 * wrote in another shape, or no history at all. Only a manager is told.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let history: string | null = null;
let manages = true;

vi.mock("@polaris/db", () => ({ prisma: { user: { findMany: async () => [] } } }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => history, setSetting: async () => undefined }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => () => "" }));
vi.mock("@/lib/notification-service", () => ({ createNotification: async () => undefined }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => null }));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "admin" }),
    sessionCan: async () => manages
}));

const { recentLanMove, lanMoveLinks, LAN_MOVE_SHOWN_MS } = await import("../../src/lib/lan-address-follow");
const { lanAddressMoveAction } = await import("../../src/app/(app)/lan-address-actions");

const now = Date.parse("2026-10-26T12:00:00.000Z");
const move = (at: string, to = "10.0.0.5") => ({ from: "192.168.1.40", to, at });

beforeEach(() => {
    history = null;
    manages = true;
});

describe("recentLanMove", () => {
    it("returns the newest move while it is recent", () => {
        const raw = JSON.stringify([move("2026-10-26T11:00:00.000Z"), move("2026-10-20T11:00:00.000Z", "x")]);
        expect(recentLanMove(raw, now)).toEqual(move("2026-10-26T11:00:00.000Z"));
    });

    it("hides a move older than the window", () => {
        const at = new Date(now - LAN_MOVE_SHOWN_MS - 1000).toISOString();
        expect(recentLanMove(JSON.stringify([move(at)]), now)).toBeNull();
    });

    it("reads no history, junk and a wrong shape as no move", () => {
        expect(recentLanMove(null, now)).toBeNull();
        expect(recentLanMove("not json", now)).toBeNull();
        expect(recentLanMove("{}", now)).toBeNull();
        expect(recentLanMove(JSON.stringify([{ from: 1 }]), now)).toBeNull();
        expect(recentLanMove(JSON.stringify([move("yesterday")]), now)).toBeNull();
    });
});

describe("lanAddressMoveAction", () => {
    it("tells a manager about a recent move", async () => {
        const recent = move(new Date().toISOString());
        history = JSON.stringify([recent]);
        expect(await lanAddressMoveAction()).toEqual({ ...recent, links: lanMoveLinks(recent) });
    });

    it("tells nobody else", async () => {
        history = JSON.stringify([move(new Date().toISOString())]);
        manages = false;
        expect(await lanAddressMoveAction()).toBeNull();
    });
});

describe("lanMoveLinks", () => {
    it("offers the new address and the configured LAN name over plain http", () => {
        expect(lanMoveLinks({ to: "10.0.0.5" }, {})).toEqual(["https://10.0.0.5", "http://polaris.local"]);
        expect(lanMoveLinks({ to: "10.0.0.5" }, { POLARIS_LOCAL_HOSTNAME: "casa" })).toEqual([
            "https://10.0.0.5",
            "http://casa.local"
        ]);
        expect(
            lanMoveLinks({ to: "10.0.0.5" }, { POLARIS_MDNS_HOSTNAME: "nas", POLARIS_LOCAL_HOSTNAME: "casa" })
        ).toEqual(["https://10.0.0.5", "http://nas.local"]);
    });
});
