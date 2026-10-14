/**
 * Whose face an address in Mail is.
 *
 * Three things are pinned here, because each of them failing looks like
 * something else on screen. An address has to be matched however it is cased
 * and through every address an account provably holds - and through none it
 * merely claims, or anybody can wear a colleague's face on their mail. The
 * privacy rule has to hold exactly as it does elsewhere, and a hidden face has
 * to read as "nobody here" rather than as a refusal. And the answers have to be
 * remembered, because a mailbox asks once per row and is opened all day.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    [key: string]: unknown;
}

let users: Row[] = [];
let alternates: Row[] = [];
let mailboxes: Row[] = [];
let servers: Row[] = [];
let visibleTo: (subjectId: string, viewerId: string) => boolean = () => true;
let gravatarOn = true;
let gravatarAsked: string[] = [];
const queries = { user: 0, userEmail: 0, mailAccount: 0, mailServer: 0, privacy: 0 };

/** What Postgres does with `mode: "insensitive"`: ILIKE, where `_` and `%` are
 *  patterns. Emulated as such, so the exact comparison after it is tested. */
function ilike(value: unknown, pattern: string): boolean {
    const source = pattern
        .split("")
        .map((c) => (c === "_" ? "." : c === "%" ? ".*" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
    return typeof value === "string" && new RegExp(`^${source}$`, "i").test(value);
}

function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, rule]) => {
        if (rule && typeof rule === "object" && "equals" in rule) {
            return ilike(row[key], (rule as { equals: string }).equals);
        }
        if (rule && typeof rule === "object" && "not" in rule) return row[key] !== null;
        return row[key] === rule;
    });
}

