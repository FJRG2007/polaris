/**
 * A people search that matches part of an address must not answer with somebody
 * found only through an address they keep from the person searching: typing
 * "ada.l" and watching who stays on the list would spell the address out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ shown: new Set<string>() }));

vi.mock("@polaris/db", () => ({ VISIBLE_USER: {}, prisma: {} }));
vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => new Set() }));
vi.mock("@/lib/friends-service", () => ({ friendIds: async () => [] }));
vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async () => new Set(),
    allowedBy: async (_viewer: unknown, _field: string, ids: string[]) =>
        new Set(ids.filter((id) => state.shown.has(id)))
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null, setSetting: async () => undefined }));

import { hiddenAddressMatches } from "@/lib/people-search";

const VIEWER = { id: "viewer", isAdmin: false };
const ADA = { id: "ada", name: "Ada Lovelace", username: "ada", email: "ada.l@example.com" };
const BO = { id: "bo", name: "Bo", username: "bo", email: "secret.ada.l@example.com" };

describe("matching part of an address", () => {
    beforeEach(() => state.shown.clear());

    it("drops somebody found only through an address they hide", async () => {
        expect([...(await hiddenAddressMatches(VIEWER, "ada.l", [ADA, BO]))].sort()).toEqual(["ada", "bo"]);
    });

    it("keeps somebody whose name or handle matched", async () => {
        expect(await hiddenAddressMatches(VIEWER, "ada", [ADA])).toEqual(new Set());
    });

    it("keeps somebody who shows the address to this viewer", async () => {
        state.shown.add("bo");
        expect(await hiddenAddressMatches(VIEWER, "ada.l", [ADA, BO])).toEqual(new Set(["ada"]));
    });

    it("keeps somebody found by a nickname the viewer gave them", async () => {
        expect(await hiddenAddressMatches(VIEWER, "secret", [BO], new Set(["bo"]))).toEqual(new Set());
    });

    it("holds an administrator to nothing", async () => {
        expect(await hiddenAddressMatches({ id: "root", isAdmin: true }, "ada.l", [ADA, BO])).toEqual(new Set());
    });
});
