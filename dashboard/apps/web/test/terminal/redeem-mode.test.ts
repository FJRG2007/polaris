/**
 * What a redeemed ticket says it is for. The sidecar turns the mode into the
 * command it runs, so a mode lost on the way through is a different terminal:
 * an `agent` ticket read back as `terminal` opened a plain shell beside the
 * agent instead of attaching to the session it was running in.
 */

import { describe, expect, it, vi } from "vitest";

let row: Record<string, unknown> | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        deployTicket: {
            findUnique: async () => row,
            update: async () => undefined
        }
    }
}));
vi.mock("@/lib/host-service", () => ({ getHostConnection: async () => undefined }));
vi.mock("@/lib/docker-service", () => ({ resolveDockerTransport: async () => undefined }));

const { redeemTerminalTicket } = await import("../../src/lib/terminal-service");

function ticket(mode: string): Record<string, unknown> {
    return {
        id: "t1",
        targetId: "11111111-1111-4111-8111-111111111111",
        containerRef: "polaris-agent-1",
        mode,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000)
    };
}

describe("redeemTerminalTicket", () => {
    it("keeps an agent ticket an agent ticket", async () => {
        row = ticket("agent");
        expect((await redeemTerminalTicket("token"))?.mode).toBe("agent");
    });

    it("keeps a container terminal a container terminal", async () => {
        row = ticket("terminal");
        expect((await redeemTerminalTicket("token"))?.mode).toBe("terminal");
    });

    it("refuses a ticket already used", async () => {
        row = { ...ticket("agent"), usedAt: new Date() };
        expect(await redeemTerminalTicket("token")).toBeNull();
    });
});
