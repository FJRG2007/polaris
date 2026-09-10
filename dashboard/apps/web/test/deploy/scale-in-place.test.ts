/**
 * A scale step that adds or removes copies of the release serving a service, in
 * that release's own project, leaves that release serving.
 *
 * The step runs through the ordinary deploy runner, so it has a log and a row in
 * the history. What must not happen is the ordinary ending: promoting the step's
 * own row would point the service at a project nothing runs in, and every
 * terminal, log and status after it would ask for containers that do not exist.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = await mkdtemp(join(tmpdir(), "polaris-scale-test-"));

const { row, promoted, update } = vi.hoisted(() => ({
    row: { status: "queued", replicas: 4, deployableType: "application", deployableId: "app-1" },
    promoted: vi.fn(),
    update: vi.fn(async () => ({}))
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: dataDir }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        deployment: {
            findFirst: vi.fn(async () => row),
            findUnique: vi.fn(async () => row),
            update,
            updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
                row.status = String(args.data.status ?? row.status);
                return { count: 1 };
            })
        },
        // Promotion moves the service's current release; a step in place never does.
        application: { findUnique: vi.fn(async () => promoted()), update: vi.fn(async () => promoted()) },
        domain: { deleteMany: vi.fn(async () => ({ count: 0 })) }
    }
}));
vi.mock("@/lib/notifications/deploy-events", () => ({ notifyDeployFinished: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
    getDriver: vi.fn(() => ({})),
    toTargetInfo: vi.fn(() => ({ id: "target-1", kind: "local", engine: "compose", proxyNetwork: "polaris" }))
}));

const { executeDeployment } = await import("@/lib/deploy-service");

const TARGET = { id: "target-1", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "polaris" };

beforeEach(() => {
    row.status = "queued";
    promoted.mockClear();
    update.mockClear();
});

describe("a scale step in the serving release's own project", () => {
    it("keeps that release current, with the step's count", async () => {
        const run = async () => ({ ok: true, imageTag: "polaris-release/shop:0123456789ab" });
        await executeDeployment("dep-step", TARGET as never, "owner-1", run, undefined, [], undefined, undefined, "dep-live");

        expect(promoted).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledWith({ where: { id: "dep-live" }, data: { replicas: 4 } });
        // The step's own row records it and never serves anything.
        expect(update).toHaveBeenCalledWith({ where: { id: "dep-step" }, data: { status: "removed", imageKept: false } });
    });
});
