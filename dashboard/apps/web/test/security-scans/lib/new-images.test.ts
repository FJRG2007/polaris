/**
 * A new release is scanned on its own, once per image a day, and its serious
 * findings ring the bell once per advisory and package on that server - not on
 * every rescan. The database is an in-memory stand-in holding just the rows
 * these paths read and write; the scanner returns the fixture report.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { shortHash } from "@polaris/deploy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "grype-node-image.json"), "utf8");
const IMAGE = "registry.example.test/fixture-app:1.0.0";
const TARGET = { id: "target-1", ownerId: "owner-1", kind: "local", hostId: null };

interface Scan {
    id: string;
    targetId: string;
    kind: string;
    label: string;
    input: string;
    requestedById: string | null;
    state: string;
    createdAt: Date;
}

const db = vi.hoisted(() => ({
    scans: [] as Scan[],
    alerts: [] as { targetId: string; key: string }[],
    deployments: [] as {
        targetId: string;
        deployableId: string;
        imageTag: string | null;
        createdAt: Date;
    }[],
    apps: [] as { id: string; targetId: string; name: string }[],
    installs: [] as { applicationId: string; catalogId: string }[],
    containers: [] as unknown[],
    queueFails: new Set<string>()
}));

const notified = vi.hoisted(() => [] as { userId: string; title: string }[]);

vi.mock("@polaris/db", () => {
    let next = 0;
    const newest = <T extends { createdAt: Date }>(rows: T[]) =>
        [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const scanMatches = (row: Scan, where: Record<string, any> = {}) =>
        (where.id === undefined || row.id === where.id) &&
        (where.targetId === undefined || row.targetId === where.targetId) &&
        (where.kind === undefined || row.kind === where.kind) &&
        (where.state === undefined ||
            (typeof where.state === "string"
                ? row.state === where.state
                : where.state.in.includes(row.state))) &&
        (where.createdAt?.gt === undefined || row.createdAt > where.createdAt.gt) &&
        (where.input?.contains === undefined || row.input.includes(where.input.contains));
    const securityScan = {
        create: async ({ data }: { data: Omit<Scan, "id" | "state" | "createdAt"> }) => {
            const row = {
                ...data,
                id: (++next).toString(16).padStart(24, "0"),
                state: "queued",
                createdAt: new Date()
            };
            db.scans.push(row);
            return { id: row.id };
        },
        findMany: async ({ where }: { where?: Record<string, any> } = {}) =>
            db.scans.filter((row) => scanMatches(row, where)),
        findFirst: async ({ where }: { where?: Record<string, any> }) =>
            db.scans.find((row) => scanMatches(row, where)) ?? null,
        findUnique: async ({ where }: { where: { id: string } }) =>
            db.scans.find((row) => row.id === where.id) ?? null,
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({
            ...db.scans.find((row) => row.id === where.id)!,
            target: TARGET
        }),
        updateMany: async ({ where, data }: { where: Record<string, any>; data: any }) => {
            if (where.startedAt) return { count: 0 };
            const rows = db.scans.filter((row) => scanMatches(row, where));
            for (const row of rows) Object.assign(row, data);
            return { count: rows.length };
        },
        update: async ({ where, data }: { where: { id: string }; data: any }) =>
            Object.assign(
                db.scans.find((row) => row.id === where.id)!,
                data
            ),
        deleteMany: async () => ({ count: 0 }),
        groupBy: async () => [],
        count: async () => 0
    };
    const prisma = {
        securityScan,
        securitySetting: { findMany: async () => [] },
        securityQuarantine: { deleteMany: async () => ({ count: 0 }) },
        securityFinding: { createMany: async () => ({ count: 0 }) },
        securityAlert: {
            findMany: async ({ where }: { where: { targetId: string; key: { in: string[] } } }) =>
                db.alerts.filter(
                    (row) => row.targetId === where.targetId && where.key.in.includes(row.key)
                ),
            createMany: async ({ data }: { data: { targetId: string; key: string }[] }) => {
                let count = 0;
                for (const row of data) {
                    if (db.alerts.some((a) => a.targetId === row.targetId && a.key === row.key))
                        continue;
                    db.alerts.push(row);
                    count += 1;
                }
                return { count };
            }
        },
        deployment: {
            findMany: async ({ where }: { where: { createdAt: { gt: Date } } }) =>
                newest(db.deployments.filter((row) => row.createdAt > where.createdAt.gt)),
            findFirst: async ({ where }: { where: { deployableId: string } }) =>
                newest(
                    db.deployments.filter((row) => row.deployableId === where.deployableId)
                )[0] ?? null
        },
        application: {
            findFirst: async ({ where }: { where: { id: string; targetId: string } }) =>
                db.queueFails.has(where.id)
                    ? null
                    : (db.apps.find((a) => a.id === where.id && a.targetId === where.targetId) ??
                      null),
            findMany: async ({ where }: { where: { id?: { in: string[] }; targetId?: string } }) =>
                db.apps
                    .filter(
                        (a) =>
                            (where.id === undefined || where.id.in.includes(a.id)) &&
                            (where.targetId === undefined || a.targetId === where.targetId)
                    )
                    .map((a) => ({ id: a.id, name: a.name, environment: null }))
        },
        // The server listing pass is left out: these are the release path's scans.
        deployTarget: {
            findUnique: async () => TARGET,
            findMany: async () => []
        },
        installedApp: {
            findMany: async ({ where }: { where: { applicationId: { in: string[] } } }) =>
                db.installs.filter((row) => where.applicationId.in.includes(row.applicationId))
        },
        $transaction: (ops: Promise<unknown>[]) => Promise.all(ops)
    };
    return { prisma };
});

vi.mock("@polaris/app-host", () => ({
    host: {
        appsCatalog: {
            findApp: (id: string) =>
                id === "camera-hub" ? { id, name: "Camera relay", ownedBy: "home" } : undefined
        },
        i18nLocaleService: { getUserLocale: async () => "en-US" },
        notificationsDispatch: {
            notify: async (input: { userId: string; title: string }) => {
                notified.push({ userId: input.userId, title: input.title });
            }
        }
    }
}));

vi.mock("@polaris-app/security-scans/src/lib/runner", () => ({
    exportImage: async () => undefined,
    listExports: async () => [],
    listContainers: async () => db.containers,
    portsFor: async () => ({}),
    removeExport: async () => undefined,
    runHostAction: async () => ({ exitCode: 0, output: "" }),
    runOneShot: async () => ({ exitCode: 0, log: FIXTURE }),
    ScanFailure: class ScanFailure extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    },
    TIMEOUT_MS: 60 * 60_000
}));

const { tick, queueImage } = await import("@polaris-app/security-scans/src/lib/service");

let clock = Date.parse("2026-10-01T00:00:00Z");

/** One job pass, eleven minutes after the last, so the release check is due. */
async function pass() {
    clock += 11 * 60_000;
    vi.setSystemTime(clock);
    await tick();
}

