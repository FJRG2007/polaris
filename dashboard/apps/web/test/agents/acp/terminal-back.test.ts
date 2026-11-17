/**
 * A session the terminal took back from Chat on a key: the record follows the
 * mark the terminal left, and a launch that would stop the person's agent is
 * refused rather than run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const machine = vi.hoisted(() => ({
    surface: "chat" as "chat" | "terminal",
    markThere: false,
    down: false,
    launchCode: 0,
    commands: [] as string[],
    updates: [] as unknown[],
    closed: [] as string[],
    touched: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            update: vi.fn(async (args: { data: { surface: "chat" | "terminal" } }) => {
                machine.updates.push(args);
                machine.surface = args.data.surface;
                return { id: "s1" };
            }),
            findUnique: vi.fn(async () => null)
        }
    }
}));
vi.mock("@/lib/agents/session-service", () => ({
    sessionPlacement: vi.fn(async () => ({
        id: "s1",
        place: "local",
        hostId: null,
        containerId: "c1",
        workdir: "/workspace",
        state: "idle",
        cli: "claude",
        surface: machine.surface
    })),
    SessionRefusal: class SessionRefusal extends Error {}
}));
vi.mock("@/lib/agents/session-ports", () => ({
    containerState: vi.fn(),
    withContainerPorts: vi.fn(async (_host: unknown, work: (ports: unknown) => unknown) =>
        work({
            runIn: async (_container: string, argv: string[]) => {
                if (machine.down) throw new Error("unreachable");
                const command = argv.at(-1) ?? "";
                machine.commands.push(command);
                if (command.includes("new-window")) return { code: machine.launchCode, output: "" };
                if (command.includes("terminal-back")) return { code: 0, output: machine.markThere ? "back\n" : "" };
                return { code: 0, output: "" };
            }
        })
    )
}));
vi.mock("@/lib/agents/acp/session-drivers", () => ({
    acpDriver: vi.fn(),
    closeAcpDriver: (id: string) => machine.closed.push(id)
}));
vi.mock("@/lib/agents/session-live", () => ({ touchSession: (id: string) => machine.touched.push(id) }));
vi.mock("@/lib/agents/agent-readiness", () => ({ sessionCredentials: vi.fn(async () => []) }));

import { AcpRefusal } from "@/lib/agents/acp/session-driver";
import { sessionPlacement } from "@/lib/agents/session-service";
import { ACP_TERMINAL_BACK } from "@/lib/agents/acp/pipe-commands";
import { reconcileTerminalBack, startAcpAgent } from "@/lib/agents/session-runtime";

beforeEach(() => {
    Object.assign(machine, { surface: "chat", markThere: false, down: false, launchCode: 0, commands: [], updates: [], closed: [], touched: [] });
});

describe("reconcileTerminalBack", () => {
    it("records the session in Terminal once the terminal took it back, and wakes the page", async () => {
        machine.markThere = true;
        const placement = await reconcileTerminalBack("s1", await sessionPlacement("s1"));
        expect(placement?.surface).toBe("terminal");
        expect(machine.surface).toBe("terminal");
        expect(machine.closed).toEqual(["s1"]);
        expect(machine.touched).toEqual(["s1"]);
    });

    it("leaves a Chat session in Chat while the terminal has not taken it", async () => {
        const placement = await reconcileTerminalBack("s1", await sessionPlacement("s1"));
        expect(placement?.surface).toBe("chat");
        expect(machine.updates).toEqual([]);
        expect(machine.closed).toEqual([]);
    });

    it("asks the machine nothing for a session already in Terminal", async () => {
        machine.surface = "terminal";
        machine.markThere = true;
        await reconcileTerminalBack("s1", await sessionPlacement("s1"));
        expect(machine.commands).toEqual([]);
    });

    it("keeps the record as it was when the machine does not answer", async () => {
        machine.down = true;
        machine.markThere = true;
        const placement = await sessionPlacement("s1");
        expect((await reconcileTerminalBack("s1", placement))?.surface).toBe("chat");
        expect(machine.updates).toEqual([]);
    });
});

describe("startAcpAgent", () => {
    it("refuses, as a sentence for the person, a launch the terminal's mark stopped", async () => {
        machine.launchCode = ACP_TERMINAL_BACK;
        await expect(startAcpAgent("s1", ["agent"])).rejects.toBeInstanceOf(AcpRefusal);
    });

    it("takes the lock and checks the mark before it stops the terminal's agent", async () => {
        await startAcpAgent("s1", ["agent"]);
        const launch = machine.commands.find((command) => command.includes("new-window"))!;
        expect(launch.indexOf("agent.lock")).toBeLessThan(launch.indexOf("terminal-back"));
        expect(launch.indexOf("terminal-back")).toBeLessThan(launch.indexOf("kill -TERM"));
    });

    it("fails plainly on a machine that would not start it", async () => {
        machine.launchCode = 1;
        const failure = await startAcpAgent("s1", ["agent"]).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(AcpRefusal);
    });
});
