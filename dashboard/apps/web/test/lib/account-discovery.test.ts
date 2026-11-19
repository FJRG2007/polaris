/**
 * Who a field naming people can offer.
 *
 * Colleagues as before, plus friends, plus strangers by whatever the instance's
 * discovery policy allows - by default only their whole username - and never
 * anybody who hid from this account or is on either side of a block.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Account {
    id: string;
    name: string;
    email: string;
    username: string;
    bannedAt: Date | null;
    disabledAt: Date | null;
    phone: { phone: string; verifiedAt: Date | null } | null;
}

function account(id: string, name: string): Account {
    return {
        id,
        name,
        email: `${id}@example.test`,
        username: `fixture_${id}`,
        bannedAt: null,
        disabledAt: null,
        phone: null
    };
}

const accounts: Account[] = [
    account("viewer", "Test Viewer"),
    account("colleague", "Fixture Colleague"),
    account("friend", "Fixture Friend"),
    account("stranger", "Fixture Stranger"),
    account("hidden", "Fixture Hidden"),
    account("blocker", "Fixture Blocker")
];

let friends = new Set<string>();
let stored: string | null = null;
/** Accounts whose "who can find me" leaves the viewer out. */
let hiddenFrom = new Set<string>();
/** Accounts on either side of a block with the viewer. */
let blocked = new Set<string>();
/** Accounts that show the viewer their address. */
let showsEmail = new Set<string>();
/** Accounts whose "find me by email" or "by phone" leaves the viewer out. */
let hiddenByContact = new Map<string, Set<string>>();

type Text = { contains: string } | string;

function textMatches(value: string, rule: Text): boolean {
    return typeof rule === "string"
        ? value === rule
        : value.toLowerCase().includes(rule.contains.toLowerCase());
}

/** One `where`, applied to a row in memory. */
function matches(person: Account, where: Record<string, unknown>): boolean {
    for (const [field, rule] of Object.entries(where)) {
        if (field === "OR") {
            if (!(rule as Record<string, unknown>[]).some((inner) => matches(person, inner)))
                return false;
        } else if (field === "AND") {
            if (!(rule as Record<string, unknown>[]).every((inner) => matches(person, inner)))
                return false;
        } else if (field === "id") {
            const id = rule as { in?: string[]; notIn?: string[]; not?: string };
            if (id.in && !id.in.includes(person.id)) return false;
            if (id.notIn && id.notIn.includes(person.id)) return false;
            if (id.not && id.not === person.id) return false;
        } else if (field === "name" || field === "username" || field === "email") {
            if (!textMatches(person[field], rule as Text)) return false;
        } else if (field === "bannedAt" || field === "disabledAt") {
            if (rule === null && person[field] !== null) return false;
        } else if (field === "emails") {
            return false;
        } else if (field === "phone") {
            const wanted = (rule as { is: { phone: string; verifiedAt: { not: null } } }).is;
            if (person.phone?.phone !== wanted.phone || person.phone.verifiedAt === null)
                return false;
        } else {
            throw new Error(`unhandled field ${field}`);
        }
    }
    return true;
}

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DB_PROVIDER: "sqlite" }) }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => stored,
    setSetting: async (_key: string, value: string | null) => {
        stored = value;
    }
}));
vi.mock("@/lib/friends-service", () => ({ friendIds: async () => friends }));
vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: unknown, ids: readonly string[]) =>
        new Set(ids.filter((id) => !hiddenFrom.has(id))),
    allowedBy: async (viewer: { isAdmin: boolean }, field: string, ids: readonly string[]) =>
        new Set(
            ids.filter(
                (id) =>
                    viewer.isAdmin ||
                    (field === "email"
                        ? showsEmail.has(id)
                        : !(hiddenByContact.get(field)?.has(id) ?? false))
            )
        )
}));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set<string>(),
    blockedBetween: async (_viewer: string, ids: readonly string[]) =>
        new Set(ids.filter((id) => blocked.has(id)))
}));
vi.mock("@/lib/tasks/access", () => ({
    visibleScope: async () => ({}),
    scopeSpaceIds: () => ["space"]
}));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
// Somebody the reader's space was handed to in the share dialog.
vi.mock("@/lib/tasks/space-service", () => ({ spaceGrantees: async () => ["colleague"] }));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/chat/access", () => ({ conversationAudience: async () => null }));
vi.mock("@polaris/db", () => ({
    VISIBLE_USER: { bannedAt: null, disabledAt: null },
    prisma: {
        user: {
            findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
                accounts
                    .filter((person) => matches(person, where))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .slice(0, take)
        },
        organizationMember: { findMany: async () => [] }
    }
}));

