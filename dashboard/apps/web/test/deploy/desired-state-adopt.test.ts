/**
 * The pass that halts services recorded as stopped, and what it may no longer do
 * in silence.
 *
 * On 2026-10-03 it halted a Minecraft server that was healthy and had a player on:
 * Polaris's own crash-loop guard had stopped the server earlier, which recorded it
 * as stopped, and the server had since been repaired and brought up. The pass
 * cannot tell that from a stop that half-failed - so it asks the app first, and
 * whatever it does stop is written down where the owner reads it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const APP = "33333333-3333-4333-8333-333333333333";

let adopts = false;
let running: string[] = [];
let stopped: string[] = [];
let lines: Array<{ action: string; userId: string | null }> = [];
let audits: Array<{ action: string; actorId: string | null; metadata?: unknown }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findMany: async () => [
                {
                    id: APP,
                    slug: "offgrid",
                    target: {
                        id: "target-1",
                        kind: "local",
                        hostId: null,
                        runtime: "compose",
                        proxyNetwork: null
                    },
                    environment: { project: { slug: "marketplace", ownerId: OWNER } }
                }
            ]
        }
    }
}));

vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: async () => ({
        listContainers: async () => running,
        container: async (name: string) => {
            stopped.push(name);
        },
        dispose: async () => undefined
    })
}));

vi.mock("@/lib/app-extensions/registry", () => ({
    adoptsRunningService: async (ownerId: string, applicationId: string) =>
        adopts && ownerId === OWNER && applicationId === APP
}));

vi.mock("@/lib/activity/activity", () => ({
    record: async (entry: { action: string; userId: string | null }) => {
        lines.push(entry);
    }
}));

vi.mock("@/lib/deploy-audit", () => ({
    recordDeployAudit: async (event: {
        action: string;
        actorId: string | null;
        metadata?: unknown;
    }) => {
        audits.push(event);
    }
}));

const { runDesiredStatePass } = await import("@/lib/deploy/desired-state");

beforeEach(() => {
    adopts = false;
    running = ["marketplace-offgrid-ad8d"];
    stopped = [];
    lines = [];
    audits = [];
});

describe("a container running under a stopped service", () => {
    it("is left alone when its app takes the service back as running", async () => {
        adopts = true;
        const pass = await runDesiredStatePass();
        expect(pass).toMatchObject({ checked: 1, stopped: 0, adopted: 1 });
        expect(stopped).toEqual([]);
        expect(lines).toEqual([
            { subjectType: "app", subjectId: APP, userId: null, action: "resumed" }
        ]);
    });

    it("is stopped otherwise - and the service's history and the audit log say so", async () => {
        const pass = await runDesiredStatePass();
        expect(pass).toMatchObject({ stopped: 1, adopted: 0 });
        expect(stopped).toEqual(["marketplace-offgrid-ad8d"]);
        expect(lines.map((line) => [line.action, line.userId])).toEqual([
            ["stopped-unasked", null]
        ]);
        expect(audits).toEqual([
            {
                actorId: null,
                action: "deploy.app.stop-unasked",
                targetType: "application",
                targetId: APP,
                metadata: { containers: ["marketplace-offgrid-ad8d"] }
            }
        ]);
    });

    it("asks nobody and writes nothing when nothing is running", async () => {
        running = [];
        adopts = true;
        const pass = await runDesiredStatePass();
        expect(pass).toMatchObject({ stopped: 0, adopted: 0 });
        expect(lines).toEqual([]);
        expect(audits).toEqual([]);
    });
});
