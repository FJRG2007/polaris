/**
 * Who an address has been seen on, as the firewall asks it.
 *
 * The dialog behind an address exists so a ban can be checked rather than
 * believed, and the check that matters most is whether the address belongs to
 * somebody who is signed in. So this is about the join and its two blind spots:
 * a session row is deleted when the session ends, and the activity log only ever
 * holds a hash of the address. Neither answers on its own, and an account that
 * only ever failed to get in must still be named.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHROME = "Mozilla/5.0 (Windows NT 10.0) Chrome/140";

interface SessionRow {
    id: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    userAgent: string | null;
    state: Record<string, unknown> | null;
}

interface AuditGroup {
    actorId: string | null;
    action: string;
    _count: { _all: number };
    _max: { at: Date | null };
}

let sessionRows: SessionRow[] = [];
let movedRows: SessionRow[] = [];
let auditGroups: AuditGroup[] = [];
let sessionQueries: Record<string, unknown>[] = [];
let auditQuery: Record<string, unknown> | null = null;
let userQuery: { id: { in: string[] } } | null = null;

const PEOPLE = [
    { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", image: null, bannedAt: null },
    {
        id: "user-2",
        name: "",
        email: "grace@example.com",
        image: null,
        bannedAt: new Date("2026-08-01T00:00:00Z")
    }
];

// The real hash reaches for node:crypto through a module that pulls in the whole
// auth stack; what matters here is that the address is hashed before it is asked
// about, never that this is what sha256 says.
vi.mock("@/lib/audit-service", () => ({ auditIpHash: (ip: string) => `hashed:${ip}` }));
vi.mock("@polaris/db", () => ({
    prisma: {
        session: {
            findMany: async (args: Record<string, unknown>) => {
                sessionQueries.push(args);
                return "ipAddress" in (args.where as Record<string, unknown>)
                    ? sessionRows
                    : movedRows;
            }
        },
        auditLog: {
            groupBy: async (args: Record<string, unknown>) => {
                auditQuery = args;
                return auditGroups;
            }
        },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                userQuery = where;
                return PEOPLE.filter((person) => where.id.in.includes(person.id));
            }
        }
    }
}));

const { accountsAtAddress } = await import("../../src/lib/address-accounts");

const NOW = Date.parse("2026-08-04T12:00:00Z");

function session(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
        id: "session-1",
        userId: "user-1",
        createdAt: new Date("2026-08-04T10:00:00Z"),
        expiresAt: new Date("2026-09-04T10:00:00Z"),
        userAgent: CHROME,
        state: {
            approval: "approved",
            country: "ES",
            host: "polaris.example.com",
            lastSeenAt: new Date("2026-08-04T11:00:00Z"),
            secondFactor: "totp",
            signInMethod: "password",
            userAgent: CHROME,
            userAgentBrands: null
        },
        ...overrides
    };
}

function group(overrides: Partial<AuditGroup> = {}): AuditGroup {
    return {
        actorId: "user-1",
        action: "account.signin",
        _count: { _all: 1 },
        _max: { at: new Date("2026-08-04T09:00:00Z") },
        ...overrides
    };
}

beforeEach(() => {
    sessionRows = [];
    movedRows = [];
    auditGroups = [];
    sessionQueries = [];
    auditQuery = null;
    userQuery = null;
});

describe("accounts at an address", () => {
    // Two reads rather than one `OR`: neither index can be used for a query that
    // matches the column or the other table's, so asking both at once scans every
    // session ever opened.
    it("asks separately for sessions opened at the address and sessions that moved to it", async () => {
        await accountsAtAddress("85.87.156.88", NOW);
        expect(sessionQueries.map((query) => query.where)).toEqual([
            { ipAddress: "85.87.156.88" },
            { state: { is: { ip: "85.87.156.88" } } }
        ]);
    });

    it("merges the two without listing a session that both found twice", async () => {
        sessionRows = [session()];
        movedRows = [
            session(),
            session({ id: "session-2", createdAt: new Date("2026-08-04T11:00:00Z") })
        ];
        const accounts = await accountsAtAddress("85.87.156.88", NOW);
        expect(accounts[0]?.sessions.map((entry) => entry.id)).toEqual(["session-2", "session-1"]);
    });

    // The log stores the address hashed, so it can only be asked this way - and
    // only about the sign-ins, not about everything the account has ever done.
    it("asks the log by hash, for the sign-in outcomes alone", async () => {
        await accountsAtAddress("85.87.156.88", NOW);
        expect(auditQuery?.where).toEqual({
            ipHash: "hashed:85.87.156.88",
            actorId: { not: null },
            action: {
                in: ["account.signin", "account.signin.blocked", "account.signin.awaiting-approval"]
            }
        });
    });

    it("gathers an account's sessions under it, and names it by its email when it has no name", async () => {
        sessionRows = [session(), session({ id: "session-2", userId: "user-2" })];
        const accounts = await accountsAtAddress("85.87.156.88", NOW);
        expect(accounts.map((account) => account.name)).toEqual([
            "Ada Lovelace",
            "grace@example.com"
        ]);
        expect(accounts[0]?.sessions).toHaveLength(1);
        expect(accounts[0]?.sessions[0]?.device).toBe("Chrome on Windows");
        expect(accounts[1]?.banned).toBe(true);
    });

    // A row outliving its session is the only record that the address was ever
    // signed in from, so it is listed - and never counted as somebody who is here.
    it("keeps an expired session and leaves it out of the live count", async () => {
        sessionRows = [
            session({ id: "session-old", expiresAt: new Date("2026-08-03T10:00:00Z") }),
            session({ id: "session-now" })
        ];
        const accounts = await accountsAtAddress("85.87.156.88", NOW);
        expect(accounts[0]?.sessions.map((entry) => entry.live)).toEqual([false, true]);
        expect(accounts[0]?.live).toBe(1);
    });

    // The whole point of reading the log as well: an address that failed its way
    // through an account's network rules leaves no session behind at all.
    it("names an account that only ever had sign-ins refused here", async () => {
        auditGroups = [
            group({ actorId: "user-2", action: "account.signin.blocked", _count: { _all: 12 } })
        ];
        const accounts = await accountsAtAddress("85.87.156.88", NOW);
        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.id).toBe("user-2");
        expect(accounts[0]?.signIns).toEqual({ accepted: 0, refused: 12, awaiting: 0 });
        expect(accounts[0]?.sessions).toEqual([]);
    });

    it("counts each sign-in outcome against the account it was aimed at", async () => {
        auditGroups = [
            group({ _count: { _all: 3 } }),
            group({ action: "account.signin.blocked", _count: { _all: 2 } }),
            group({ action: "account.signin.awaiting-approval", _count: { _all: 1 } }),
            group({ actorId: "user-2", _count: { _all: 5 } })
        ];
        const accounts = await accountsAtAddress("85.87.156.88", NOW);
        const ada = accounts.find((account) => account.id === "user-1");
        expect(ada?.signIns).toEqual({ accepted: 3, refused: 2, awaiting: 1 });
        expect(accounts.find((account) => account.id === "user-2")?.signIns.accepted).toBe(5);
    });

    // A ban cuts off whoever is signed in from the address, so they come first
    // however long ago somebody else's last attempt was.
    it("puts an account that is signed in now above one that only tried", async () => {
        sessionRows = [session({ userId: "user-2" })];
        auditGroups = [group({ _max: { at: new Date("2026-08-04T11:59:00Z") } })];
        const accounts = await accountsAtAddress("85.87.156.88", NOW);
        expect(accounts.map((account) => account.id)).toEqual(["user-2", "user-1"]);
    });

    it("has nothing to say about an address nobody has ever been seen on", async () => {
        expect(await accountsAtAddress("85.87.156.88", NOW)).toEqual([]);
    });

    // The log is asked about the gateway a whole company signs in through as
    // readily as about one attacker, and it holds a group per account and
    // outcome, so the question itself has to be bounded rather than the answer.
    it("asks the log for the most recent sign-ins only, and a bounded number of them", async () => {
        await accountsAtAddress("85.87.156.88", NOW);
        expect(auditQuery?.orderBy).toEqual({ _max: { at: "desc" } });
        expect(typeof auditQuery?.take).toBe("number");
    });

    // Every account named is carried to the browser whole, and the panel draws
    // six of them. A shared address must not turn that into the directory.
    it("looks up no more accounts than it is willing to carry back", async () => {
        sessionRows = Array.from({ length: 400 }, (_, index) =>
            session({ id: `session-${index}`, userId: `user-${index}` })
        );
        auditGroups = Array.from({ length: 400 }, (_, index) =>
            group({ actorId: `other-${index}` })
        );
        await accountsAtAddress("85.87.156.88", NOW);
        const asked = userQuery?.id.in ?? [];
        expect(asked.length).toBeLessThanOrEqual(50);
        // Whoever a ban would actually cut off is who survives the cut.
        expect(asked.every((id) => id.startsWith("user-"))).toBe(true);
    });

    // Which is by whether the session is still open, not by how recently it was
    // opened: an account signed in from here since last month is what a ban would
    // break, and an account whose session expired yesterday is not.
    it("keeps whoever is still signed in over whoever only opened a session more recently", async () => {
        sessionRows = [
            ...Array.from({ length: 60 }, (_, index) =>
                session({
                    id: `expired-${index}`,
                    userId: `gone-${index}`,
                    expiresAt: new Date("2026-08-03T10:00:00Z")
                })
            ),
            session({ id: "held", createdAt: new Date("2026-07-01T10:00:00Z") })
        ];
        await accountsAtAddress("85.87.156.88", NOW);
        expect(userQuery?.id.in).toContain("user-1");
    });
});
