/**
 * Name tags against an in-memory database: a tag drops on its own when the
 * wearer leaves or the organization turns it off, privacy follows the badges
 * rule, and a screen of N people is one read of the choices.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-000000000001";
const ALICE = "00000000-0000-4000-8000-000000000002";
const BOB = "00000000-0000-4000-8000-000000000003";
const VIEWER = { id: "00000000-0000-4000-8000-000000000009", isAdmin: false };

const ORG_ROW = {
    id: ORG,
    image: null as string | null,
    ownerId: OWNER,
    tagEnabled: true,
    tagText: "ACME",
    tagEmblem: "bolt",
    tagColor: "teal"
};
let org = { ...ORG_ROW };
let members: { userId: string; restricted: boolean }[] = [];
let choices: { userId: string; orgId: string | null }[] = [];
let settings = new Map<string, string>();
let hiddenBy = new Set<string>();
const findChoices = vi.fn();
const askedPrivacy = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        nameTagChoice: {
            findMany: (args: { where: { userId: { in: string[] } } }) => {
                findChoices(args);
                const wanted = args.where.userId.in;
                return Promise.resolve(
                    choices
                        .filter((row) => wanted.includes(row.userId))
                        .map((row) => ({
                            ...row,
                            org:
                                row.orgId === ORG
                                    ? {
                                          ...org,
                                          members: members
                                              .filter(
                                                  (m) => !m.restricted && wanted.includes(m.userId)
                                              )
                                              .map((m) => ({ userId: m.userId }))
                                      }
                                    : null
                        }))
                );
            }
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: (key: string) => Promise.resolve(settings.get(key) ?? null),
    setSetting: vi.fn()
}));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: vi.fn(),
    requireOrgPermission: vi.fn()
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: (viewer: unknown, field: string, ids: string[]) => {
        askedPrivacy(viewer, field, ids);
        return Promise.resolve(new Set(ids.filter((id) => !hiddenBy.has(id))));
    }
}));

const { nameTagsFor, INSTANCE_TAG_KEY } = await import("@/lib/name-tags/name-tag-service");

beforeEach(() => {
    org = { ...ORG_ROW };
    members = [{ userId: ALICE, restricted: false }];
    choices = [
        { userId: OWNER, orgId: ORG },
        { userId: ALICE, orgId: ORG }
    ];
    settings = new Map();
    hiddenBy = new Set();
    findChoices.mockClear();
    askedPrivacy.mockClear();
});

describe("name tags", () => {
    it("shows the tag of owners and members", async () => {
        const tags = await nameTagsFor(VIEWER, [OWNER, ALICE, BOB]);
        expect(tags.get(OWNER)?.text).toBe("ACME");
        expect(tags.get(ALICE)?.emblem).toBe("bolt");
        expect(tags.has(BOB)).toBe(false);
    });

    it("drops the tag once the wearer leaves or is restricted", async () => {
        members = [];
        expect((await nameTagsFor(VIEWER, [ALICE])).has(ALICE)).toBe(false);
        members = [{ userId: ALICE, restricted: true }];
        expect((await nameTagsFor(VIEWER, [ALICE])).has(ALICE)).toBe(false);
    });

    it("drops every tag once the organization turns them off", async () => {
        org = { ...org, tagEnabled: false };
        expect((await nameTagsFor(VIEWER, [OWNER, ALICE])).size).toBe(0);
    });

    it("follows the badges audience, and always shows your own", async () => {
        hiddenBy = new Set([ALICE]);
        const tags = await nameTagsFor(VIEWER, [OWNER, ALICE]);
        expect(tags.has(ALICE)).toBe(false);
        expect(tags.has(OWNER)).toBe(true);
        expect(askedPrivacy).toHaveBeenCalledWith(VIEWER, "badges", expect.any(Array));
        expect((await nameTagsFor({ id: ALICE, isAdmin: false }, [ALICE])).has(ALICE)).toBe(true);
    });

    it("answers a whole screen with one read and one privacy check", async () => {
        const ids = Array.from(
            { length: 50 },
            (_, i) => `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`
        );
        for (const id of ids) {
            members.push({ userId: id, restricted: false });
            choices.push({ userId: id, orgId: ORG });
        }
        const tags = await nameTagsFor(VIEWER, [...ids, ALICE, ALICE]);
        expect(tags.size).toBe(51);
        expect(findChoices).toHaveBeenCalledTimes(1);
        expect(askedPrivacy).toHaveBeenCalledTimes(1);
    });

    it("shows the instance tag only while it is on", async () => {
        choices = [{ userId: BOB, orgId: null }];
        expect((await nameTagsFor(VIEWER, [BOB])).has(BOB)).toBe(false);
        settings.set(
            INSTANCE_TAG_KEY,
            JSON.stringify({ enabled: true, text: "STAF", emblem: "shield", color: "red" })
        );
        expect((await nameTagsFor(VIEWER, [BOB])).get(BOB)).toMatchObject({
            text: "STAF",
            orgId: null
        });
    });
});
