/**
 * The rollout service against an in-memory database: commands wait for an
 * offline server and go out in order once it answers, a submit sent twice is
 * one command, the queue is bounded, a rollout walks its waves behind the
 * health gate, halts on a failure, resumes, and a rollback pins what it reached.
 */

import { fakeDb } from "./fake-db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HOST = "0192d3a4-5b6c-7d8e-9f00-112233445566";
const OWNER = "0192d3a4-0000-7000-8000-000000000001";

const state = {
    hostOnline: false,
    localOnline: true,
    localVersion: "1.0.0" as string | null,
    update: "started" as "started" | "unreachable" | "failed",
    calls: [] as string[]
};

vi.mock("@polaris/db", async () => ({ prisma: (await import("./fake-db")).fakeDb.prisma }));
vi.mock("@/lib/cron/lease", () => ({
    withLease: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work()
}));
vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async health() {
            return state.localOnline ? { version: state.localVersion } : null;
        }
    }
}));
vi.mock("@/lib/update-runner", () => ({
    startHostUpdate: async () => {
        state.calls.push("update");
        return state.update;
    }
}));
vi.mock("@/lib/local-server", () => ({ localMachineNameNow: () => "this-box" }));
vi.mock("@/lib/server-templates/service", () => ({
    fixAssignment: async () => ({ status: "compliant" })
}));
vi.mock("@/lib/local-machine", () => ({
    localMachineIdentity: async () => ({}),
    isLocalMachine: () => false
}));
function driver(online: () => boolean) {
    return {
        ping: async () => online(),
        restart: async (name: string) => void state.calls.push(`restart ${name}`),
        start: async (name: string) => void state.calls.push(`start ${name}`),
        stop: async (name: string) => void state.calls.push(`stop ${name}`),
        dispose: async () => {}
    };
}
vi.mock("@/lib/docker-service", () => ({
    hostDockerDriver: async () => driver(() => state.hostOnline),
    localDockerDriver: () => driver(() => state.localOnline)
}));

const service = await import("@/lib/agent-rollouts/service");

const minutes = (count: number) => new Date(Date.UTC(2026, 9, 16, 12, 0) + count * 60_000);
let ids = 0;
const uuid = () => `0192d3a4-5b6c-7d8e-9f00-${String(++ids).padStart(12, "0")}`;

function restart(container: string, serverId = HOST, expiry: "1h" | "1d" = "1d") {
    return { id: uuid(), serverId, expiry, command: { kind: "container.restart" as const, container } };
}

const commands = () => fakeDb.tables.serverCommand!;
const rollout = () => fakeDb.tables.agentRollout![0]!;
const targetOf = (serverId: string) =>
    fakeDb.tables.agentRolloutTarget!.find((row) => row.serverId === serverId)!;

beforeEach(() => {
    fakeDb.reset();
    fakeDb.tables.host!.push({ id: HOST, name: "web-1", ownerId: OWNER, createdAt: minutes(-100) });
    Object.assign(state, {
        hostOnline: false,
        localOnline: true,
        localVersion: "1.0.0",
        update: "started",
        calls: []
    });
});

describe("the command queue", () => {
    it("keeps commands for an offline server and delivers them in order once it answers", async () => {
        await service.enqueueCommand(restart("api"), OWNER, minutes(0));
        await service.enqueueCommand(restart("worker"), OWNER, minutes(1));
        await service.tick(minutes(2));
        expect(state.calls).toEqual([]);
        expect(commands().map((row) => row.status)).toEqual(["queued", "queued"]);

        state.hostOnline = true;
        await service.tick(minutes(3));
        expect(state.calls).toEqual(["restart api", "restart worker"]);
        expect(commands().map((row) => row.status)).toEqual(["done", "done"]);
        expect(fakeDb.tables.serverAgent!.find((row) => row.serverId === HOST)?.heartbeatAt).toEqual(minutes(3));
    });

    it("puts a command back, without letting the next one overtake it, when the server drops mid-way", async () => {
        await service.enqueueCommand(restart("api"), OWNER, minutes(0));
        await service.enqueueCommand(restart("worker"), OWNER, minutes(1));
        let pings = 0;
        state.hostOnline = true;
        // Answers the heartbeat, then goes away before the command.
        const docker = await import("@/lib/docker-service");
        vi.spyOn(docker, "hostDockerDriver").mockImplementation(async () =>
            driver(() => ++pings === 1) as never
        );
        await service.tick(minutes(2));
        vi.mocked(docker.hostDockerDriver).mockRestore();
        expect(state.calls).toEqual([]);
        expect(commands().map((row) => row.status)).toEqual(["queued", "queued"]);
    });

    it("expires a command that waited past its time instead of sending it late", async () => {
        await service.enqueueCommand(restart("api", HOST, "1h"), OWNER, minutes(0));
        await service.tick(minutes(61));
        expect(commands()[0]!.status).toBe("expired");
        state.hostOnline = true;
        await service.tick(minutes(62));
        expect(state.calls).toEqual([]);
    });

    it("is one command however many times the same id is submitted", async () => {
        const input = restart("api");
        const first = await service.enqueueCommand(input, OWNER);
        const again = await service.enqueueCommand(input, OWNER);
        expect(again.id).toBe(first.id);
        expect(commands()).toHaveLength(1);
        await expect(service.enqueueCommand({ ...input, serverId: "local" }, OWNER)).rejects.toMatchObject({
            code: "unknownServer"
        });
    });

    it("refuses a command past the per-server bound", async () => {
        for (let index = 0; index < 50; index++) await service.enqueueCommand(restart(`c${index}`), OWNER);
        await expect(service.enqueueCommand(restart("one-more"), OWNER)).rejects.toMatchObject({
            code: "queueFull"
        });
    });

    it("cancels a waiting command, and refuses one already sent", async () => {
        const waiting = await service.enqueueCommand(restart("api"), OWNER);
        await service.cancelCommand(waiting.id);
        expect(commands()[0]!.status).toBe("cancelled");
        state.hostOnline = true;
        await service.tick(minutes(1));
        expect(state.calls).toEqual([]);
        await expect(service.cancelCommand(waiting.id)).rejects.toMatchObject({ code: "notCancellable" });
    });

    it("refuses a server Polaris does not know", async () => {
        await expect(
            service.enqueueCommand(restart("api", "0192d3a4-5b6c-7d8e-9f00-ffffffffffff"), OWNER)
        ).rejects.toMatchObject({ code: "unknownServer" });
    });

    it("queues a sender's command only when the server is really not answering", async () => {
        const command = { kind: "container.stop" as const, container: "api" };
        expect(await service.queueIfOffline(HOST, command, OWNER)).toBe(true);
        state.hostOnline = true;
        expect(await service.queueIfOffline(HOST, command, OWNER)).toBe(false);
        expect(commands()).toHaveLength(1);
        expect(service.serverOfConnection(`host:${HOST}`)).toBe(HOST);
        expect(service.serverOfConnection("local")).toBe("local");
        expect(service.serverOfConnection("my-stored-connection")).toBeNull();
    });
});