const mentions = await import("@/lib/rich-text/mention-service");
const { setDiscoveryPolicy, findPeople } = await import("@/lib/people-search");
const { DEFAULT_DISCOVERY_POLICY } = await import("@/lib/discovery-policy");

const viewer = { id: "viewer", isAdmin: false };

async function search(term: string, actor = viewer): Promise<string[]> {
    return (await mentions.searchAccounts(actor, term)).map((found) => found.id);
}

async function byId(ids: string[], actor = viewer): Promise<string[]> {
    return (await mentions.accountsByIdInReach(actor, ids)).map((found) => found.id).sort();
}

beforeEach(() => {
    friends = new Set(["friend"]);
    stored = null;
    hiddenFrom = new Set();
    blocked = new Set();
    showsEmail = new Set();
    hiddenByContact = new Map();
    for (const person of accounts) person.phone = null;
    accounts.find((person) => person.id === "stranger")!.phone = {
        phone: "+34600111222",
        verifiedAt: new Date(0)
    };
});

describe("an account field for somebody who is not an administrator", () => {
    it("offers a friend by part of their name or username", async () => {
        expect(await search("Friend")).toEqual(["friend"]);
        expect(await search("fixture_fr")).toEqual(["friend"]);
    });

    it("offers friends and colleagues before anything is typed, and no strangers", async () => {
        expect((await search("")).sort()).toEqual(["colleague", "friend", "viewer"]);
    });

    it("keeps finding colleagues by part of their name, as before", async () => {
        expect(await search("Colleague")).toEqual(["colleague"]);
    });

    it("finds a stranger only by their whole username by default", async () => {
        expect(await search("Stranger")).toEqual([]);
        expect(await search("fixture_str")).toEqual([]);
        expect(await search("stranger@example.test")).toEqual([]);
        expect(await search("@fixture_stranger")).toEqual(["stranger"]);
    });

    it("leaves out anybody who hid from this account, friend or stranger", async () => {
        hiddenFrom = new Set(["friend", "stranger"]);
        expect(await search("Friend")).toEqual([]);
        expect(await search("fixture_stranger")).toEqual([]);
    });

    it("leaves out anybody on either side of a block", async () => {
        blocked = new Set(["friend", "blocker"]);
        friends = new Set(["friend", "blocker"]);
        // Colleagues match "Fixture" too, and are left as they were.
        expect((await search("Fixture")).sort()).toEqual(["colleague", "viewer"]);
        expect(await search("fixture_blocker")).toEqual([]);
    });
});

describe("the instance's discovery policy", () => {
    it("partial username widens to part of a username, and nothing else", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, usernamePartial: true });
        expect(await search("fixture_str")).toEqual(["stranger"]);
        expect(await search("Stranger X")).toEqual([]);
        expect(await search("stranger@example.test")).toEqual([]);
    });

    it("partial name widens to part of a name, and nothing else", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, namePartial: true });
        expect(await search("Stranger")).toEqual(["stranger"]);
        expect(await search("fixture_str")).toEqual([]);
        expect(await search("stranger@example.test")).toEqual([]);
    });

    it("whole email finds the account without printing the address", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, emailExact: true });
        const found = await mentions.searchAccounts(viewer, "Stranger@Example.test");
        expect(found.map((person) => person.id)).toEqual(["stranger"]);
        expect(found[0]!.email).toBe("");
        expect(found[0]!.username).toBe("fixture_stranger");
        expect(await search("example.test")).not.toContain("stranger");
    });

    it("whole username off leaves strangers unfindable, and friends still found", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, usernameExact: false });
        expect(await search("fixture_stranger")).toEqual([]);
        expect(await search("Friend")).toEqual(["friend"]);
    });

    it("still answers a single letter with no stranger", async () => {
        await setDiscoveryPolicy({
            usernameExact: true,
            usernamePartial: true,
            namePartial: true,
            emailExact: true,
            phoneExact: true
        });
        expect(await search("S")).not.toContain("stranger");
    });
});