function table(name: keyof typeof queries, rows: () => Row[]) {
    return {
        findMany: async ({ where }: { where: Row }) => {
            queries[name] += 1;
            return rows().filter((row) => matches(row, where));
        }
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        user: table("user", () => users),
        userEmail: table("userEmail", () => alternates),
        mailAccount: table("mailAccount", () => mailboxes),
        mailServer: table("mailServer", () => servers)
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    maySee: async (subjectId: string, field: string, viewer: { id: string }) => {
        queries.privacy += 1;
        expect(field).toBe("avatar");
        return visibleTo(subjectId, viewer.id);
    }
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

vi.mock("@/lib/avatar-service", () => ({
    gravatarEnabled: async () => gravatarOn,
    gravatarImage: async (email: string) => {
        gravatarAsked.push(email);
        return email.startsWith("known")
            ? { image: { bytes: PNG, mime: "image/png", etag: '"gabc"' }, certain: true }
            : { image: null, certain: true };
    }
}));

const { addressGravatar, addressOwner, forgetFaceOwners, visibleOwner } = await import(
    "../../src/lib/mailbox/face-owner"
);

const reader = { id: "reader", isAdmin: false };

beforeEach(() => {
    forgetFaceOwners();
    users = [];
    alternates = [];
    mailboxes = [];
    servers = [];
    visibleTo = () => true;
    gravatarOn = true;
    gravatarAsked = [];
    for (const key of Object.keys(queries) as (keyof typeof queries)[]) queries[key] = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("which account an address belongs to", () => {
    it("matches the verified sign-in address whatever its case", async () => {
        users = [{ id: "u1", email: "Person.One@Example.TEST", emailVerified: true }];
        expect(await addressOwner("person.one@example.test")).toBe("u1");
        forgetFaceOwners();
        expect(await addressOwner("  PERSON.ONE@example.test ")).toBe("u1");
    });

    it("ignores a sign-in address nobody has verified", async () => {
        users = [{ id: "u1", email: "person.one@example.test", emailVerified: false }];
        expect(await addressOwner("person.one@example.test")).toBeNull();
    });

    it("matches a verified alternate address and ignores an unverified claim", async () => {
        alternates = [
            { userId: "u2", email: "Second@Example.test", verifiedAt: new Date() },
            { userId: "u3", email: "claimed@example.test", verifiedAt: null }
        ];
        expect(await addressOwner("second@example.test")).toBe("u2");
        expect(await addressOwner("claimed@example.test")).toBeNull();
    });

    it("does not let a pattern character stand in for another address", async () => {
        // ILIKE reads `_` as any one character, so the database answers this
        // row for `axb@...`; only the exact comparison after it refuses it.
        alternates = [{ userId: "u4", email: "a_b@example.test", verifiedAt: new Date() }];
        expect(await addressOwner("axb@example.test")).toBeNull();
        expect(await addressOwner("a_b@example.test")).toBe("u4");
    });

    it("matches a mailbox signed in to on a mail server this Polaris runs", async () => {
        servers = [
            { hostname: "mail.example.test", primaryDomain: "example.test", status: "ready" }
        ];
        mailboxes = [
            {
                userId: "u5",
                address: "Desk@example.test",
                username: "desk",
                imapHost: "MAIL.example.test",
                lastOkAt: new Date()
            }
        ];
        expect(await addressOwner("desk@example.test")).toBe("u5");
    });

    it("ignores a mailbox on an outside host, one never signed in to, or one signed in as somebody else", async () => {
        servers = [
            { hostname: "mail.example.test", primaryDomain: "example.test", status: "ready" }
        ];
        mailboxes = [
            {
                userId: "u6",
                address: "boss@example.test",
                username: "boss@example.test",
                imapHost: "imap.elsewhere.test",
                lastOkAt: new Date()
            },
            {
                userId: "u7",
                address: "ceo@example.test",
                username: "ceo",
                imapHost: "mail.example.test",
                lastOkAt: null
            },
            {
                userId: "u8",
                address: "chair@example.test",
                username: "intern",
                imapHost: "mail.example.test",
                lastOkAt: new Date()
            }
        ];
        expect(await addressOwner("boss@example.test")).toBeNull();
        expect(await addressOwner("ceo@example.test")).toBeNull();
        expect(await addressOwner("chair@example.test")).toBeNull();
    });

    it("ignores a mailbox on a server that is not ready", async () => {
        servers = [
            { hostname: "mail.example.test", primaryDomain: "example.test", status: "setting-up" }
        ];
        mailboxes = [
            {
                userId: "u5",
                address: "desk@example.test",
                username: "desk",
                imapHost: "mail.example.test",
                lastOkAt: new Date()
            }
        ];
        expect(await addressOwner("desk@example.test")).toBeNull();
    });

    it("gives a shared address to nobody", async () => {
        servers = [
            { hostname: "mail.example.test", primaryDomain: "example.test", status: "ready" }
        ];
        mailboxes = [
            {
                userId: "u1",
                address: "help@example.test",
                username: "help",
                imapHost: "mail.example.test",
                lastOkAt: new Date()
            },
            {
                userId: "u2",
                address: "help@example.test",
                username: "help",
                imapHost: "mail.example.test",
                lastOkAt: new Date()
            }
        ];
        expect(await addressOwner("help@example.test")).toBeNull();
    });

    it("counts one person holding an address two ways as one", async () => {
        users = [{ id: "u1", email: "one@example.test", emailVerified: true }];
        servers = [
            { hostname: "mail.example.test", primaryDomain: "example.test", status: "ready" }
        ];
        mailboxes = [
            {
                userId: "u1",
                address: "one@example.test",
                username: "one",
                imapHost: "mail.example.test",
                lastOkAt: new Date()
            }
        ];
        expect(await addressOwner("one@example.test")).toBe("u1");
    });

    it("refuses something that is not an address without asking the database", async () => {
        expect(await addressOwner("nobody")).toBeNull();
        expect(await addressOwner("@example.test")).toBeNull();
        expect(queries.user).toBe(0);
    });
});

describe("who may see the face", () => {
    beforeEach(() => {
        users = [{ id: "u1", email: "one@example.test", emailVerified: true }];
    });

    it("answers as if nobody owned the address when the privacy rule says no", async () => {
        visibleTo = () => false;
        expect(await visibleOwner("one@example.test", reader)).toBeNull();
    });

    it("shows it when the rule allows, and always to the person and to an administrator", async () => {
        expect(await visibleOwner("one@example.test", reader)).toBe("u1");
        visibleTo = () => false;
        expect(await visibleOwner("one@example.test", { id: "u1", isAdmin: false })).toBe("u1");
        expect(await visibleOwner("one@example.test", { id: "admin", isAdmin: true })).toBe("u1");
    });
});

describe("what is remembered", () => {
    it("asks the database once per address and the privacy rule once per reader", async () => {
        users = [{ id: "u1", email: "one@example.test", emailVerified: true }];
        await Promise.all([
            visibleOwner("one@example.test", reader),
            visibleOwner("ONE@example.test", reader),
            visibleOwner("one@example.test", reader)
        ]);
        await visibleOwner("one@example.test", reader);
        expect(queries.user).toBe(1);
        expect(queries.privacy).toBeLessThanOrEqual(3);
        const before = queries.privacy;
        await visibleOwner("one@example.test", reader);
        expect(queries.privacy).toBe(before);
    });

    it("remembers that an address has nobody", async () => {
        await addressOwner("stranger@example.test");
        await addressOwner("stranger@example.test");
        expect(queries.user).toBe(1);
    });

    it("obeys a privacy change within a minute", async () => {
        vi.useFakeTimers();
        users = [{ id: "u1", email: "one@example.test", emailVerified: true }];
        expect(await visibleOwner("one@example.test", reader)).toBe("u1");
        visibleTo = () => false;
        expect(await visibleOwner("one@example.test", reader)).toBe("u1");
        vi.advanceTimersByTime(61_000);
        expect(await visibleOwner("one@example.test", reader)).toBeNull();
    });
});

describe("Gravatar for an address", () => {
    it("asks Gravatar for the address, lowercased", async () => {
        const answer = await addressGravatar("Known@Example.test");
        expect(answer?.image?.etag).toBe('"gabc"');
        expect(gravatarAsked).toEqual(["known@example.test"]);
    });

    it("answers nothing for an address Gravatar does not know", async () => {
        expect((await addressGravatar("unknown@example.test"))?.image).toBeNull();
    });

    it("asks nobody when the administrator turned Gravatar off", async () => {
        gravatarOn = false;
        expect(await addressGravatar("known@example.test")).toBeNull();
        expect(gravatarAsked).toEqual([]);
    });

    it("gives up when the caller stops waiting", async () => {
        const stop = new AbortController();
        stop.abort(new Error("gone"));
        expect(await addressGravatar("known@example.test", stop.signal)).toBeNull();
    });
});
