/**
 * A Codex installed before it had an app-server cannot hold Chat. The message
 * sent from Chat must not fail: the session goes back to its terminal, the
 * way it ran before Chat existed, and the same message is queued there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    surface: "chat" as "chat" | "terminal",
    commands: [] as string[],
    prompt: vi.fn(),
    closeAcpDriver: vi.fn(),
    update: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            update: mocks.update,
            findUnique: vi.fn(async () => ({ vendorSessionId: null }))
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
            cli: "codex",
            surface: mocks.surface
        }))
    };
});
vi.mock("@/lib/agents/acp/session-drivers", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/acp/session-drivers")>(
        "@/lib/agents/acp/session-drivers"
    );
    return {
        ...actual,
        acpDriver: () => ({ prompt: mocks.prompt }),
        closeAcpDriver: mocks.closeAcpDriver
    };
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

const { CodexAppServerMissing } = await import("@/lib/agents/codex/session-driver");
const commands = await import("@/lib/agents/session-commands");
const { promptSession } = await import("@/lib/agents/session-runtime");

describe("Codex without an app-server", () => {
    beforeEach(() => {
        mocks.surface = "chat";
        mocks.commands.length = 0;
        vi.clearAllMocks();
        mocks.update.mockImplementation(async ({ data }: { data: { surface?: "chat" | "terminal" } }) => {
            if (data.surface) mocks.surface = data.surface;
            return { id: "s-1" };
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("moves the session to its terminal and queues the message there", async () => {
        mocks.prompt.mockRejectedValue(new CodexAppServerMissing());
        await promptSession("s-1", "Fix the build");
        expect(mocks.prompt).toHaveBeenCalledOnce();
        expect(mocks.closeAcpDriver).toHaveBeenCalledWith("s-1");
        expect(mocks.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "s-1" }, data: { surface: "terminal" } })
        );
        expect(mocks.surface).toBe("terminal");
        const queue = commands.queuePromptCommand(`${commands.SESSION_ROOT}/polaris`, "Fix the build");
        expect(mocks.commands.some((command) => command.includes(queue))).toBe(true);
    });

    it("leaves any other failure to the caller, in Chat", async () => {
        mocks.prompt.mockRejectedValue(new Error("the agent went away"));
        await expect(promptSession("s-1", "Fix the build")).rejects.toThrow("the agent went away");
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.surface).toBe("chat");
    });
});
