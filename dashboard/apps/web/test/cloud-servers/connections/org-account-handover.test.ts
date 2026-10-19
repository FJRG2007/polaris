/**
 * Deleting the person who connected an organization's cloud account hands it
 * to the organization's owner first, so the account - and the servers still
 * running at it - is not cascaded away with them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    accounts: [] as { id: string; ownerId: string; orgOwnerId: string | null }[],
    queries: [] as unknown[]
}));

vi.mock("@polaris/db", () => {
    const updateMany = async ({
        where,
        data
    }: {
        where: { id: { in: string[] } };
        data: { ownerId: string };
    }) => {
        for (const account of state.accounts) {
            if (where.id.in.includes(account.id)) account.ownerId = data.ownerId;
        }
        return { count: where.id.in.length };
    };
    return {
        prisma: {
            cloudAccount: {
                findMany: async ({
                    where,
                    take
                }: {
                    where: { ownerId: string; organization: { ownerId: { not: string } } };
                    take: number;
                }) => {
                    state.queries.push(where);
                    return state.accounts
                        .filter(
                            (a) =>
                                a.ownerId === where.ownerId &&
                                a.orgOwnerId !== null &&
                                a.orgOwnerId !== where.organization.ownerId.not
                        )
                        .slice(0, take)
                        .map((a) => ({ id: a.id, organization: { ownerId: a.orgOwnerId } }));
                },
                updateMany
            },
            $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops)
        }
    };
});
vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/connections/org-scope", () => ({}));
vi.mock("@/lib/server-removal-service", () => ({ removeServer: vi.fn() }));
vi.mock("@/lib/enrollment-service", () => ({
    getEnrollmentStatus: vi.fn(),
    openEnrollment: vi.fn()
}));

const { handOverOrgCloudAccounts } = await import("../../../src/lib/cloud-servers-host");

beforeEach(() => {
    state.queries = [];
});

describe("handing over an organization's cloud accounts", () => {
    it("gives each organization's accounts to its owner and leaves personal ones alone", async () => {
        state.accounts = [
            { id: "org-a-1", ownerId: "leaving", orgOwnerId: "owner-a" },
            { id: "org-b-1", ownerId: "leaving", orgOwnerId: "owner-b" },
            { id: "own", ownerId: "leaving", orgOwnerId: null },
            { id: "someone-else", ownerId: "other", orgOwnerId: "owner-a" }
        ];
        await handOverOrgCloudAccounts("leaving");
        expect(Object.fromEntries(state.accounts.map((a) => [a.id, a.ownerId]))).toEqual({
            "org-a-1": "owner-a",
            "org-b-1": "owner-b",
            own: "leaving",
            "someone-else": "other"
        });
        expect(state.queries[0]).toEqual({
            ownerId: "leaving",
            organization: { ownerId: { not: "leaving" } }
        });
    });

    it("works through more accounts than one read takes", async () => {
        state.accounts = Array.from({ length: 1_201 }, (_, i) => ({
            id: `acc-${i}`,
            ownerId: "leaving",
            orgOwnerId: "owner-a"
        }));
        await handOverOrgCloudAccounts("leaving");
        expect(state.accounts.every((a) => a.ownerId === "owner-a")).toBe(true);
    });
});