describe("a rollout", () => {
    const start = (version = "2.0.0") =>
        service.startRollout({ version, waves: [1, 100], healthMinutes: 10 }, OWNER);

    it("updates the server with an agent, leaves out the one without, and finishes once healthy", async () => {
        await service.tick(minutes(0));
        await start();
        expect(targetOf("local")).toMatchObject({ wave: 0, state: "pending" });
        expect(targetOf(HOST)).toMatchObject({ wave: -1, state: "skipped", error: "no-agent" });

        await service.tick(minutes(1));
        expect(targetOf("local").state).toBe("updating");
        await service.tick(minutes(2));
        expect(state.calls).toEqual(["update"]);

        state.localVersion = "2.0.0";
        await service.tick(minutes(3));
        expect(targetOf("local").state).toBe("verifying");
        await service.tick(minutes(9));
        expect(rollout().status).toBe("running");
        await service.tick(minutes(14));
        expect(targetOf("local").state).toBe("healthy");
        expect(rollout()).toMatchObject({ status: "done", openKey: null });
    });

    it("halts when a server fails its update, and resumes by retrying it", async () => {
        await service.tick(minutes(0));
        await start();
        state.update = "failed";
        await service.tick(minutes(1));
        await service.tick(minutes(2));
        expect(targetOf("local")).toMatchObject({ state: "failed", error: "refused" });
        await service.tick(minutes(3));
        expect(rollout()).toMatchObject({ status: "halted", haltReason: "failed" });
        await expect(start("3.0.0")).rejects.toMatchObject({ code: "rolloutOpen" });

        await service.resumeRollout();
        expect(rollout().status).toBe("running");
        expect(targetOf("local").state).toBe("pending");
        await expect(service.resumeRollout()).rejects.toMatchObject({ code: "notHalted" });
    });

    it("halts a server that stops answering during its health check", async () => {
        await service.tick(minutes(0));
        await start();
        await service.tick(minutes(1));
        await service.tick(minutes(2));
        state.localVersion = "2.0.0";
        await service.tick(minutes(3));
        state.localOnline = false;
        await service.tick(minutes(7));
        expect(targetOf("local")).toMatchObject({ state: "failed", error: "heartbeat" });
        expect(rollout().status).toBe("halted");
    });

    it("rolls back: no further wave, waiting updates cancelled, reached servers pinned", async () => {
        await service.tick(minutes(0));
        await start();
        await service.tick(minutes(1));
        expect(commands().filter((row) => row.kind === "agent.update" && row.status === "queued")).toHaveLength(1);
        const result = await service.rollbackRollout();
        expect(result.pinned).toBe(1);
        expect(rollout()).toMatchObject({ status: "rolled-back", openKey: null });
        expect(commands().find((row) => row.kind === "agent.update")?.status).toBe("cancelled");
        expect(fakeDb.tables.serverAgent!.find((row) => row.serverId === "local")?.pinnedVersion).toBe("1.0.0");
        await expect(service.rollbackRollout()).rejects.toMatchObject({ code: "noRollout" });
    });

    it("leaves a pinned server out, and refuses a rollout that would reach nobody", async () => {
        await service.tick(minutes(0));
        await service.setPin("local", "1.0.0");
        await expect(start()).rejects.toMatchObject({ code: "noTargets" });
        await service.setPin("local", null);
        await start();
        expect(targetOf("local").state).toBe("pending");
    });

    it("draws the screen: versions, pins, waiting commands and the rollout", async () => {
        await service.tick(minutes(0));
        await service.enqueueCommand(restart("api"), OWNER, minutes(0));
        await start();
        const screen = await service.rolloutScreen(minutes(1));
        expect(screen.servers.map((server) => [server.id, server.version, server.online])).toEqual([
            ["local", "1.0.0", true],
            [HOST, null, false]
        ]);
        expect(screen.servers[1]!.waiting.map((row) => [row.kind, row.target, row.status])).toEqual([
            ["container.restart", "api", "queued"]
        ]);
        expect(screen.rollout).toMatchObject({ version: "2.0.0", status: "running", waves: [1, 100] });
    });
});
