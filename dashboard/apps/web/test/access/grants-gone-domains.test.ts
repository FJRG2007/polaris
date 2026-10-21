/**
 * A lent domain that is deleted - by itself, or with its app, environment or
 * project - takes its grants with it, and a domain still there keeps them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const KEPT = "00000000-0000-7000-8000-0000000000a1";
const GONE = "00000000-0000-7000-8000-0000000000a2";

let lent: string[] = [];
let domains: string[] = [];
const deleteMany = vi.fn(async () => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        accessGrant: {
            findMany: async () => lent.map((subjectId) => ({ subjectId })),
            deleteMany
        },
        domain: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                domains.filter((id) => where.id.in.includes(id)).map((id) => ({ id }))
        }
    }
}));

vi.mock("@/lib/orgs/org-service", () => ({ teamIdsFor: async () => [] }));

const { dropGrantsOfGoneDomains } = await import("@/lib/access/grants");

beforeEach(() => {
    lent = [];
    domains = [];
    deleteMany.mockClear();
});

describe("grants of deleted domains", () => {
    it("drops only the grants whose domain is gone", async () => {
        lent = [KEPT, GONE];
        domains = [KEPT];
        await dropGrantsOfGoneDomains();
        expect(deleteMany).toHaveBeenCalledWith({
            where: { subjectType: "place.domain", subjectId: { in: [GONE] } }
        });
    });

    it("deletes nothing when every lent domain is still there", async () => {
        lent = [KEPT];
        domains = [KEPT];
        await dropGrantsOfGoneDomains();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it("deletes nothing when no domain is lent", async () => {
        await dropGrantsOfGoneDomains();
        expect(deleteMany).not.toHaveBeenCalled();
    });
});
