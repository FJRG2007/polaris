/**
 * Rollouts are for platform admins only: every action asks for system.manage
 * before it reads or writes anything, and a refusal reaches the service never.
 * A container action on a server that is not answering is queued instead of lost.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "0192d3a4-5b6c-7d8e-9f00-112233445566";

let allowed = true;
const called: string[] = [];

class Redirect extends Error {}

vi.mock("@/lib/session", () => ({
    requirePermission: async (permission: string) => {
        called.push(`permission ${permission}`);
        if (!allowed) throw new Redirect("NEXT_REDIRECT");
        return { id: "admin" };
    }
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: { action: string }) => void called.push(`audit ${entry.action}`)
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/docker-service", () => ({
    HOST_DOCKER_PREFIX: "host:",
    LOCAL_DOCKER_CONNECTION_ID: "local",
    createDockerConnection: async () => ({}),
    deleteDockerConnection: async () => {}
}));
vi.mock("@/lib/container-service", () => ({
    withDockerDriver: async () => {
        throw new Error("connect ETIMEDOUT");
    }
}));
let offline = true;
vi.mock("@/lib/agent-rollouts/service", () => {
    class RolloutRefusal extends Error {
        constructor(public readonly code: string) {
            super(code);
        }
    }
    const record =
        (name: string) =>
        async (...args: unknown[]) => {
            called.push(name);
            return name === "rolloutScreen"
                ? { servers: [], rollout: null }
                : name === "enqueueCommand"
                  ? { status: "queued", args }
                  : { id: ID };
        };
    return {
        RolloutRefusal,
        rolloutScreen: record("rolloutScreen"),
        startRollout: record("startRollout"),
        resumeRollout: record("resumeRollout"),
        haltRollout: record("haltRollout"),
        rollbackRollout: async () => {
            called.push("rollbackRollout");
            throw new RolloutRefusal("noRollout");
        },
        setPin: record("setPin"),
        enqueueCommand: record("enqueueCommand"),
        cancelCommand: record("cancelCommand"),
        serverOfConnection: (id: string) => (id === "local" ? "local" : id.startsWith("host:") ? id.slice(5) : null),
        queueIfOffline: async (serverId: string, command: { kind: string; container: string }) => {
            called.push(`queueIfOffline ${serverId} ${command.kind} ${command.container}`);
            return offline;
        }
    };
});

const actions = await import("../../../src/app/(app)/apps/servers/rollouts/actions");
const containers = await import("../../../src/app/(app)/apps/containers/actions");

beforeEach(() => {
    allowed = true;
    offline = true;
    called.length = 0;
});

describe("rollout actions", () => {
    it("refuses a reader without system.manage before touching anything", async () => {
        allowed = false;
        const attempts = [
            actions.rolloutScreenAction(),
            actions.startRolloutAction({ version: "2.0.0", waves: [1, 100], healthMinutes: 10 }),
            actions.rolloutControlAction("halt"),
            actions.setPinAction({ serverId: "local", version: "1.0.0" }),
            actions.enqueueCommandAction({
                id: ID,
                serverId: "local",
                command: { kind: "container.restart", container: "api" }
            }),
            actions.cancelCommandAction(ID)
        ];
        for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(Redirect);
        expect(called.every((entry) => entry === "permission system.manage")).toBe(true);
    });

    it("validates input and turns a refusal into its code", async () => {
        expect(
            await actions.startRolloutAction({ version: "2.0.0", waves: [50, 10], healthMinutes: 10 })
        ).toEqual({ ok: false, error: "invalid" });
        expect(await actions.cancelCommandAction("not-an-id")).toEqual({ ok: false, error: "invalid" });
        expect(await actions.rolloutControlAction("rollback")).toEqual({ ok: false, error: "noRollout" });
        expect(called).not.toContain("audit agent.rollout.rollback");
        expect(await actions.rolloutControlAction("halt")).toEqual({ ok: true, value: undefined });
        expect(called).toContain("audit agent.rollout.halt");
    });
});

describe("a container action on a server that is not answering", () => {
    it("is queued for when the server is back", async () => {
        expect(await containers.containerAction(`host:${ID}`, "api", "restart")).toEqual({ queued: true });
        expect(called).toContain(`queueIfOffline ${ID} container.restart api`);
        expect(called).toContain("audit server.command.queue");
    });

    it("still fails when the server answers, or the connection is not one of Polaris's servers", async () => {
        offline = false;
        expect(await containers.containerAction(`host:${ID}`, "api", "stop")).toEqual({
            error: "connect ETIMEDOUT"
        });
        offline = true;
        called.length = 0;
        expect(await containers.containerAction("stored-connection", "api", "stop")).toEqual({
            error: "connect ETIMEDOUT"
        });
        expect(called.some((entry) => entry.startsWith("queueIfOffline"))).toBe(false);
    });
});
