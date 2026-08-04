/**
 * That cancelling a deploy stops the deploy, and not merely the record of it.
 *
 * This is the half that is easy to get wrong and impossible to see from the UI: a
 * cancel that writes "cancelled" and leaves the build running looks identical to one
 * that worked, right up until the image lands and the release is promoted over the
 * top of whatever the operator kept.
 *
 * The abort is the mechanism. The ports a deploy runs through are built around it, and
 * both backends end the command when their connection goes - the local daemon kills
 * the child it was streaming from, a remote server does what an interrupted ssh does.
 * So what is asserted here is that the signal handed to the ports is the one a cancel
 * trips, and that a run which comes back after that is never promoted.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = await mkdtemp(join(tmpdir(), "polaris-deploy-test-"));

let row: { status: string } | null = { status: "queued" };
const updates: { where: unknown; data: Record<string, unknown> }[] = [];
const promoted = vi.fn();
/** The signal the runner handed to the ports for this deploy. */
let handedSignal: AbortSignal | undefined;

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: dataDir }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        deployment: {
            findFirst: vi.fn(async () => row),
            findUnique: vi.fn(async () => row),
            update: vi.fn(async () => ({})),
            updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
                updates.push(args);
                // Mirror the real conditional write: a settled row is never rewritten.
                const status = String(args.data.status ?? "");
                if (row && ["cancelled", "failed", "running"].includes(row.status)) return { count: 0 };
                if (row) row.status = status;
                return { count: 1 };
            })
        },
        // Promotion is what a cancel must never reach; if it does, this records it.
        application: { findUnique: vi.fn(async () => promoted()), update: vi.fn(async () => promoted()) },
        domain: { deleteMany: vi.fn(async () => ({ count: 0 })) }
    }
}));
vi.mock("@/lib/notifications/deploy-events", () => ({ notifyDeployFinished: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: vi.fn(async (_target: unknown, _ownerId: string, signal?: AbortSignal) => {
        handedSignal = signal;
        return { dispose: vi.fn(async () => undefined) };
    }),
    getDriver: vi.fn(() => ({})),
    toTargetInfo: vi.fn(() => ({ id: "target-1", kind: "local", engine: "compose", proxyNetwork: "polaris" }))
}));

const { cancelDeployment, executeDeployment } = await import("@/lib/deploy-service");

const TARGET = { id: "target-1", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "polaris" };

beforeEach(() => {
    row = { status: "queued" };
    updates.length = 0;
    promoted.mockClear();
    handedSignal = undefined;
});

describe("cancelling a deploy that is running", () => {
    it("trips the signal the work is running under", async () => {
        // The run resolves only once it is aborted - which is what a real one does when
        // the connection it is streaming over is destroyed under it.
        const aborted = new Promise<void>((resolve) => {
            void executeDeployment("dep-1", TARGET as never, "owner-1", async (ctx) => {
                void ctx;
                await new Promise<void>((stop) => handedSignal?.addEventListener("abort", () => stop(), { once: true }));
                resolve();
                return { ok: true, imageTag: "img:1" };
            });
        });

        // Wait for the runner to have handed the ports their signal before cancelling.
        while (!handedSignal) await new Promise((resolve) => setTimeout(resolve, 5));
        await cancelDeployment("dep-1", "owner-1");
        await aborted;

        expect(handedSignal?.aborted).toBe(true);
    });

    it("never promotes a release whose run finished after the cancel", async () => {
        // The race that matters: work between two steps can come back with a verdict
        // nobody is waiting for. Publishing it would put a release the operator stopped
        // in front of traffic.
        let release: (() => void) | null = null;
        const finished = executeDeployment("dep-2", TARGET as never, "owner-1", async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return { ok: true, imageTag: "img:2" };
        });

        while (!handedSignal) await new Promise((resolve) => setTimeout(resolve, 5));
        await cancelDeployment("dep-2", "owner-1");
        (release as unknown as () => void)();
        await finished;

        expect(promoted).not.toHaveBeenCalled();
        expect(updates.some((update) => update.data.status === "running")).toBe(false);
        expect(updates.some((update) => update.data.status === "cancelled")).toBe(true);
    });

    it("does not start a deploy that was cancelled while it waited its turn", async () => {
        // The queue is FIFO per target, so a deploy can be cancelled before anything has
        // happened. Starting it then would ignore the operator outright.
        row = { status: "cancelled" };
        const run = vi.fn(async () => ({ ok: true }));
        await executeDeployment("dep-3", TARGET as never, "owner-1", run);
        expect(run).not.toHaveBeenCalled();
    });
});
