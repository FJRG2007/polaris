/**
 * Writing a password without the old one. An account that only ever signed in
 * through a provider or a passkey has no password row to update, and the write
 * must still leave behind a password that signs in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AccountRow {
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

    it("writes nothing for a password that is too short", async () => {
        expect(await resetUserPassword(auth, "user-1", "short")).toHaveProperty("error");
        expect(accounts).toHaveLength(0);
    });
});
