/**
 * The addresses on an account. Two rules carry the weight here: an address is
 * only ever claimed by one account - checked against both the primary addresses
 * and the alternates - and promoting one keeps the outgoing primary instead of
 * dropping an address the account still owns.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    email: string;
    recovery: boolean;
    verifiedAt: Date | null;
    createdAt: Date;
}

const users = new Map<string, { email: string; emailVerified: boolean }>();
let alternates: Row[] = [];
let password = "hunter22";

const prisma = {
    user: {
        findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
        findFirst: async ({ where }: { where: { email: string; id?: { not: string } } }) => {
            for (const [id, user] of users) {
                if (user.email === where.email && id !== where.id?.not) return { id };
            }
            return null;
        },
        update: async ({
            where,
            data
        }: {
            where: { id: string };
            data: { email: string; emailVerified: boolean };
        }) => {
            users.set(where.id, { email: data.email, emailVerified: data.emailVerified });
            return data;
        },
        updateMany: async ({
            where,
            data
        }: {
            where: { id: string; email?: string; emailVerified?: boolean };
            data: { emailVerified: boolean };
        }) => {
            const user = users.get(where.id);
            const matches =
                user !== undefined &&
                (where.email === undefined || user.email === where.email) &&
                (where.emailVerified === undefined || user.emailVerified === where.emailVerified);
            if (!matches) return { count: 0 };
            users.set(where.id, { ...user, emailVerified: data.emailVerified });
            return { count: 1 };
        }
    },
    userEmail: {
        findFirst: async ({ where }: { where: { id?: string; userId?: string; email?: string } }) =>
            alternates.find(
                (row) =>
                    (where.id === undefined || row.id === where.id) &&
                    (where.userId === undefined || row.userId === where.userId) &&
                    (where.email === undefined || row.email === where.email)
            ) ?? null,
        findMany: async ({ where }: { where: { userId: string } }) =>
            alternates.filter((row) => row.userId === where.userId),
        count: async ({ where }: { where: { userId: string } }) =>
            alternates.filter((row) => row.userId === where.userId).length,
        create: async ({ data }: { data: { userId: string; email: string; verifiedAt?: Date } }) => {
            const row = {
                id: `id-${alternates.length + 1}`,
                recovery: false,
                verifiedAt: null,
                createdAt: new Date("2026-07-29T10:00:00.000Z"),
                ...data
            };
            alternates.push(row);
            return row;
        },
        delete: async ({ where }: { where: { id: string } }) => {
            alternates = alternates.filter((row) => row.id !== where.id);
            return {};
        },
        deleteMany: async ({ where }: { where: { id: string; userId: string } }) => {
            const before = alternates.length;
            alternates = alternates.filter((row) => !(row.id === where.id && row.userId === where.userId));
            return { count: before - alternates.length };
        },
        updateMany: async ({
            where,
            data
        }: {
            where: { id?: string; userId: string; email?: string; verifiedAt?: null };
            data: { recovery?: boolean; verifiedAt?: Date };
        }) => {
            let count = 0;
            for (const row of alternates) {
                const matches =
                    row.userId === where.userId &&
                    (where.id === undefined || row.id === where.id) &&
                    (where.email === undefined || row.email === where.email) &&
                    (where.verifiedAt === undefined || row.verifiedAt === null);
                if (!matches) continue;
                if (data.recovery !== undefined) row.recovery = data.recovery;
                if (data.verifiedAt !== undefined) row.verifiedAt = data.verifiedAt;
                count += 1;
            }
            return { count };
        }
    },
    account: {
        findFirst: async () => ({ password: "stored-hash" })
    },
    // Statements are already resolved promises in this fake, so running them is enough.
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
};

vi.mock("@polaris/db", () => ({ prisma }));

const auth = {
    $context: Promise.resolve({
        password: { verify: async ({ password: given }: { password: string }) => given === password }
    })
} as never;

const {
    addUserEmail,
    adoptProviderEmail,
    emailOwner,
    listUserEmails,
    promoteUserEmail,
    removeUserEmail,
    setUserEmailRecovery,
    MAX_ALTERNATE_EMAILS
} = await import("../../src/account.js");

beforeEach(() => {
    users.clear();
    users.set("user-1", { email: "owner@example.com", emailVerified: false });
    users.set("user-2", { email: "other@example.com", emailVerified: false });
    alternates = [];
    password = "hunter22";
});

describe("adding an address", () => {
    it("takes a second address and lists it after the primary", async () => {
        expect(await addUserEmail("user-1", "  Spare@Example.com ")).toEqual({});
        const emails = await listUserEmails("user-1");
        expect(emails.map((entry) => entry.email)).toEqual(["owner@example.com", "spare@example.com"]);
        expect(emails[0]?.primary).toBe(true);
        expect(emails[1]?.primary).toBe(false);
    });

    it("refuses one that is already somebody's primary", async () => {
        expect(await addUserEmail("user-1", "other@example.com")).toEqual({
            error: "That email is already in use."
        });
    });

    it("refuses one another account already holds as an alternate", async () => {
        await addUserEmail("user-2", "shared@example.com");
        expect(await addUserEmail("user-1", "shared@example.com")).toEqual({
            error: "That email is already in use."
        });
    });

    it("refuses one this account already holds, rather than letting the column refuse it", async () => {
        await addUserEmail("user-1", "spare@example.com");
        expect(await addUserEmail("user-1", "spare@example.com")).toEqual({
            error: "That email is already in use."
        });
        expect(await listUserEmails("user-1")).toHaveLength(2);
    });

    it("refuses your own primary and anything that is not an address", async () => {
        expect((await addUserEmail("user-1", "owner@example.com")).error).toBe(
            "That is already your primary address."
        );
        expect((await addUserEmail("user-1", "not-an-address")).error).toBe("Enter a valid email address.");
    });

    it("caps how many alternates one account can hold", async () => {
        for (let index = 0; index < MAX_ALTERNATE_EMAILS; index += 1) {
            expect(await addUserEmail("user-1", `spare${index}@example.com`)).toEqual({});
        }
        expect((await addUserEmail("user-1", "one-too-many@example.com")).error).toContain("at most");
    });
});

describe("an address a linked provider handed over", () => {
    it("is held for its owner, already proved, so nobody else can be given it", async () => {
        expect(await adoptProviderEmail("user-1", " Work@Example.com ", { verified: true })).toEqual({});
        const [, adopted] = await listUserEmails("user-1");
        expect(adopted).toMatchObject({ email: "work@example.com", verified: true });
        expect(await emailOwner("work@example.com")).toBe("user-1");
        expect((await addUserEmail("user-2", "work@example.com")).error).toBe("That email is already in use.");
    });

    it("proves an address the account had already claimed but not confirmed", async () => {
        await addUserEmail("user-1", "spare@example.com");
        expect((await listUserEmails("user-1"))[1]?.verified).toBe(false);
        expect(await adoptProviderEmail("user-1", "spare@example.com", { verified: true })).toEqual({});
        expect((await listUserEmails("user-1"))[1]?.verified).toBe(true);
    });

    it("leaves an address somebody else holds exactly where it is", async () => {
        await addUserEmail("user-2", "theirs@example.com");
        expect((await adoptProviderEmail("user-1", "theirs@example.com", { verified: true })).error).toBe(
            "That address is already on another account."
        );
        expect(await emailOwner("theirs@example.com")).toBe("user-2");
        expect(await listUserEmails("user-1")).toHaveLength(1);
    });

    it("confirms the address the account already signs in with", async () => {
        expect((await listUserEmails("user-1"))[0]).toMatchObject({ primary: true, verified: false });
        expect(await adoptProviderEmail("user-1", "owner@example.com", { verified: true })).toEqual({});
        const emails = await listUserEmails("user-1");
        expect(emails).toHaveLength(1);
        expect(emails[0]).toMatchObject({ primary: true, verified: true });
    });
});

describe("an address from a provider this deployment does not trust", () => {
    it("is held for its owner, but still has to be proved", async () => {
        expect(await adoptProviderEmail("user-1", "work@example.com", { verified: false })).toEqual({});
        const [, adopted] = await listUserEmails("user-1");
        expect(adopted).toMatchObject({ email: "work@example.com", verified: false });
        expect((await addUserEmail("user-2", "work@example.com")).error).toBe("That email is already in use.");
    });

    it("leaves the primary unconfirmed", async () => {
        expect(await adoptProviderEmail("user-1", "owner@example.com", { verified: false })).toEqual({});
        expect((await listUserEmails("user-1"))[0]).toMatchObject({ primary: true, verified: false });
    });

    it("never takes back what another provider already proved", async () => {
        await adoptProviderEmail("user-1", "work@example.com", { verified: true });
        expect(await adoptProviderEmail("user-1", "work@example.com", { verified: false })).toEqual({});
        expect((await listUserEmails("user-1"))[1]?.verified).toBe(true);
    });
});

describe("recovery and removal", () => {
    it("flags an address as a recovery contact and clears it again", async () => {
        await addUserEmail("user-1", "spare@example.com");
        const [, spare] = await listUserEmails("user-1");
        await setUserEmailRecovery("user-1", String(spare?.id), true);
        expect((await listUserEmails("user-1"))[1]?.recovery).toBe(true);
        await setUserEmailRecovery("user-1", String(spare?.id), false);
        expect((await listUserEmails("user-1"))[1]?.recovery).toBe(false);
    });

    it("never touches another account's address", async () => {
        await addUserEmail("user-2", "theirs@example.com");
        const theirs = alternates[0];
        expect(await removeUserEmail("user-1", theirs.id)).toEqual({
            error: "That address is no longer on your account."
        });
        expect(await setUserEmailRecovery("user-1", theirs.id, true)).toEqual({
            error: "That address is no longer on your account."
        });
        expect(alternates).toHaveLength(1);
    });
});

describe("promoting an address", () => {
    it("swaps primary and alternate once the password checks out", async () => {
        await addUserEmail("user-1", "spare@example.com");
        const [, spare] = await listUserEmails("user-1");
        expect(await promoteUserEmail(auth, "user-1", String(spare?.id), "hunter22")).toEqual({});
        const emails = await listUserEmails("user-1");
        expect(emails[0]).toMatchObject({ email: "spare@example.com", primary: true });
        expect(emails[1]).toMatchObject({ email: "owner@example.com", primary: false });
    });

    it("changes nothing when the password is wrong", async () => {
        await addUserEmail("user-1", "spare@example.com");
        const [, spare] = await listUserEmails("user-1");
        expect(await promoteUserEmail(auth, "user-1", String(spare?.id), "wrong")).toEqual({
            error: "Current password is incorrect."
        });
        expect((await listUserEmails("user-1"))[0]?.email).toBe("owner@example.com");
    });

    it("refuses an address that is not on the account", async () => {
        await addUserEmail("user-2", "theirs@example.com");
        expect(await promoteUserEmail(auth, "user-1", alternates[0].id, "hunter22")).toEqual({
            error: "That address is no longer on your account."
        });
    });
});
