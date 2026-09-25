/**
 * Whose revision date moves when an item in a shared vault changes.
 *
 * The revision date is the one thing a client asks before it syncs, so an
 * account left out here is an account whose browser never learns that a login
 * shared with it exists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTHOR = "018f2b7a-0000-7000-8000-0000000000d1";
const MEMBER = "018f2b7a-0000-7000-8000-0000000000d2";
const VAULT = "018f2b7a-0000-7000-8000-0000000000d3";

const orgUsers = vi.fn(async () => [] as { userId: string | null }[]);
const accountUpdateMany = vi.fn(async () => ({ count: 0 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultOrgUser: { findMany: orgUsers },
        vaultAccount: { updateMany: accountUpdateMany }
    }
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob: vi.fn(async () => undefined) }));
vi.mock("@/lib/vault/password", () => ({
    hashVaultPassword: vi.fn(),
    newSecurityStamp: vi.fn(),
    verifyVaultPassword: vi.fn()
}));

const { bumpRevisionFor } = await import("../../src/lib/vault/account");

/** The accounts the last bump reached. */
function bumped(): string[] {
    const call = accountUpdateMany.mock.calls.at(-1) as unknown as
        | [{ where: { userId: string | { in: string[] } } }]
        | undefined;
    const target = call?.[0].where.userId;
    if (target === undefined) return [];
    return typeof target === "string" ? [target] : [...target.in].sort();
}

beforeEach(() => {
    vi.clearAllMocks();
    orgUsers.mockResolvedValue([]);
});

describe("moving the revision for a changed item", () => {
    it("moves every member of the vault the item is in, and the author", async () => {
        orgUsers.mockResolvedValue([{ userId: AUTHOR }, { userId: MEMBER }, { userId: null }]);

        await bumpRevisionFor(AUTHOR, [VAULT]);

        expect(orgUsers.mock.calls[0]?.[0]).toMatchObject({ where: { orgId: { in: [VAULT] } } });
        expect(bumped()).toEqual([AUTHOR, MEMBER].sort());
    });

    it("moves only the author for a personal item, without asking about members", async () => {
        await bumpRevisionFor(AUTHOR, [null]);

        expect(orgUsers).not.toHaveBeenCalled();
        expect(bumped()).toEqual([AUTHOR]);
    });

    it("still moves the author when the members could not be read", async () => {
        orgUsers.mockRejectedValue(new Error("down"));

        await bumpRevisionFor(AUTHOR, [VAULT]);

        expect(bumped()).toEqual([AUTHOR]);
    });
});
