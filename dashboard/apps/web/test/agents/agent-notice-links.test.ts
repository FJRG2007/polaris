/**
 * Where a session's notice takes its owner.
 *
 * A task typed into Polar ended, and its notice opened the Agents app - a page
 * the person had never been to - instead of the conversation they started it
 * in. Polar now, for anybody who can use it; the Agents app for the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    polar: true,
    notify: vi.fn(async (_input: { href: string }) => undefined),
    updateMany: vi.fn(async (_input: unknown) => ({ count: 1 }))
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: vi.fn(async () => ({
                id: "5f0c1b8e-3d2a-4c6b-9e7f-0a1b2c3d4e5f",
                title: "Hola",
                startedById: "user-1",
                repo: null
            }))
        },
        notification: { updateMany: state.updateMany }
    }
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: state.notify, pushNotice: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => (key: string) => key }));
vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: state.polar, spend: false, web: false, connectors: false })
}));

const ID = "5f0c1b8e-3d2a-4c6b-9e7f-0a1b2c3d4e5f";

describe("a session's notice", () => {
    beforeEach(() => {
        state.notify.mockClear();
        state.updateMany.mockClear();
    });

    it("opens the session in Polar for somebody who can use Polar", async () => {
        state.polar = true;
        const notices = await import("@/lib/agents/agent-notices");
        await notices.noticeSessionEnded(ID, "exited");
        expect(state.notify.mock.calls[0]?.[0].href).toBe(`/polar?session=${ID}`);
    });

    it("opens Polar for everybody, since sessions have no other page", async () => {
        state.polar = false;
        const notices = await import("@/lib/agents/agent-notices");
        await notices.noticeSessionEnded(ID, "exited");
        expect(state.notify.mock.calls[0]?.[0].href).toBe(`/polar?session=${ID}`);
    });

    it("is found again under its Polar page when it is answered", async () => {
        const notices = await import("@/lib/agents/agent-notices");
        await notices.clearWorkKept(ID);
        expect(state.updateMany.mock.calls[0]?.[0]).toMatchObject({
            where: { href: `/polar?session=${ID}` }
        });
    });
});
