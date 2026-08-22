/**
 * Who an emailed sign-in link may open an account for.
 *
 * This is the whole gate. The endpoint that asks for a link stays open to
 * everybody - it has to, or the answer would say which addresses are registered
 * here - so nothing is refused at the door: the link is simply not sent unless
 * the account asked for this way in. What is pinned here is that "asked for it"
 * is the only thing that turns it on, since the failure nobody would notice is
 * the default drifting to true and every mailbox becoming a way into its account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";

interface UserRow {
    id: string;
    email: string;
    bannedAt: Date | null;
}

interface SecurityRow {
    userId: string;
    emailLinkSignIn: boolean;
}

let users: UserRow[] = [];
let security: SecurityRow[] = [];

const prisma = {
    user: {
        findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
            const row = users.find((entry) => entry.email === where.email || entry.id === where.id);
            return row ? { ...row } : null;
        }
    },
    userSecurity: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
            const row = security.find((entry) => entry.userId === where.userId);
            return row ? { ...row } : null;
        },
        upsert: async ({
            where,
            create,
            update
        }: {
            where: { userId: string };
            create: Partial<SecurityRow>;
            update: Partial<SecurityRow>;
        }) => {
            const row = security.find((entry) => entry.userId === where.userId);
            if (row) {
                Object.assign(row, update);
                return { ...row };
            }
            const created: SecurityRow = { userId: where.userId, emailLinkSignIn: false, ...create };
            security.push(created);
            return { ...created };
        }
    },
    userAccessGroup: {
        findMany: async () => []
    }
};

vi.mock("@polaris/db", () => ({ prisma }));

const { emailLinkSignInAllowed, setEmailLinkSignIn } = await import("../../src/security.js");

beforeEach(() => {
    users = [{ id: USER, email: "ada@example.com", bannedAt: null }];
    security = [];
});

describe("an emailed sign-in link", () => {
    it("is not sent to an account that never asked for one", async () => {
        // The row does not exist at all, which is every account until it touches
        // this screen: the absent row has to read as off, not as unset.
        expect(await emailLinkSignInAllowed("ada@example.com")).toBe(false);
    });

    it("is not sent to an account whose row says nothing about it", async () => {
        security = [{ userId: USER, emailLinkSignIn: false }];
        expect(await emailLinkSignInAllowed("ada@example.com")).toBe(false);
    });

    it("is sent once the account turns it on", async () => {
        await setEmailLinkSignIn(USER, true);
        expect(await emailLinkSignInAllowed("ada@example.com")).toBe(true);
    });

    it("stops being sent when the account turns it off again", async () => {
        await setEmailLinkSignIn(USER, true);
        await setEmailLinkSignIn(USER, false);
        expect(await emailLinkSignInAllowed("ada@example.com")).toBe(false);
    });

    it("answers the same for an address with no account here", async () => {
        // Identical to "has one and did not ask", which is the point: what comes
        // back must not tell an unauthenticated caller who has an account.
        expect(await emailLinkSignInAllowed("nobody@example.com")).toBe(false);
    });

    it("ignores the case and spacing the address was typed with", async () => {
        await setEmailLinkSignIn(USER, true);
        expect(await emailLinkSignInAllowed("  Ada@Example.com ")).toBe(true);
    });

    it("is refused for a suspended account that had turned it on", async () => {
        // The way in is switched off with the account, not left behind by it.
        await setEmailLinkSignIn(USER, true);
        users[0]!.bannedAt = new Date();
        expect(await emailLinkSignInAllowed("ada@example.com")).toBe(false);
    });
});
