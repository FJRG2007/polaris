/**
 * Restoring a point keeps exactly one new point (the present, so the restore can
 * be undone) however many records it rewrites, and gives back no hostname that
 * the dashboard or an installed app answers for now. The database, the DNS
 * zone and the cron writer are fakes.
 */

import { canonical } from "@/lib/restore-points/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "00000000-0000-7000-8000-0000000000aa";
const ACTOR = {
    id: "00000000-0000-7000-8000-0000000000bb",
    ownerId: "00000000-0000-7000-8000-0000000000bb"
};

const calls: { readonly name: string; readonly args: unknown }[] = [];
let point: { id: string; kind: string; objectKey: string; body: string; createdAt: Date } | null =
    null;
let statusDomains: string[] = [];

const prisma = new Proxy(
    {},
    {
        get: (_, model: string) =>
            new Proxy(
                {},
                {
                    get: (__, method: string) => async (args: unknown) => {
                        calls.push({ name: `${model}.${method}`, args });
                        if (model === "restorePoint" && method === "findUnique") return point;
                        if (model === "statusPage" && method === "findMany") {
                            return statusDomains.map((customDomain) => ({ customDomain }));
                        }
                        if (method === "findMany") return [];
                        return null;
                    }
                }
            )
    }
);

const zone = {
    zoneRecords: vi.fn(async () => ({
        records: [
            {
                id: "a".repeat(32),
                type: "A",
                name: "www",
                draft: { type: "A", name: "www", content: "192.0.2.1" }
            },
            {
                id: "b".repeat(32),
                type: "A",
                name: "old",
                draft: { type: "A", name: "old", content: "192.0.2.2" }
            }
        ]
    })),
    saveZoneRecord: vi.fn(async () => undefined),
    deleteZoneRecord: vi.fn(async () => undefined)
};
const saveServiceCron = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/dns/zone-records", () => zone);
vi.mock("@/lib/deploy/service-cron", () => ({ saveServiceCron }));
vi.mock("@/lib/domain-edge", () => ({ dashboardHosts: async () => ["polaris.example.test"] }));
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes: async () => undefined }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

const restorePoints = await import("@/lib/restore-points/service");

function storedPoint(kind: string, objectKey: string, items: Record<string, unknown>) {
    point = { id: "point-1", kind, objectKey, body: canonical({ items }), createdAt: new Date() };
}

const created = () => calls.filter((call) => call.name === "restorePoint.create");

beforeEach(() => {
    calls.length = 0;
    point = null;
    statusDomains = [];
    zone.saveZoneRecord.mockClear();
    zone.deleteZoneRecord.mockClear();
    saveServiceCron.mockClear();
});

describe("restoring a point", () => {
    it("keeps one point for a DNS zone, not one per record it rewrites", async () => {
        const key = restorePoints.restoreKeys.dns({ kind: "account" });
        storedPoint("dns", key, {
            "A www": { id: "a".repeat(32), type: "A", name: "www", content: "192.0.2.9" },
            "A new": { id: "c".repeat(32), type: "A", name: "new", content: "192.0.2.3" }
        });
        await restorePoints.restorePoint("point-1", { kind: "dns", objectKey: key }, ACTOR);
        expect(zone.deleteZoneRecord).toHaveBeenCalledWith(
            expect.anything(),
            "b".repeat(32),
            false
        );
        expect(zone.saveZoneRecord).toHaveBeenCalledTimes(2);
        for (const call of zone.saveZoneRecord.mock.calls as unknown[][])
            expect(call[3]).toBe(false);
        expect(created()).toHaveLength(1);
        expect((created()[0]?.args as { data: { reason: string } }).data.reason).toBe("restore");
    });

    it("keeps one point for a service's scheduled jobs", async () => {
        storedPoint("cron", APP, {
            one: {
                name: "one",
                schedule: "* * * * *",
                timezone: "UTC",
                command: "true",
                enabled: true
            },
            two: {
                name: "two",
                schedule: "0 * * * *",
                timezone: "UTC",
                command: "true",
                enabled: true
            }
        });
        await restorePoints.restorePoint("point-1", { kind: "cron", objectKey: APP }, ACTOR);
        expect(saveServiceCron).toHaveBeenCalledTimes(2);
        for (const call of saveServiceCron.mock.calls as unknown[][]) expect(call[3]).toBe(false);
    });

    it("leaves a hostname the dashboard or a status page answers for now", async () => {
        statusDomains = ["status.example.test"];
        storedPoint("routes", APP, {
            "app.example.test": { kind: "custom", targetPort: 80 },
            "polaris.example.test": { kind: "custom", targetPort: 80 },
            "status.example.test": { kind: "custom", targetPort: 80 }
        });
        await restorePoints.restorePoint("point-1", { kind: "routes", objectKey: APP }, ACTOR);
        const hostnames = calls
            .filter((call) => call.name === "domain.create")
            .map((call) => (call.args as { data: { hostname: string } }).data.hostname);
        expect(hostnames).toEqual(["app.example.test"]);
    });
});
