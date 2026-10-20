/**
 * A grant handed out as a link: whoever holds the address holds the grant, so
 * the address must be unguessable, never stored, bounded like any grant, and
 * dead the moment it is taken back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let grants: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        accessGrant: {
            count: async () => grants.length,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                grants.push({ ...data, id: `g${grants.length + 1}`, uses: 0 });
                return { id: `g${grants.length}` };
            },
            findFirst: async ({
                where
            }: {
                where: { principalType: string; principalId: string };
            }) =>
                grants.find(
                    (grant) =>
                        grant.principalType === where.principalType &&
                        grant.principalId === where.principalId
                ) ?? null
        }
    }
}));
vi.mock("@/lib/orgs/org-service", () => ({ teamIdsFor: async () => [] }));

const core = await import("@polaris/core");
const { linkPrincipalId, linkReach, writeGrantLink } = await import("@/lib/access/grants");

const DOOR = "00000000-0000-4000-8000-0000000000d1";

function link(over: Record<string, unknown> = {}) {
    return core.grantLinkSchema.parse({ capability: "control", actions: ["open"], ...over });
}

beforeEach(() => {
    grants = [];
});

describe("making a link", () => {
    it("hands back a long random token once and keeps only its hash", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link(), "owner");
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const row = grants[0]!;
        expect(row.principalType).toBe("link");
        expect(row.principalId).toBe(linkPrincipalId(token));
        expect(JSON.stringify(row)).not.toContain(token);
    });

    it("gives two links two different tokens", async () => {
        const one = await writeGrantLink("place.device", DOOR, link(), "owner");
        const two = await writeGrantLink("place.device", DOOR, link(), "owner");
        expect(one.token).not.toBe(two.token);
    });

    it("refuses an action the capability does not reach", async () => {
        await expect(
            writeGrantLink(
                "place.device",
                DOOR,
                link({ capability: "view", actions: ["open"] }),
                "owner"
            )
        ).rejects.toThrow();
    });

    it("keeps its fence and its limits", async () => {
        await writeGrantLink(
            "place.device",
            DOOR,
            link({ nearbyMeters: 150, maxUses: 3 }),
            "owner"
        );
        expect(grants[0]).toMatchObject({ nearbyMeters: 150, maxUses: 3, actions: ["open"] });
    });
});

describe("following a link", () => {
    it("reaches its door while it is in force, with what it allows", async () => {
        const { token } = await writeGrantLink(
            "place.device",
            DOOR,
            link({ nearbyMeters: 100 }),
            "o"
        );
        const reached = await linkReach(token);
        expect(reached?.standing).toBe("live");
        expect(reached?.subjectId).toBe(DOOR);
        if (reached?.standing === "live") {
            expect(reached.grant.actions).toEqual(["open"]);
            expect(reached.grant.nearbyMeters).toBe(100);
        }
    });

    it("says it has not started yet, or has run out", async () => {
        const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
        const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
        const early = await writeGrantLink("place.device", DOOR, link({ startsAt: future }), "o");
        const late = await writeGrantLink(
            "place.device",
            DOOR,
            link({ startsAt: new Date(Date.now() - 6 * 86_400_000).toISOString(), endsAt: past }),
            "o"
        );
        expect((await linkReach(early.token))?.standing).toBe("waiting");
        expect((await linkReach(late.token))?.standing).toBe("expired");
    });

    it("is spent once its uses are", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link({ maxUses: 2 }), "o");
        grants[0]!.uses = 2;
        expect((await linkReach(token))?.standing).toBe("spent");
    });

    it("reaches nothing once taken back, or with a token nobody made", async () => {
        const { token } = await writeGrantLink("place.device", DOOR, link(), "o");
        grants = [];
        expect(await linkReach(token)).toBeNull();
        expect(await linkReach("A".repeat(43))).toBeNull();
    });

    it("does not ask the database about something that is not a token", async () => {
        expect(await linkReach("../../etc/passwd")).toBeNull();
        expect(await linkReach("")).toBeNull();
    });
});
