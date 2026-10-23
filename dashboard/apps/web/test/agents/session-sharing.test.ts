/**
 * An agent session shared with somebody (`agents.session`): read through a
 * grant and only through one, and handed out only by whoever reaches it as
 * its owner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "0192f0aa-0000-7000-8000-0000000000a7";

const state = vi.hoisted(() => ({ held: "", owned: false, unique: 0 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findFirst: vi.fn(async () => (state.owned ? { id: "x" } : null)),
            findUnique: vi.fn(async () => {
                state.unique += 1;
                return null;
            })
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedCapability: vi.fn(async () => state.held),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn(), requireNote: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));
vi.mock("@/lib/agents/session-service", async () => ({
    getSession: vi.fn(async () => (state.owned ? { id: SESSION } : null)),
    sharedSession: (await vi.importActual<typeof import("@/lib/agents/session-service")>(
        "@/lib/agents/session-service"
    )).sharedSession
}));

const { sharedSession } = await import("@/lib/agents/session-service");
const { requireMayShare, subjectHref } = await import("@/lib/access/sharing-service");

type Sharer = Parameters<typeof requireMayShare>[0];

describe("a shared agent session", () => {
    beforeEach(() => {
        state.held = "";
        state.owned = false;
        state.unique = 0;
    });

    it("is not read at all without a grant", async () => {
        expect(await sharedSession(SESSION, "reader")).toBeNull();
        expect(state.unique).toBe(0);
        state.held = "view";
        await sharedSession(SESSION, "reader");
        expect(state.unique).toBe(1);
    });

    it("is handed out by whoever owns it and by nobody else", async () => {
        const as = { id: "u", isAdmin: false } as Sharer;
        await expect(requireMayShare(as, "agents.session", SESSION)).rejects.toThrow();
        state.owned = true;
        await expect(requireMayShare(as, "agents.session", SESSION)).resolves.toBeUndefined();
        expect(subjectHref("agents.session", SESSION)).toBe(`/apps/agents/sessions/${SESSION}`);
    });
});
