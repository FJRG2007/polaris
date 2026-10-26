/**
 * A reputation verdict never costs a person their way in.
 *
 * A new member accepting an invite over a shared egress address was banned on a
 * provider's FRAUD verdict about that address - a verdict about everybody else on it -
 * and every request after the invite page answered 403. These pin the fix: no
 * reputation ban for an address somebody is signed in from, the ban is lifted when an
 * account signs in or accepts an invite from it, and only reputation is ever lifted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface BanRow {
    ip: string;
    reason: string;
    source: string;
    note: string | null;
    until: Date | null;
    offences: number;
}

let bans: BanRow[] = [];
let signedIn = new Set<string>();
let audits: { action: string; targetId: string; actorId: string }[] = [];
let asked: string[] = [];

process.env.POLARIS_EDGE_INTEL_FILE = "";

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => "test-key",
    getIntegrationState: async (slug: string) =>
        slug === "dymo" ? { enabled: true, config: null } : null
}));
vi.mock("@/lib/integrations/registry", () => ({
    readDymoConfig: () => ({ verifyAccessIp: true, deny: ["FRAUD"] })
}));
vi.mock("@/lib/address-reputation", () => ({
    rememberedVerdict: async () => null,
    rememberVerdict: async () => undefined
}));
vi.mock("@/lib/integrations/dymo", () => ({
    verifyIp: async (_key: string, ip: string) => {
        asked.push(ip);
        return { allow: false, reasons: ["FRAUD"] };
    }
}));
vi.mock("@/lib/address-accounts", () => ({
    addressesSignedIn: async (ips: readonly string[]) =>
        new Set(ips.filter((ip) => signedIn.has(ip)))
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { action: string; targetId: string; actorId: string }) => {
        audits.push(event);
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        wafBan: {
            findUnique: async ({ where }: { where: { ip: string } }) =>
                bans.find((ban) => ban.ip === where.ip) ?? null,
            findMany: async ({ where }: { where?: { ip?: { in: string[] } } } = {}) =>
                where?.ip?.in ? bans.filter((ban) => where.ip?.in.includes(ban.ip)) : bans,
            upsert: async ({ where, create }: { where: { ip: string }; create: BanRow }) => {
                bans = [...bans.filter((ban) => ban.ip !== where.ip), { ...create, offences: 1 }];
                return create;
            },
            deleteMany: async ({ where }: { where: { ip: string; reason: string } }) => {
                const before = bans.length;
                bans = bans.filter((ban) => !(ban.ip === where.ip && ban.reason === where.reason));
                return { count: before - bans.length };
            }
        },
        wafIpFeed: { findUnique: async () => null, upsert: async () => undefined },
        user: { findMany: async () => [] }
    }
}));

const { checkReputation, liftReputationBanOnSignIn } = await import("@/lib/waf-intel-service");

const SHARED = "203.0.113.20";
const OTHER = "203.0.113.21";
const later = () => new Date(Date.now() + 3600_000);

beforeEach(() => {
    bans = [];
    signedIn = new Set();
    audits = [];
    asked = [];
});

describe("reputation and the people signed in", () => {
    it("does not ban, or even ask about, an address somebody is signed in from", async () => {
        signedIn = new Set([SHARED]);
        await checkReputation([SHARED, OTHER]);
        expect(asked).toEqual([OTHER]);
        expect(bans.map((ban) => ban.ip)).toEqual([OTHER]);
    });

    it("lifts a reputation ban when an account signs in from the address, and says why", async () => {
        bans = [{ ip: SHARED, reason: "reputation", source: "dymo", note: "FRAUD", until: later(), offences: 1 }];
        expect(await liftReputationBanOnSignIn(SHARED, "user-1")).toBe(true);
        expect(bans).toEqual([]);
        expect(audits).toEqual([
            expect.objectContaining({ action: "waf.ban.lift.signin", targetId: SHARED, actorId: "user-1" })
        ]);
    });

    it("lifts it on an accepted invite too", async () => {
        bans = [{ ip: SHARED, reason: "reputation", source: "dymo", note: "FRAUD", until: later(), offences: 1 }];
        expect(await liftReputationBanOnSignIn(SHARED, "user-2", "invite")).toBe(true);
        expect(bans).toEqual([]);
    });

    it("leaves a jail, Tor or manual ban exactly where it is", async () => {
        for (const reason of ["ban", "tor", "manual"]) {
            bans = [{ ip: SHARED, reason, source: "probes", note: null, until: later(), offences: 1 }];
            expect(await liftReputationBanOnSignIn(SHARED, "user-1")).toBe(false);
            expect(bans).toHaveLength(1);
        }
        expect(audits).toEqual([]);
    });

    it("does nothing for an address with no ban, or no address at all", async () => {
        expect(await liftReputationBanOnSignIn(SHARED, "user-1")).toBe(false);
        expect(await liftReputationBanOnSignIn(null, "user-1")).toBe(false);
    });
});
