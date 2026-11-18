/**
 * A message from Polar Code to a session held in Chat goes through Chat
 * (`remoteTurn`), and a Chat that does not start hands the turn to the
 * terminal instead of failing it. A session held in its terminal is never
 * moved by that option: the message is queued for its runner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    surface: "chat" as "chat" | "terminal",
    commands: [] as string[],
    prompt: vi.fn(),
    update: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            update: mocks.update,
            findUnique: vi.fn(async () => ({ vendorSessionId: "vendor-1" }))
        }
    }
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
    return { ...actual, acpDriver: () => ({ prompt: mocks.prompt, busy: false }), closeAcpDriver: vi.fn() };
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
                    mocks.commands.push(argv.join(" "));
                    return { code: 0, output: "" };
                }
            })
    };
});

const commands = await import("@/lib/agents/session-commands");
const { promptSession } = await import("@/lib/agents/session-runtime");

const queued = (text: string) =>
    mocks.commands.some((command) =>
        command.includes(commands.queuePromptCommand(`${commands.SESSION_ROOT}/polaris`, text))
    );

describe("promptSession with chatFallback", () => {
    beforeEach(() => {
        mocks.commands.length = 0;
        vi.clearAllMocks();
        mocks.update.mockImplementation(async ({ data }: { data: { surface?: "chat" | "terminal" } }) => {
            if (data.surface) mocks.surface = data.surface;
            return { id: "s-1" };
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("sends a Chat-held session's message through Chat", async () => {
        mocks.surface = "chat";
        mocks.prompt.mockResolvedValue(undefined);
        await promptSession("s-1", "Fix the build", { chatFallback: true });
        expect(mocks.prompt).toHaveBeenCalledWith("Fix the build");
        expect(queued("Fix the build")).toBe(false);
    });

    it("hands the turn to the terminal when Chat does not start, instead of failing it", async () => {
        mocks.surface = "chat";
        mocks.prompt.mockRejectedValue(new Error("the agent went away"));
        await promptSession("s-2", "Fix the build", { chatFallback: true });
        expect(mocks.prompt).toHaveBeenCalledOnce();
        expect(mocks.surface).toBe("terminal");
        expect(queued("Fix the build")).toBe(true);
    });

    it("queues a Terminal-held session's message for its runner, never through Chat", async () => {
        mocks.surface = "terminal";
        await promptSession("s-3", "Fix the build", { chatFallback: true });
        expect(mocks.prompt).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(queued("Fix the build")).toBe(true);
    });
});
