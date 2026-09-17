/**
 * Where a Polaris account is signed in from, as a game server's allow list reads
 * it: only sessions in use count, IPv4 only, and a session on the local network
 * also counts for the network's public address.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    userId: string;
    ipAddress: string | null;
    state: { ip: string | null; approval: string; lockedAt: Date | null } | null;
};
let rows: Row[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        session: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                rows.filter((row) => where.userId.in.includes(row.userId))
        }
    }
}));
vi.mock("@/lib/network-service", () => ({ networkPublicIp: async () => "5.6.7.8" }));

const { signInAddresses, signedIn } = await import("@/lib/apps/game-sign-in-addresses");

const ADA = "ada";
const BOB = "bob";

beforeEach(() => {
    rows = [];
});

describe("the addresses an account is signed in from", () => {
    it("are the sessions in use, the moved address first", async () => {
        rows = [
            {
                userId: ADA,
                ipAddress: "1.2.3.1",
                state: { ip: "1.2.3.9", approval: "approved", lockedAt: null }
            },
            { userId: ADA, ipAddress: "1.2.3.2", state: null }
        ];
        const found = await signInAddresses([ADA, BOB]);
        expect(found.get(ADA)).toEqual(["1.2.3.9", "1.2.3.2"]);
        expect(found.get(BOB)).toEqual([]);
    });

    it("leave out a session waiting for approval, refused, locked, or on IPv6", async () => {
        rows = [
            {
                userId: ADA,
                ipAddress: "1.2.3.1",
                state: { ip: null, approval: "pending", lockedAt: null }
            },
            {
                userId: ADA,
                ipAddress: "1.2.3.2",
                state: { ip: null, approval: "denied", lockedAt: null }
            },
            {
                userId: ADA,
                ipAddress: "1.2.3.3",
                state: { ip: null, approval: "approved", lockedAt: new Date() }
            },
            { userId: ADA, ipAddress: "2001:db8::1", state: null }
        ];
        expect((await signInAddresses([ADA])).get(ADA)).toEqual([]);
        // Signed in over IPv6 is still signed in, which is all ARK asks.
        expect(await signedIn([ADA])).toEqual(new Set([ADA]));
        rows.pop();
        expect(await signedIn([ADA])).toEqual(new Set());
    });

    it("count a session on the local network for the public address too", async () => {
        rows = [{ userId: ADA, ipAddress: "192.168.1.20", state: null }];
        expect((await signInAddresses([ADA])).get(ADA)).toEqual(["192.168.1.20", "5.6.7.8"]);
        expect(await signedIn([ADA])).toEqual(new Set([ADA]));
    });
});