const settled = () =>
    vi.waitFor(() => expect(db.scans.every((s) => s.state === "done")).toBe(true));

function release(deployableId: string, imageTag: string, ageMs = 60_000) {
    db.apps.push({ id: deployableId, targetId: TARGET.id, name: `app ${deployableId}` });
    db.deployments.push({
        targetId: TARGET.id,
        deployableId,
        imageTag,
        createdAt: new Date(clock - ageMs)
    });
}

describe("new releases are scanned on their own", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        db.scans.length = 0;
        db.alerts.length = 0;
        db.deployments.length = 0;
        db.apps.length = 0;
        db.installs.length = 0;
        db.containers.length = 0;
        db.queueFails.clear();
        notified.length = 0;
    });
    afterEach(() => vi.useRealTimers());

    it("queues one scan for a new image and not again while it was scanned today", async () => {
        release("app-1", IMAGE);
        await pass();
        await settled();
        expect(db.scans).toHaveLength(1);
        expect(JSON.parse(db.scans[0]!.input)).toEqual({ applicationId: "app-1", image: IMAGE });
        await pass();
        await pass();
        expect(db.scans).toHaveLength(1);
    });

    it("scans a part of Polaris as one of Polaris's own images", async () => {
        const relay = "polaris-release/fixture-relay:1.0.0";
        const imageId = `sha256:${"a".repeat(64)}`;
        release("relay-1", relay);
        db.installs.push({ applicationId: "relay-1", catalogId: "camera-hub" });
        db.containers.push({
            name: "fixture-relay",
            ref: relay,
            imageId,
            project: `polaris-${shortHash("relay-1", 8)}`,
            labels: {}
        });
        await pass();
        await settled();
        expect(db.scans).toHaveLength(1);
        expect(db.scans[0]).toMatchObject({ source: "polaris", imageId, label: relay });
        expect(JSON.parse(db.scans[0]!.input)).toMatchObject({
            applicationIds: ["relay-1"],
            part: "relay-1"
        });
        await pass();
        expect(db.scans).toHaveLength(1);
    });

    it("scans a part's release image, not the port forwarder beside it, and only once", async () => {
        const relay = "polaris-release/fixture-relay:1.0.0";
        const imageId = `sha256:${"a".repeat(64)}`;
        const project = `polaris-${shortHash("relay-1", 8)}`;
        release("relay-1", relay);
        db.installs.push({ applicationId: "relay-1", catalogId: "camera-hub" });
        // Listed first: the images are sorted by ref and this one sorts ahead.
        db.containers.push(
            {
                name: "fixture-relay-p80",
                ref: "alpine/socat:1.8.1.3",
                imageId: `sha256:${"b".repeat(64)}`,
                project,
                labels: {}
            },
            { name: "fixture-relay", ref: relay, imageId, project, labels: {} }
        );
        await pass();
        await settled();
        expect(db.scans).toHaveLength(1);
        expect(db.scans[0]).toMatchObject({ imageId, label: relay });
        await pass();
        await pass();
        expect(db.scans).toHaveLength(1);
    });

    it("finds a part's release under the ref the engine spells out, or one it shares", async () => {
        const project = `polaris-${shortHash("relay-1", 8)}`;
        const imageId = `sha256:${"a".repeat(64)}`;
        release("relay-1", "fixture-relay");
        db.installs.push({ applicationId: "relay-1", catalogId: "camera-hub" });
        db.containers.push(
            {
                name: "fixture-relay-p80",
                ref: "alpine/socat:1.8.1.3",
                imageId: `sha256:${"b".repeat(64)}`,
                project,
                labels: {}
            },
            { name: "fixture-other", ref: "aaa/fixture-alias:1", imageId, project: null, labels: {} },
            {
                name: "fixture-relay",
                ref: "docker.io/library/fixture-relay:latest",
                imageId,
                project,
                labels: {}
            }
        );
        await pass();
        await settled();
        expect(db.scans).toHaveLength(1);
        expect(db.scans[0]).toMatchObject({ imageId });
        expect(JSON.parse(db.scans[0]!.input)).toMatchObject({ release: "fixture-relay" });
        await pass();
        await pass();
        expect(db.scans).toHaveLength(1);
    });

    it("never scans a part's port forwarder when none of its images is the release", async () => {
        const project = `polaris-${shortHash("relay-1", 8)}`;
        release("relay-1", "polaris-release/fixture-relay:2.0.0");
        db.installs.push({ applicationId: "relay-1", catalogId: "camera-hub" });
        db.containers.push(
            {
                name: "fixture-relay-p80",
                ref: "alpine/socat:1.8.1.3",
                imageId: `sha256:${"b".repeat(64)}`,
                project,
                labels: {}
            },
            {
                name: "fixture-relay",
                ref: "polaris-release/fixture-relay:1.0.0",
                imageId: `sha256:${"a".repeat(64)}`,
                project,
                labels: {}
            }
        );
        await pass();
        await settled();
        expect(db.scans).toHaveLength(0);
    });

    it("never files a part of Polaris as an app while its container is not up yet", async () => {
        release("relay-1", "polaris-release/fixture-relay:1.0.0");
        db.installs.push({ applicationId: "relay-1", catalogId: "camera-hub" });
        await pass();
        await settled();
        expect(db.scans).toHaveLength(0);
    });

    it("looks for releases at most every ten minutes", async () => {
        await pass();
        release("app-1", IMAGE);
        vi.setSystemTime(clock + 60_000);
        await tick();
        expect(db.scans).toHaveLength(0);
        await pass();
        expect(db.scans).toHaveLength(1);
    });

    it("scans a release that replaced the image scanned before", async () => {
        release("app-1", IMAGE);
        await pass();
        await settled();
        release("app-1", "registry.example.test/fixture-app:1.0.1", 0);
        await pass();
        await settled();
        expect(db.scans.map((s) => JSON.parse(s.input).image)).toEqual([
            IMAGE,
            "registry.example.test/fixture-app:1.0.1"
        ]);
    });

    it("does not let releases that cannot be queued use up the pass", async () => {
        for (let i = 0; i < 12; i++) {
            release(`gone-${i}`, `registry.example.test/gone-${i}:1`, 1_000);
            db.queueFails.add(`gone-${i}`);
        }
        release("app-1", IMAGE, 120_000);
        await pass();
        expect(db.scans.map((s) => JSON.parse(s.input).applicationId)).toEqual(["app-1"]);
    });
});

