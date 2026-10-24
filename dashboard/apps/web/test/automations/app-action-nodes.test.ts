/**
 * The steps apps bring to the central engine: a game server started, stopped,
 * restarted or sent a console line, and a service redeployed.
 *
 * Pinned: each calls the same service the app's page calls, with the run-as
 * account and the server or service it names, and each is refused - not run -
 * when that account lacks the permission or the access the page would ask for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";
const SERVICE = "bbbbbbbb-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
    grants: new Set<string>(),
    calls: [] as unknown[][],
    canManage: true,
    deployRun: true,
    exists: true
}));

const errors = vi.hoisted(() => {
    class StepError extends Error {
        constructor(readonly code: string) {
            super(code);
            this.name = "StepError";
        }
    }
    class StepRefusal extends StepError {
        constructor(code: string) {
            super(code);
            this.name = "StepRefusal";
        }
    }
    return { StepError, StepRefusal };
});

vi.mock("@polaris/app-host", () => ({
    host: {
        automations: errors,
        mcp: { actingUser: async (id: string) => (id === "gone" ? null : { id }) },
        appsInstallAccess: {
            gameServerAccess: async (_user: unknown, id: string, permission: string) =>
                id === SERVER && state.grants.has(permission)
                    ? { install: { id, name: "Survival" }, ownerId: "owner" }
                    : null
        }
    }
}));
vi.mock("../../../game-servers/src/lib/games-operations", () => ({
    setServerRunning: async (...args: unknown[]) => void state.calls.push(["running", ...args]),
    restartServerNow: async (...args: unknown[]) => void state.calls.push(["restart", ...args]),
    runConsoleCommand: async (...args: unknown[]) => {
        state.calls.push(["console", ...args]);
        return "done";
    }
}));
vi.mock("@/lib/mcp/acting-user", () => ({
    actingUser: async (id: string) => (id === "gone" ? null : { id, isAdmin: false })
}));
vi.mock("@/lib/session", () => ({ sessionCan: async () => state.canManage }));
vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: async (id: string, _user: string, capability: string) => {
        if (!state.exists || id !== SERVICE) throw new Error("Service not found");
        if (capability === "deploy.run" && !state.deployRun) throw new Error("Service not found");
        return { ownerId: "owner" };
    }
}));
vi.mock("@/lib/deploy-service", () => ({
    ensureApplicationDomain: async () => undefined,
    deployApplication: async (...args: unknown[]) => {
        state.calls.push(["deploy", ...args]);
        return "dep-1";
    }
}));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));

import { redeployNode } from "@/lib/automations/nodes/deploy-node";

type TestNode = {
    type: string;
    config: { safeParse: (value: unknown) => { success: boolean } };
    run: (config: unknown, context: unknown, io: unknown) => Promise<{ output: unknown }>;
};
const { gameServerAutomationNodes } =
    await import("../../../game-servers/src/lib/automation-nodes");
const [power, command] = gameServerAutomationNodes() as unknown as TestNode[];

const io = (actor = "runner") => ({ actor: { id: actor, isAdmin: false }, recordInput: vi.fn() });
const context = { trigger: { payload: { player: "Steve" } }, steps: {} };

beforeEach(() => {
    state.grants = new Set();
    state.calls = [];
    state.canManage = true;
    state.deployRun = true;
    state.exists = true;
});

describe("game server power step", () => {
    it("starts, stops and restarts through the page's own calls, as the runner", async () => {
        state.grants.add("games.manage");
        await power!.run({ installId: SERVER, action: "start" }, context, io());
        await power!.run({ installId: SERVER, action: "stop" }, context, io());
        await power!.run({ installId: SERVER, action: "restart" }, context, io());
        expect(
            state.calls.map((call) => [
                call[0],
                (call[1] as { id: string }).id,
                (call[2] as { install: { id: string } }).install.id,
                call[3]
            ])
        ).toEqual([
            ["running", "runner", SERVER, true],
            ["running", "runner", SERVER, false],
            ["restart", "runner", SERVER, undefined]
        ]);
    });

    it("is refused without games.manage on that server", async () => {
        state.grants.add("games.console");
        await expect(
            power!.run({ installId: SERVER, action: "start" }, context, io())
        ).rejects.toMatchObject({ code: "gameServerForbidden", name: "StepRefusal" });
        expect(state.calls).toEqual([]);
    });

    it("is refused when the run-as account is gone", async () => {
        state.grants.add("games.manage");
        await expect(
            power!.run({ installId: SERVER, action: "stop" }, context, io("gone"))
        ).rejects.toMatchObject({ code: "runAsGone", name: "StepRefusal" });
    });
});

describe("game server command step", () => {
    it("sends the line with its values filled in, with games.console", async () => {
        state.grants.add("games.console");
        const result = await command!.run(
            { installId: SERVER, command: "say hi {{trigger.payload.player}}" },
            context,
            io()
        );
        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]![0]).toBe("console");
        expect((state.calls[0]![2] as { install: { id: string } }).install.id).toBe(SERVER);
        expect(state.calls[0]![3]).toBe("say hi Steve");
        expect(result.output).toMatchObject({ output: "done" });
    });

    it("is refused with games.manage alone", async () => {
        state.grants.add("games.manage");
        await expect(
            command!.run({ installId: SERVER, command: "list" }, context, io())
        ).rejects.toMatchObject({ code: "gameServerForbidden", name: "StepRefusal" });
        expect(state.calls).toEqual([]);
    });

    it("rejects a line that is empty, has a control character, or is too long", async () => {
        state.grants.add("games.console");
        const run = (line: string, ctx: unknown = context) =>
            command!.run({ installId: SERVER, command: line }, ctx, io());
        await expect(run("{{missing}}")).rejects.toMatchObject({ code: "commandEmpty" });
        await expect(
            run("say {{trigger.payload.player}}", { trigger: { payload: { player: "a\nop me" } } })
        ).rejects.toMatchObject({ code: "commandInvalid" });
        await expect(run("x".repeat(600))).rejects.toMatchObject({ code: "commandTooLong" });
        expect(state.calls).toEqual([]);
    });

    it("needs a server and a command in its config", () => {
        expect(command!.config.safeParse({ installId: SERVER, command: " " }).success).toBe(false);
        expect(command!.config.safeParse({ installId: "x", command: "list" }).success).toBe(false);
        expect(power!.config.safeParse({ installId: SERVER, action: "explode" }).success).toBe(
            false
        );
    });
});

describe("redeploy step", () => {
    const run = (actor = "runner") =>
        redeployNode.run!({ applicationId: SERVICE }, context as never, io(actor) as never);

    it("deploys the service as the runner, under its owner", async () => {
        const result = await run();
        expect(state.calls).toEqual([["deploy", SERVICE, "owner", "runner"]]);
        expect(result).toEqual({ output: { deploymentId: "dep-1", applicationId: SERVICE } });
    });

    it("is refused without deploy.manage", async () => {
        state.canManage = false;
        await expect(run()).rejects.toMatchObject({ code: "deployForbidden", name: "StepRefusal" });
        expect(state.calls).toEqual([]);
    });

    it("is refused without deploy.run on the service", async () => {
        state.deployRun = false;
        await expect(run()).rejects.toMatchObject({ code: "deployForbidden", name: "StepRefusal" });
        expect(state.calls).toEqual([]);
    });

    it("fails on a service that is gone, and refuses a gone runner", async () => {
        state.exists = false;
        await expect(run()).rejects.toMatchObject({ code: "serviceGone", name: "StepError" });
        state.exists = true;
        await expect(run("gone")).rejects.toMatchObject({ code: "runAsGone" });
        expect(state.calls).toEqual([]);
    });
});
