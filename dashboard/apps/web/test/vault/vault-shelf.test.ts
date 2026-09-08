/**
 * Which vaults the shelf lets through.
 *
 * A vault belongs to a person or to one company, and the switcher in the header
 * says which of those somebody is working as. Standing on one company's shelf
 * and being shown another company's vault is the same disclosure as standing on
 * it and being shown somebody's own - so the narrowing is asserted on the query
 * itself rather than on what a screen happened to draw, because that is where it
 * would leak.
 *
 * The rule it pins is one sentence: **the shelf only ever intersects.** It can
 * take a vault out of what somebody may reach and it can never put one in.
 */

import { describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async () => [] as unknown[]);

vi.mock("@polaris/db", () => ({ prisma: { vaultOrganization: { findMany } } }));

// The module reaches the audit log, which reaches auth, which wants the whole
// environment. None of that has anything to say about a `where` clause.
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

const { vaultsReachableBy } = await import("@/lib/vault/orgs");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** The `where` the last call asked with. */
function asked(): Record<string, unknown> {
    const call = findMany.mock.calls.at(-1) as unknown as [{ where: Record<string, unknown> }];
    return call[0].where;
}

describe("the shelf and a vault", () => {
    it("asks only for that company's on a company shelf", async () => {
        await vaultsReachableBy("u1", [ORG, OTHER], ORG);
        const where = asked();
        // Both halves, and the order matters: the reachability clause is still
        // there, so a shelf cannot be a way into a vault nobody let this account
        // into.
        expect(where.AND).toEqual([
            expect.objectContaining({ OR: expect.any(Array) }),
            { organizationId: ORG }
        ]);
    });

    it("clamps with AND, so nothing in the reachability half can widen it", async () => {
        // The shape is what matters rather than the ids. The reachability clause
        // may still name every organization this account is on - the caller
        // narrows that too, but it is belt and braces - and the clamp is an AND
        // beside it rather than another branch of the OR. As an OR branch it
        // would ADD that company's vault instead of restricting to it, which is
        // the one way this could be written that leaks.
        await vaultsReachableBy("u1", [ORG, OTHER], ORG);
        const where = asked();
        expect(where.OR).toBeUndefined();
        expect((where.AND as unknown[]).at(-1)).toEqual({ organizationId: ORG });
    });

    it("asks only for what belongs to a person on somebody's own shelf", async () => {
        await vaultsReachableBy("u1", [], null);
        expect(asked().AND).toEqual([
            expect.objectContaining({ OR: expect.any(Array) }),
            { organizationId: null }
        ]);
    });

    it("still requires a way in, whichever shelf is open", async () => {
        // The shelf narrows; it does not authorize. Somebody standing on a
        // company's shelf who was never let into its vault is still asking for
        // one they own or were admitted to.
        await vaultsReachableBy("u1", [ORG], ORG);
        const reach = (asked().AND as { OR: unknown[] }[])[0]!;
        expect(reach.OR).toEqual(
            expect.arrayContaining([
                { ownerUserId: "u1" },
                expect.objectContaining({ members: expect.anything() })
            ])
        );
    });
});
