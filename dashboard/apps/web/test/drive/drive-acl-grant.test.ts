/**
 * Writing one access rule.
 *
 * Two screens write the same row: the people dialog, which asks who, for how
 * long and why, and the access rules dialog, which asks who and which verbs and
 * nothing else. Because both land on an upsert keyed by (connection, path,
 * principal), the second one silently owns whatever the first one set - so what
 * is pinned here is that a caller only changes what it actually said, and that a
 * grant naming nobody is refused before it is stored.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
// A fixed instant, because what the grant does next depends on which side of it
// the stored date falls on - a real clock would decide that differently in a
// week's time and the run would stop meaning anything.
const NOW = new Date("2026-08-28T09:00:00Z");
const FRIDAY = new Date("2026-09-04T00:00:00Z");
const LAST_MONTH = new Date("2026-07-24T00:00:00Z");

const aclFindFirst = vi.fn(async () => null);
const aclCreate = vi.fn(async () => ({}));
const aclUpdate = vi.fn(async () => ({}));
const userFindUnique = vi.fn();
const groupFindUnique = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        driveAcl: {
            findFirst: aclFindFirst,
            findMany: vi.fn(async () => []),
            create: aclCreate,
            update: aclUpdate,
            deleteMany: vi.fn(async () => ({ count: 1 }))
        },
        user: { findUnique: userFindUnique },
        group: { findUnique: groupFindUnique }
    }
}));
vi.mock("@polaris/auth", () => ({
    getUserGroupIds: async () => [],
    resolvePrincipalPolicyStatements: async () => []
}));

const { setDriveAcl } = await import("../../src/lib/drive-acl-service");

/** A grant of the verbs the rules dialog sends, and nothing else. */
function rule(over: Record<string, unknown> = {}) {
    return {
        connectionId: "conn-1",
        path: "reports/2026",
        principalType: "user" as const,
        principalId: BEN,
        actions: ["read" as const, "download" as const],
        effect: "allow" as const,
        createdById: ANA,
        ...over
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    aclFindFirst.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: BEN } as never);
    groupFindUnique.mockResolvedValue({ id: "group-7" } as never);
});

describe("replacing a rule somebody already holds", () => {
    it("keeps the date and the line when the caller mentions neither", async () => {
        aclFindFirst.mockResolvedValue({
            id: "grant-1",
            expiresAt: FRIDAY,
            note: "The quarter's numbers"
        } as never);

        await setDriveAcl(rule());

        const { data } = aclUpdate.mock.calls[0][0];
        // Changing what somebody may do from a screen that never asked about the
        // date must not turn a share given until Friday into a permanent one.
        expect(data.expiresAt).toEqual(FRIDAY);
        expect(data.note).toBe("The quarter's numbers");
    });

    it("drops a date that has already passed rather than granting nothing", async () => {
        // The row is still there once its date goes by - nothing sweeps the
        // table - and granting access again is the one gesture that means "from
        // now". Carrying the lapse forward would write access nobody has.
        aclFindFirst.mockResolvedValue({
            id: "grant-1",
            expiresAt: LAST_MONTH,
            note: "The quarter's numbers"
        } as never);

        await setDriveAcl(rule());

        const { data } = aclUpdate.mock.calls[0][0];
        expect(data.expiresAt).toBeNull();
        expect(data.note).toBe("The quarter's numbers");
    });

    it("clears them when the caller actually says to", async () => {
        aclFindFirst.mockResolvedValue({ id: "grant-1", expiresAt: FRIDAY, note: "Old" } as never);

        await setDriveAcl(rule({ expiresAt: null, note: null }));

        const { data } = aclUpdate.mock.calls[0][0];
        expect(data.expiresAt).toBeNull();
        expect(data.note).toBeNull();
    });
});

describe("who a rule may name", () => {
    it("refuses an id that is nobody", async () => {
        userFindUnique.mockResolvedValue(null as never);

        await expect(setDriveAcl(rule({ principalId: ANA }))).rejects.toThrow();
        expect(aclCreate).not.toHaveBeenCalled();
        expect(aclUpdate).not.toHaveBeenCalled();
    });

    it("refuses a group that is not there", async () => {
        groupFindUnique.mockResolvedValue(null as never);

        await expect(
            setDriveAcl(rule({ principalType: "group", principalId: "group-7" }))
        ).rejects.toThrow();
        expect(aclCreate).not.toHaveBeenCalled();
    });

    it("refuses a line longer than a line", async () => {
        // The cap on the input is a courtesy; this is the one that holds when the
        // call does not come from the dialog.
        await expect(setDriveAcl(rule({ note: "x".repeat(201) }))).rejects.toThrow();
        expect(aclCreate).not.toHaveBeenCalled();
    });
});
