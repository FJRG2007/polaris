/**
 * What trusting an address is supposed to mean to the firewall.
 *
 * It has one job an operator's own access depends on, and it is the job it did not
 * do: the flag told the detectors to stop judging the address from then on, and left
 * the ban already written exactly where it was. The screen said the address was
 * trusted, the edge went on blocking it, and the only way back in was a route that
 * never passed the guard. So both halves are asserted here - the flag is stored, and
 * the ban it contradicts is gone.
 *
 * The gate on the way in is the other half. Every path that bans funnels through
 * recordWafBan, and the callers that filtered their own candidates first each did it
 * separately; the one that forgot is what puts a trusted address back on the list a
 * minute after it was taken off.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
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
let settings = new Map<string, string>();

const INTEL_FILE = join(tmpdir(), `polaris-waf-intel-${process.pid}.json`);
process.env.POLARIS_EDGE_INTEL_FILE = INTEL_FILE;

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        settings.set(key, value);
    }
}));
// The reputation providers are asked about addresses seen in traffic; nothing here
// reaches traffic, and an unconfigured integration is the shape under test anyway.
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    getIntegrationState: async () => null
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        wafBan: {
            findUnique: async ({ where }: { where: { ip: string } }) =>
                bans.find((ban) => ban.ip === where.ip) ?? null,
            findMany: async () => bans,
            upsert: async ({ where, create }: { where: { ip: string }; create: BanRow }) => {
                bans = [...bans.filter((ban) => ban.ip !== where.ip), { ...create, offences: 1 }];
                return create;
            },
            deleteMany: async ({ where }: { where: { ip: { in: string[] } } }) => {
                const before = bans.length;
                bans = bans.filter((ban) => !where.ip.in.includes(ban.ip));
                return { count: before - bans.length };
            }
        },
        wafIpFeed: { findUnique: async () => null },
        user: { findMany: async () => [] }
    }
}));

const { getWafIgnoreList, recordWafBan, setWafIgnoreList, wafTrustedAddresses } = await import(
    "../../src/lib/waf-intel-service"
);

const OPERATOR = "85.87.156.88";

function ban(ip: string): BanRow {
    return { ip, reason: "ban", source: "not-found", note: "Missing-page flood", until: null, offences: 6 };
}

beforeEach(() => {
    bans = [];
    settings = new Map();
});

describe("trusting an address", () => {
    it("lifts the ban it is already serving", async () => {
        bans = [ban(OPERATOR), ban("203.0.113.9")];

        await setWafIgnoreList([OPERATOR]);

        expect(bans.map((row) => row.ip)).toEqual(["203.0.113.9"]);
        expect(await getWafIgnoreList()).toEqual([OPERATOR]);
    });

    it("takes the address off the list the edge reads", async () => {
        bans = [ban(OPERATOR)];

        await setWafIgnoreList([OPERATOR]);

        const published: unknown = JSON.parse(await readFile(INTEL_FILE, "utf8"));
        expect(Object.keys((published as { ips: Record<string, unknown> }).ips)).not.toContain(OPERATOR);
    });

    it("keeps loopback trusted without anybody saying so", async () => {
        expect(await wafTrustedAddresses()).toContain("127.0.0.1");
        expect(await wafTrustedAddresses()).toContain("::1");
    });
});

describe("banning an address", () => {
    it("refuses the ones an operator marked as theirs, whichever jail asked", async () => {
        await setWafIgnoreList([OPERATOR]);

        await recordWafBan({ ip: OPERATOR, reason: "ban", source: "anomaly:route-flood", until: null });

        expect(bans).toEqual([]);
    });

    it("still bans everyone else", async () => {
        await setWafIgnoreList([OPERATOR]);

        await recordWafBan({ ip: "203.0.113.9", reason: "ban", source: "anomaly:route-flood", until: null });

        expect(bans.map((row) => row.ip)).toEqual(["203.0.113.9"]);
    });
});
