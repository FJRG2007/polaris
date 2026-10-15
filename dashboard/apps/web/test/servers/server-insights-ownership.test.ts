/**
 * The insights route checks every named server in one read: all of them have to
 * be the reader's, and the box Polaris runs on needs no row to be.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";

const MINE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ALSO_MINE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
const THEIRS = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const OWNED: Record<string, string> = { [MINE]: "owner", [ALSO_MINE]: "owner", [THEIRS]: "someone-else" };

const reads: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            count: async (args: { where: { id: { in: string[] }; ownerId: string } }) => {
                reads.push(args);
                return args.where.id.in.filter((id) => OWNED[id] === args.where.ownerId).length;
            }
        }
    }
}));

const { hostsBelongToOwner } = await import("@/lib/metrics-history-service");

beforeEach(() => {
    reads.length = 0;
});

describe("hostsBelongToOwner", () => {
    it("answers for several servers in one read", async () => {
        expect(await hostsBelongToOwner([MINE, ALSO_MINE, LOCAL_HOST_SUBJECT], "owner")).toBe(true);
        expect(reads).toHaveLength(1);
    });

    it("refuses the whole list when one server is somebody else's", async () => {
        expect(await hostsBelongToOwner([MINE, THEIRS], "owner")).toBe(false);
    });

    it("needs no read for the box Polaris runs on alone", async () => {
        expect(await hostsBelongToOwner([LOCAL_HOST_SUBJECT], "owner")).toBe(true);
        expect(reads).toHaveLength(0);
    });
});
