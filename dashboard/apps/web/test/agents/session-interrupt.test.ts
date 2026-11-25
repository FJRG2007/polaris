/**
 * Stop reaches the agent wherever its turn runs: the runner when it owns the
 * turn, Chat's session/cancel, or Ctrl+C typed into a terminal with no runner.
 * When none of them had a turn to stop, the person is told so instead of
 * seeing Stop succeed on nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    surface: "terminal" as "chat" | "terminal",
    commands: [] as string[],
    /** Exit code of the runner's interrupt command. */
    runnerCode: 0,
    cancel: vi.fn(async () => false),
    steer: vi.fn(async (_text: string) => true)
}));

vi.mock("@polaris/db", () => ({
    prisma: { agentSession: { update: vi.fn(), findUnique: vi.fn(async () => null) } }
}));
vi.mock("@/lib/agents/session-service", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/session-service")>(
        "@/lib/agents/session-service"
    );
    return {
        ...actual,
        sessionViewById: vi.fn(async () => null),
        sessionPlacement: vi.fn(async (id: string) => ({
            id,
            place: "local",
            hostId: null,
            containerId: "container-1",
            workdir: "/work",
            state: "running",
            cli: "claude",
            surface: mocks.surface
        }))
    };
});
vi.mock("@/lib/agents/acp/session-drivers", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/acp/session-drivers")>(
        "@/lib/agents/acp/session-drivers"
    );
    return { ...actual, acpDriver: () => ({ cancel: mocks.cancel, steer: mocks.steer, busy: false }), closeAcpDriver: vi.fn() };
});
vi.mock("@/lib/agents/session-ports", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/session-ports")>(
        "@/lib/agents/session-ports"
    );
    return {
        ...actual,
        withContainerPorts: async (_hostId: unknown, work: (ports: unknown) => unknown) =>
            work({
                runIn: async (_container: string, argv: string[]) => {
                    const command = argv.join(" ");
                    mocks.commands.push(command);
                    return { code: command.includes("/interrupted") ? mocks.runnerCode : 0, output: "" };
                }
            })
    };
});

const commands = await import("@/lib/agents/session-commands");
const { interruptSession, steerTurn } = await import("@/lib/agents/session-runtime");
const { SessionRefusal } = await import("@/lib/agents/session-service");

const typedEscape = () => mocks.commands.some((command) => command.includes(commands.interruptCommand()));

describe("interruptSession", () => {
    beforeEach(() => {
        mocks.commands.length = 0;
        mocks.runnerCode = 0;
        mocks.surface = "terminal";
        vi.clearAllMocks();
        mocks.cancel.mockResolvedValue(false);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("stops the runner's turn when the runner owns it, without typing into the terminal", async () => {
        await interruptSession("s-1");
        expect(mocks.commands.some((command) => command.includes("/interrupted"))).toBe(true);
        expect(typedEscape()).toBe(false);
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it("stops a runner-held turn of a Chat session after a fallback, beside Chat's cancel", async () => {
        mocks.surface = "chat";
        await interruptSession("s-2");
        expect(mocks.cancel).toHaveBeenCalledOnce();
        expect(mocks.commands.some((command) => command.includes("/interrupted"))).toBe(true);
        expect(typedEscape()).toBe(false);
    });

    it("takes Chat's cancel as the stop when the runner had no turn", async () => {
        mocks.surface = "chat";
        mocks.cancel.mockResolvedValue(true);
        mocks.runnerCode = commands.NOT_INTERRUPTED.noTurn;
        await expect(interruptSession("s-3")).resolves.toBeUndefined();
        expect(typedEscape()).toBe(false);
    });

    it("types the interrupt into a terminal with no runner", async () => {
        mocks.runnerCode = commands.NOT_QUEUED.interactive;
        await interruptSession("s-4");
        expect(typedEscape()).toBe(true);
    });

    it("says so when nothing had a turn to stop", async () => {
        mocks.surface = "chat";
        mocks.runnerCode = commands.NOT_INTERRUPTED.noTurn;
        await expect(interruptSession("s-5")).rejects.toBeInstanceOf(SessionRefusal);
        expect(typedEscape()).toBe(false);
    });

    it("says so when Chat's cancel fails and the runner had no turn", async () => {
        mocks.surface = "chat";
        mocks.cancel.mockRejectedValue(new Error("socket closed"));
        mocks.runnerCode = commands.NOT_INTERRUPTED.noTurn;
        await expect(interruptSession("s-6")).rejects.toBeInstanceOf(SessionRefusal);
    });
});

describe("steerTurn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("delivers a message into a Chat session's running turn", async () => {
        mocks.surface = "chat";
        mocks.steer.mockResolvedValue(true);
        await expect(steerTurn("s-7", "use the other file")).resolves.toBe(true);
        expect(mocks.steer).toHaveBeenCalledWith("use the other file");
    });

    it("leaves a terminal session's message to the queue", async () => {
        mocks.surface = "terminal";
        await expect(steerTurn("s-8", "x")).resolves.toBe(false);
        expect(mocks.steer).not.toHaveBeenCalled();
    });

    it("leaves it to the queue when the agent refuses the steer", async () => {
        mocks.surface = "chat";
        mocks.steer.mockRejectedValue(new Error("no active turn"));
        await expect(steerTurn("s-9", "x")).resolves.toBe(false);
    });
});