describe("serious findings ring the bell once", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        db.scans.length = 0;
        db.alerts.length = 0;
        db.deployments.length = 0;
        db.apps.length = 0;
        db.installs.length = 0;
        db.containers.length = 0;
        db.queueFails.clear();
        notified.length = 0;
    });
    afterEach(() => vi.useRealTimers());

    it("tells the owner and who asked about the critical and high findings", async () => {
        release("app-1", IMAGE);
        await queueImage(TARGET.id, "app-1", "asker-1");
        await settled();
        expect(db.alerts.map((a) => a.key).sort()).toEqual([
            "CVE-2026-111497|node",
            "CVE-2099-0001|libexample"
        ]);
        expect(notified.map((n) => n.userId).sort()).toEqual(["asker-1", "owner-1"]);
        expect(notified[0]!.title).toBe("2 new serious vulnerabilities in app app-1");
    });

    it("stays quiet when a rescan finds the same ones", async () => {
        release("app-1", IMAGE);
        await queueImage(TARGET.id, "app-1", null);
        await settled();
        expect(notified).toHaveLength(1);
        await queueImage(TARGET.id, "app-1", null);
        await settled();
        expect(db.scans).toHaveLength(2);
        expect(notified).toHaveLength(1);
        expect(db.alerts).toHaveLength(2);
    });
});
