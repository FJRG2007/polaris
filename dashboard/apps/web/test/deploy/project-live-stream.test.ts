/**
 * A redeploy or restart pressed on a Stream Deck went through the assistant's
 * tool and only reached an open project page at its next poll, up to 15 s
 * later. Every write to a deployment's or service's state is now heard where it
 * lands, resolved to its project, and pushed to that project's open pages - and
 * nobody else's - within a moment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Write = { model: string; operation: string; args: unknown };
type WriteListener = (write: Write) => void;

const state = vi.hoisted(() => ({
    hooks: new Map<string, Set<(write: { model: string; operation: string; args: unknown }) => void>>(),
    deployments: new Map<string, string>(),
    services: new Map<string, string>(),
    access: new Map<string, Set<string>>(),
    user: null as { id: string } | null,
    reads: 0
}));

vi.mock("@polaris/db", () => ({
    onModelWrite: (models: readonly string[], listener: WriteListener) => {
        for (const model of models) {
            const set = state.hooks.get(model) ?? new Set();
            set.add(listener);
            state.hooks.set(model, set);
        }
        return () => {
            for (const model of models) state.hooks.get(model)?.delete(listener);
        };
    },
    prisma: {
        deployment: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                state.reads += 1;
                return where.id.in
                    .filter((id) => state.deployments.has(id))
                    .map((id) => ({ deployableId: state.deployments.get(id)! }));
            }
        },
        application: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                state.reads += 1;
                return where.id.in
                    .filter((id) => state.services.has(id))
                    .map((id) => ({ environment: { projectId: state.services.get(id)! } }));
            }
        },
        managedDatabase: { findMany: async () => [] },
        environment: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/session", () => ({
    backgroundUser: async () => state.user,
    userHasManage: async () => true
}));

vi.mock("@/lib/deploy-project-access", () => ({
    projectAccess: async (projectId: string, userId: string) =>
        state.access.get(projectId)?.has(userId)
            ? { projectId, capabilities: ["project.read"] }
            : null,
    accessCan: (access: { capabilities: string[] }, capability: string) =>
        access.capabilities.includes(capability)
}));

import { deployServicesChanged } from "@/lib/deploy/live";
import { GET as stream } from "@/app/api/deploy/projects/stream/route";

const PROJECT = "0193a8f2-0000-7000-8000-000000000001";
const OTHER_PROJECT = "0193a8f2-0000-7000-8000-000000000002";

/** What the database hook hands the listeners after a write lands. */
function landed(model: string, operation: string, args: unknown): void {
    for (const listener of state.hooks.get(model) ?? []) listener({ model, operation, args });
}

/** Read frames off an open stream until `count` data frames arrived or the
 *  wait ran out. */
async function frames(response: Response, count: number, waitMs: number): Promise<string[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffer = "";
    const deadline = Date.now() + waitMs;
    while (seen.length < count && Date.now() < deadline) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))
        ]);
        if (!chunk || chunk.done) break;
        buffer += decoder.decode(chunk.value);
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) if (part.startsWith("data:")) seen.push(part);
    }
    return seen;
}

describe("an open project page follows a service changed anywhere else", () => {
    const aborts: AbortController[] = [];

    async function open(userId: string | null, projectId: string): Promise<Response> {
        state.user = userId ? { id: userId } : null;
        const abort = new AbortController();
        aborts.push(abort);
        return stream(
            new Request(`http://x/api/deploy/projects/stream?projectId=${projectId}`, {
                signal: abort.signal
            })
        );
    }

    beforeEach(() => {
        state.deployments = new Map([["dep-1", "app-1"]]);
        state.services = new Map([
            ["app-1", PROJECT],
            ["app-2", OTHER_PROJECT]
        ]);
        state.access = new Map([
            [PROJECT, new Set(["alice", "bob"])],
            [OTHER_PROJECT, new Set(["alice", "carol"])]
        ]);
        state.reads = 0;
    });

    afterEach(() => {
        for (const abort of aborts.splice(0)) abort.abort();
    });

    it("wakes the project's open pages within a second, and only theirs", async () => {
        const own = await open("alice", PROJECT);
        const shared = await open("bob", PROJECT);
        const other = await open("carol", OTHER_PROJECT);
        expect(own.status).toBe(200);
        expect(own.headers.get("content-type")).toContain("text/event-stream");

        const started = Date.now();
        // A deploy finishing: status by deployment id, then the service's pointer.
        landed("Deployment", "update", { where: { id: "dep-1" }, data: { status: "running" } });
        landed("Application", "update", {
            where: { id: "app-1" },
            data: { currentDeploymentId: "dep-1" }
        });

        const [ownFrames, sharedFrames, otherFrames] = await Promise.all([
            frames(own, 2, 800),
            frames(shared, 2, 800),
            frames(other, 1, 800)
        ]);
        // A burst is one frame, resolved in one pass - not a read per write or page.
        expect(ownFrames).toHaveLength(1);
        expect(sharedFrames).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(otherFrames).toHaveLength(0);
        expect(state.reads).toBe(2);
    });

    it("announces a restart, which writes nothing", async () => {
        const own = await open("alice", PROJECT);
        deployServicesChanged(["app-1"]);
        expect(await frames(own, 1, 800)).toHaveLength(1);
    });

    it("stays quiet for a write no card shows", async () => {
        const own = await open("alice", PROJECT);
        landed("Deployment", "update", { where: { id: "dep-1" }, data: { logPath: "x.log" } });
        landed("Application", "updateMany", {
            where: { id: "app-1" },
            data: { sourceConfig: "{}" }
        });
        expect(await frames(own, 1, 500)).toHaveLength(0);
        expect(state.reads).toBe(0);
    });

    it("reads nothing back while the write's own query is still running", async () => {
        // Inside a transaction the hook fires before the commit; resolving is
        // deferred, so nothing is read from the database in the same tick.
        const own = await open("alice", PROJECT);
        landed("Deployment", "update", { where: { id: "dep-1" }, data: { status: "failed" } });
        expect(state.reads).toBe(0);
        expect(await frames(own, 1, 800)).toHaveLength(1);
    });

    it("refuses a page to somebody without access to the project, or signed out", async () => {
        expect((await open("carol", PROJECT)).status).toBe(404);
        expect((await open(null, PROJECT)).status).toBe(401);
        expect((await open("alice", "not-a-project")).status).toBe(400);
    });

    it("lets the database hook go once the last page closes", async () => {
        await open("alice", PROJECT);
        expect(state.hooks.get("Deployment")?.size).toBe(1);
        for (const abort of aborts.splice(0)) abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(state.hooks.get("Deployment")?.size ?? 0).toBe(0);
    });
});
