/**
 * Opening a private channel to teams and roles as it is made: the same member
 * grants Share writes, scoped to the space's organization, and only by
 * whoever administers the channel.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TEAM = "0190a0a0-0000-7000-8000-0000000000aa";
const ROLE = "0190a0a0-0000-7000-8000-0000000000bb";

let spaceOrg: string | null = "org-1";
let mayAdminister = true;
const written: { subjectId: string; inputs: unknown[]; orgIds: readonly string[] }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: { chatSpace: { findUnique: async () => ({ orgId: spaceOrg }) } }
}));

vi.mock("@/lib/access/grants", async (original) => ({
    ...(await original<typeof import("@/lib/access/grants")>()),
    writeGrants: async (_subject: string, subjectId: string, inputs: unknown[], _by: string, orgIds: readonly string[]) => {
        written.push({ subjectId, inputs, orgIds });
        return inputs.length;
    }
}));

vi.mock("@/lib/access-live", () => ({ publishAccessChange: () => undefined }));
vi.mock("@/lib/access/sharing-service", () => ({ groupCandidates: async () => [] }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => ["own-org"] }));

vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    requireChannel: async () => ({ mayAdminister, spaceId: "space-1" }),
    requireSpace: async () => "admin"
}));

const { grantChannelGroups } = await import("@/lib/chat/channel-groups");

beforeEach(() => {
    spaceOrg = "org-1";
    mayAdminister = true;
    written.length = 0;
});

describe("opening a channel to teams and roles", () => {
    it("writes one member grant per group, once each, in the space's organization", async () => {
        const count = await grantChannelGroups({ id: "admin" }, "channel-1", [
            { type: "team", id: TEAM },
            { type: "role", id: ROLE },
            { type: "team", id: TEAM }
        ]);
        expect(count).toBe(2);
        expect(written).toHaveLength(1);
        expect(written[0]?.orgIds).toEqual(["org-1"]);
        expect(written[0]?.inputs).toMatchObject([
            { principalType: "team", principalId: TEAM, capability: "member" },
            { principalType: "role", principalId: ROLE, capability: "member" }
        ]);
    });

    it("falls back to the creator's organizations for a space no organization owns", async () => {
        spaceOrg = null;
        await grantChannelGroups({ id: "admin" }, "channel-1", [{ type: "team", id: TEAM }]);
        expect(written[0]?.orgIds).toEqual(["own-org"]);
    });

    it("refuses somebody who does not administer the channel, writing nothing", async () => {
        mayAdminister = false;
        await expect(
            grantChannelGroups({ id: "member" }, "channel-1", [{ type: "team", id: TEAM }])
        ).rejects.toThrow();
        expect(written).toEqual([]);
    });

    it("writes nothing for no groups", async () => {
        expect(await grantChannelGroups({ id: "admin" }, "channel-1", [])).toBe(0);
        expect(written).toEqual([]);
    });
});
