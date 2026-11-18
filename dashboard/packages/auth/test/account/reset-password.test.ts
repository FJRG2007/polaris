/**
 * Writing a password without the old one. An account that only ever signed in
 * through a provider or a passkey has no password row to update, and the write
 * must still leave behind a password that signs in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AccountRow {
    id?: string;
    updatedAt?: Date;
    userId: string;
    providerId: string;
    accountId: string;
    password: string | null;
}

let accounts: AccountRow[] = [];

const prisma = {
    account: {
        updateMany: async ({
            where,
            data
        }: {
            where: { userId: string; providerId: string };
            data: { password: string };
        }) => {
            const rows = accounts.filter(
                (row) => row.userId === where.userId && row.providerId === where.providerId
            );
            for (const row of rows) row.password = data.password;
            return { count: rows.length };
        },
        findMany: async ({ where }: { where: { userId: string; providerId: string } }) =>
            accounts
                .filter((row) => row.userId === where.userId && row.providerId === where.providerId)
                .map((row) => ({ ...row, updatedAt: row.updatedAt ?? new Date(0) })),
        update: async ({ where, data }: { where: { id: string }; data: { accountId: string } }) => {
            const row = accounts.find((entry) => entry.id === where.id)!;
            row.accountId = data.accountId;
            return row;
        }
    }
};

vi.mock("@polaris/db", () => ({ prisma }));

const linkAccount = vi.fn(async (row: AccountRow) => void accounts.push({ ...row }));
const auth = {
    $context: Promise.resolve({
        password: { hash: async (value: string) => `hashed:${value}` },
        internalAdapter: { linkAccount }
    })
} as never;

const { resetUserPassword } = await import("../../src/security.js");

beforeEach(() => {
    accounts = [];
    linkAccount.mockClear();
});

describe("resetUserPassword", () => {
    it("replaces the password an account already has", async () => {
        accounts = [
            {
                userId: "user-1",
                providerId: "credential",
                accountId: "user-1",
                password: "hashed:old"
            }
        ];
        expect(await resetUserPassword(auth, "user-1", "a long new secret")).toEqual({});
        expect(accounts).toEqual([
            {
                userId: "user-1",
                providerId: "credential",
                accountId: "user-1",
                password: "hashed:a long new secret"
            }
        ]);
        expect(linkAccount).not.toHaveBeenCalled();
    });

    it("gives a provider-only account a password sign-in", async () => {
        accounts = [{ userId: "user-1", providerId: "github", accountId: "gh-1", password: null }];
        expect(await resetUserPassword(auth, "user-1", "a long new secret")).toEqual({});
        expect(accounts).toContainEqual({
            userId: "user-1",
            providerId: "credential",
            accountId: "user-1",
            password: "hashed:a long new secret"
        });
        expect(accounts.find((row) => row.providerId === "github")?.password).toBeNull();
    });

    it("points a password kept under an old id back at its account", async () => {
        // Written before user ids became uuids: sign-in looks the password up
        // by the user's id and would never find this one.
        accounts = [
            {
                id: "row-1",
                userId: "user-1",
                providerId: "credential",
                accountId: "0123456789abcdef0123456789abcdef",
                password: "hashed:old"
            }
        ];
        expect(await resetUserPassword(auth, "user-1", "a long new secret")).toEqual({});
        expect(accounts[0]).toMatchObject({ accountId: "user-1", password: "hashed:a long new secret" });
        expect(linkAccount).not.toHaveBeenCalled();
    });

    it("leaves an account that already has a matching row alone", async () => {
        accounts = [
            { id: "row-1", userId: "user-1", providerId: "credential", accountId: "user-1", password: "hashed:old" },
            { id: "row-2", userId: "user-1", providerId: "credential", accountId: "stale", password: null }
        ];
        await resetUserPassword(auth, "user-1", "a long new secret");
        expect(accounts.map((row) => row.accountId)).toEqual(["user-1", "stale"]);
    });

    it("writes nothing for a password that is too short", async () => {
        expect(await resetUserPassword(auth, "user-1", "short")).toHaveProperty("error");
        expect(accounts).toHaveLength(0);
    });
});
