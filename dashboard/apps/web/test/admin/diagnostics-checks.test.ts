/**
 * Each diagnostics check, read from mocked sources: what passes, what warns,
 * what fails, and that a source which breaks or never answers is "unknown"
 * rather than a pass or a thrown page.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const queryRaw = vi.fn(async (): Promise<unknown> => [{ ok: 1 }]);
const health = vi.fn(async (): Promise<unknown> => ({ version: "1.4.0" }));
const capabilities = vi.fn(() => ({ edition: "full", hostd: { present: true, version: "1.4.0" } }));
const localDisk = vi.fn(async (): Promise<unknown> => ({ used: 50 * GB, total: 100 * GB }));
const getUpdateStatus = vi.fn(
    async (): Promise<unknown> => ({ upToDate: true, current: "2026.10.1" })
);
const checkedAddresses = vi.fn(async (): Promise<unknown> => []);
const polarisZoneHost = vi.fn(async (): Promise<string | null> => null);
const lookup = vi.fn(async (): Promise<unknown> => ({ address: "203.0.113.7", family: 4 }));

vi.mock("@polaris/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        health() {
            return health();
        }
    }
}));
vi.mock("@polaris/config", async (original) => ({
    ...(await original<typeof import("@polaris/config")>()),
    getCapabilities: () => capabilities(),
    loadEnv: () => ({ POLARIS_APP_URL: "http://192.168.1.10:3000" })
}));
vi.mock("@/lib/deploy/local-disk", () => ({ localDisk }));
vi.mock("@/lib/update-service", () => ({ getUpdateStatus }));
vi.mock("@/lib/address-health", () => ({ checkedAddresses }));
vi.mock("@/lib/domain-zones", () => ({ polarisZoneHost }));
vi.mock("node:dns/promises", () => ({ lookup, default: { lookup } }));
vi.mock("@/lib/deploy/disk-watch", async () => {
    // The real thresholds, without the watcher's notification imports.
    const LOW = 0.1;
    const CRITICAL = 0.05;
    return {
        diskLevel: (free: number, total: number) => {
            const ratio = free / total;
            if (ratio < CRITICAL || free < Math.min(2 * GB, total * 0.1)) return "critical";
            if (ratio < LOW || free < Math.min(5 * GB, total * 0.25)) return "low";
            return "ok";
        }
    };
});

const checks = await import("@/lib/diagnostics/checks");
const { runCheck, diskVerdict, certificateVerdict, clockVerdict, edgeVerdict, within } = checks;

let dynamic: string;

beforeAll(async () => {
    dynamic = await mkdtemp(join(tmpdir(), "polaris-diag-"));
    process.env.POLARIS_TRAEFIK_DYNAMIC_DIR = dynamic;
});

afterAll(async () => {
    delete process.env.POLARIS_TRAEFIK_DYNAMIC_DIR;
    await rm(dynamic, { recursive: true, force: true });
});

beforeEach(() => {
    vi.clearAllMocks();
    capabilities.mockReturnValue({ edition: "full", hostd: { present: true, version: "1.4.0" } });
    polarisZoneHost.mockResolvedValue(null);
});

describe("the pure verdicts", () => {
    it("reads disk space on the watcher's own thresholds", () => {
        expect(diskVerdict({ used: 50 * GB, total: 100 * GB }, true)).toMatchObject({
            status: "pass",
            code: "ok",
            fix: null
        });
        expect(diskVerdict({ used: 92 * GB, total: 100 * GB }, true)).toMatchObject({
            status: "warn",
            code: "low",
            fix: { kind: "action", action: "freeSpace" }
        });
        expect(diskVerdict({ used: 97 * GB, total: 100 * GB }, true)).toMatchObject({
            status: "fail",
            code: "critical"
        });
        expect(diskVerdict(null, true)).toMatchObject({ status: "unknown", code: "unreadable" });
    });

    it("offers to free space only where the host agent can do it", () => {
        expect(diskVerdict({ used: 97 * GB, total: 100 * GB }, false).fix).toBeNull();
    });

    it("grades a certificate by trust and days left", () => {
        const now = Date.UTC(2026, 9, 15);
        const at = (days: number) => new Date(now + days * DAY_MS);
        expect(
            certificateVerdict("p.example.com", { validTo: at(60), trusted: true }, now)
        ).toMatchObject({ status: "pass" });
        expect(
            certificateVerdict("p.example.com", { validTo: at(5), trusted: true }, now)
        ).toMatchObject({
            status: "warn",
            code: "expiring",
            facts: { days: 5 }
        });
        expect(
            certificateVerdict("p.example.com", { validTo: at(-3), trusted: true }, now)
        ).toMatchObject({
            status: "fail",
            code: "expired",
            facts: { days: 3 }
        });
        expect(
            certificateVerdict("p.example.com", { validTo: at(60), trusted: false }, now)
        ).toMatchObject({
            status: "fail",
            code: "untrusted"
        });
        expect(certificateVerdict("p.example.com", null, now)).toMatchObject({ status: "unknown" });
    });

    it("forgives clock skew under the Date header's resolution", () => {
        expect(clockVerdict(4_000)).toMatchObject({ status: "pass" });
        expect(clockVerdict(-90_000)).toMatchObject({
            status: "warn",
            code: "skewed",
            facts: { seconds: 90 }
        });
        expect(clockVerdict(600_000)).toMatchObject({ status: "fail", code: "skewed" });
        expect(clockVerdict(null)).toMatchObject({ status: "unknown" });
    });

    it("fails the edge on any empty route file and offers to republish", () => {
        expect(edgeVerdict([{ name: "polaris-apps.yml", size: 900 }])).toMatchObject({
            status: "pass",
            facts: { count: 1 }
        });
        expect(
            edgeVerdict([
                { name: "polaris-apps.yml", size: 0 },
                { name: "x.yml", size: 3 }
            ])
        ).toMatchObject({
            status: "fail",
            code: "empty",
            facts: { files: "polaris-apps.yml" },
            fix: { kind: "action", action: "republishRoutes" }
        });
        expect(edgeVerdict(null)).toMatchObject({ status: "unknown" });
    });

    it("gives up on work that runs past its deadline, or throws", async () => {
        vi.useFakeTimers();
        try {
            const late = within(new Promise(() => undefined), 1000);
            await vi.advanceTimersByTimeAsync(1001);
            await expect(late).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
        await expect(within(Promise.reject(new Error("boom")))).resolves.toBeNull();
        await expect(within(Promise.resolve(7))).resolves.toBe(7);
    });
});

describe("each check against its source", () => {
    it("database: answering, and not answering", async () => {
        expect(await runCheck("database")).toMatchObject({
            id: "database",
            status: "pass",
            code: "ok"
        });
        queryRaw.mockRejectedValueOnce(new Error("connection refused"));
        expect(await runCheck("database")).toMatchObject({ status: "fail", code: "unreachable" });
    });

    it("host agent: answering, silent, and the limited edition", async () => {
        expect(await runCheck("hostAgent")).toMatchObject({
            status: "pass",
            facts: { version: "1.4.0" }
        });
        health.mockRejectedValueOnce(new Error("socket closed"));
        expect(await runCheck("hostAgent")).toMatchObject({ status: "fail", code: "silent" });
        capabilities.mockReturnValue({ edition: "limited", hostd: { present: false } });
        expect(await runCheck("hostAgent")).toMatchObject({ status: "warn", code: "limited" });
        expect(health).toHaveBeenCalledTimes(2);
    });

    it("updates: current, behind, and unreachable", async () => {
        expect(await runCheck("updates")).toMatchObject({
            status: "pass",
            facts: { version: "2026.10.1" }
        });
        getUpdateStatus.mockResolvedValueOnce({
            upToDate: false,
            behindBy: 3,
            current: "2026.9.1"
        });
        expect(await runCheck("updates")).toMatchObject({
            status: "warn",
            code: "behind",
            facts: { behind: 3 },
            fix: { kind: "link", href: "/admin/settings" }
        });
        getUpdateStatus.mockResolvedValueOnce({ error: "rate limited" });
        expect(await runCheck("updates")).toMatchObject({ status: "unknown", code: "unreachable" });
    });

    it("disk: read from the local disk, and unreadable", async () => {
        expect(await runCheck("disk")).toMatchObject({ status: "pass", facts: { percent: 50 } });
        localDisk.mockRejectedValueOnce(new Error("statfs"));
        expect(await runCheck("disk")).toMatchObject({ status: "unknown", code: "unreadable" });
    });

    it("edge: an empty file in the real dynamic directory fails it", async () => {
        await writeFile(join(dynamic, "polaris-apps.yml"), "http: {}\n");
        expect(await runCheck("edge")).toMatchObject({ status: "pass", facts: { count: 1 } });
        await writeFile(join(dynamic, "polaris-apps.yml"), "");
        expect(await runCheck("edge")).toMatchObject({
            status: "fail",
            facts: { files: "polaris-apps.yml" }
        });
    });

    it("addresses: all up, some down, all down", async () => {
        const up = { host: "a.example.com", health: { state: "up" } };
        const down = { host: "b.example.com", health: { state: "down" } };
        checkedAddresses.mockResolvedValueOnce([up, up]);
        expect(await runCheck("addresses")).toMatchObject({ status: "pass", facts: { count: 2 } });
        checkedAddresses.mockResolvedValueOnce([up, down]);
        expect(await runCheck("addresses")).toMatchObject({
            status: "warn",
            code: "someDown",
            facts: { hosts: "b.example.com" }
        });
        checkedAddresses.mockResolvedValueOnce([down]);
        expect(await runCheck("addresses")).toMatchObject({ status: "fail", code: "allDown" });
    });

    it("certificate and DNS: not applicable without a public domain", async () => {
        expect(await runCheck("certificate")).toMatchObject({ status: "skip", code: "noDomain" });
        expect(await runCheck("dns")).toMatchObject({ status: "skip", code: "noDomain" });
        expect(lookup).not.toHaveBeenCalled();
    });

    it("DNS: a domain that resolves, and one that does not", async () => {
        polarisZoneHost.mockResolvedValue("polaris.example.com");
        expect(await runCheck("dns")).toMatchObject({
            status: "pass",
            facts: { host: "polaris.example.com", address: "203.0.113.7" }
        });
        lookup.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
        expect(await runCheck("dns")).toMatchObject({
            status: "fail",
            code: "unresolved",
            fix: { kind: "link", href: "/admin/domains" }
        });
    });

    it("never throws: every result carries its id and how long it took", async () => {
        localDisk.mockImplementationOnce(() => {
            throw new Error("synchronous");
        });
        const result = await runCheck("disk");
        expect(result.id).toBe("disk");
        expect(result.status).toBe("unknown");
        expect(result.ms).toBeGreaterThanOrEqual(0);
    });
});