describe("an administrator", () => {
    it("finds anybody by part of a name or address, as before", async () => {
        const admin = { id: "viewer", isAdmin: true };
        expect(await search("Stranger", admin)).toEqual(["stranger"]);
        expect(await search("hidden@", admin)).toEqual(["hidden"]);
    });
});

describe("picking by id", () => {
    it("accepts a colleague and a friend", async () => {
        expect(await byId(["colleague", "friend"])).toEqual(["colleague", "friend"]);
    });

    it("refuses a stranger the search would find, since an id proves nothing typed", async () => {
        expect(await search("fixture_stranger")).toEqual(["stranger"]);
        expect(await byId(["colleague", "friend", "stranger"])).toEqual(["colleague", "friend"]);
    });

    it("refuses whoever is hidden or blocked", async () => {
        hiddenFrom = new Set(["hidden"]);
        blocked = new Set(["blocker"]);
        expect(await byId(["hidden", "blocker", "friend"])).toEqual(["friend"]);
    });

    it("refuses strangers when no rule finds them", async () => {
        await setDiscoveryPolicy({
            usernameExact: false,
            usernamePartial: false,
            namePartial: false,
            emailExact: false,
            phoneExact: false
        });
        expect(await byId(["stranger", "friend"])).toEqual(["friend"]);
    });
});

describe("finding somebody by email or phone", () => {
    async function people(term: string): Promise<string[]> {
        return (await findPeople(viewer, term, { reachableOnly: false })).people.map(
            (person) => person.id
        );
    }

    it("finds by the whole address only when that account's email setting allows it", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, emailExact: true });
        expect(await search("stranger@example.test")).toEqual(["stranger"]);
        expect(await people("stranger@example.test")).toEqual(["stranger"]);

        hiddenByContact = new Map([["findByEmail", new Set(["stranger"])]]);
        expect(await search("stranger@example.test")).toEqual([]);
        expect(await people("stranger@example.test")).toEqual([]);
    });

    it("holds an address match to the email setting, not to the username one", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, emailExact: true });
        hiddenFrom = new Set(["stranger"]);
        expect(await search("stranger@example.test")).toEqual(["stranger"]);
        expect(await search("fixture_stranger")).toEqual([]);
    });

    it("leaves a username search alone whatever the email and phone settings say", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, emailExact: true, phoneExact: true });
        hiddenByContact = new Map([
            ["findByEmail", new Set(["stranger"])],
            ["findByPhone", new Set(["stranger"])]
        ]);
        expect(await search("fixture_stranger")).toEqual(["stranger"]);
        expect(await people("@fixture_stranger")).toEqual(["stranger"]);
    });

    it("still refuses an address match across a block", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, emailExact: true });
        blocked = new Set(["stranger"]);
        expect(await search("stranger@example.test")).toEqual([]);
    });

    it("finds by phone only when the instance allows it", async () => {
        expect(await search("+34600111222")).toEqual([]);
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, phoneExact: true });
        expect(await search("+34600111222")).toEqual(["stranger"]);
        // Written the way people copy a number, it is still the same number.
        expect(await people("+34 600 11 12 22")).toEqual(["stranger"]);
    });

    it("finds by phone only when that account's phone setting allows it", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, phoneExact: true });
        hiddenByContact = new Map([["findByPhone", new Set(["stranger"])]]);
        expect(await search("+34600111222")).toEqual([]);
        expect(await people("+34600111222")).toEqual([]);
        // Hidden from a phone search is not hidden from a username one.
        expect(await search("fixture_stranger")).toEqual(["stranger"]);
    });

    it("never matches part of a number, one without its prefix, or an unconfirmed one", async () => {
        await setDiscoveryPolicy({ ...DEFAULT_DISCOVERY_POLICY, phoneExact: true });
        expect(await search("+3460011")).toEqual([]);
        expect(await search("600111222")).toEqual([]);
        expect(await search("111222")).toEqual([]);
        accounts.find((person) => person.id === "stranger")!.phone!.verifiedAt = null;
        expect(await search("+34600111222")).toEqual([]);
    });
});
