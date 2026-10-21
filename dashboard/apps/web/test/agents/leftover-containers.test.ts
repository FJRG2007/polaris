/**
 * Containers an agent session or a sign-in left running after it ended.
 *
 * What is pinned: a container whose session ended goes once the teardown that
 * ended it has had its time, one whose session is still live never does, one
 * with no row at all goes once it is old enough that its row cannot still be
 * on its way, and nothing outside the prefix is ever touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    sessions: [] as Record<string, unknown>[],
    listed: [] as Record<string, unknown>[],
    composeDown: vi.fn(async () => undefined),
    endContainerSession: vi.fn(async () => ({ kind: "pushed", commits: 1, branch: "polaris/x" }))
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: { findMany: async () => state.sessions },
        agentSigninAttempt: { findMany: async () => [] }
    }
}));
vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async dockerRequest(_method: string, path: string) {
            const listed = path.includes("polaris-session-") ? state.listed : [];
            return { status: 200, body: JSON.stringify(listed) };
        }
    }
}));
vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class {
        composeDown = state.composeDown;
    }
}));
vi.mock("@/lib/agents/session-work", () => ({ endContainerSession: state.endContainerSession }));

const { ENDED_GRACE_MS, leftoverProjects, reapLeftoverContainers } =
    await import("@/lib/agents/leftover-containers");

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const PREFIX = "polaris-session-";
const ID = "8ec470cd-9e5f-416a-b541-c58f99125041";
const OTHER = "01a0a00b-35c5-7932-861e-1b2161a9b298";

const container = (id: string, age = 30 * 86_400_000) => ({
    name: `${PREFIX}${id}`,
    project: `${PREFIX}${id}`,
    createdAt: ago(age)
});

describe("which containers are left over", () => {
    it("takes down one whose session was stopped weeks ago", () => {
        const ended = new Map([[ID, ago(26 * 86_400_000)]]);
        expect(leftoverProjects([container(ID)], PREFIX, ended, NOW)).toEqual([`${PREFIX}${ID}`]);
    });

    it("leaves one whose session is still running", () => {
        expect(leftoverProjects([container(ID)], PREFIX, new Map([[ID, null]]), NOW)).toEqual([]);
    });

    it("waits while the teardown that ended it may still be running", () => {
        const ended = new Map([[ID, ago(ENDED_GRACE_MS - 1000)]]);
        expect(leftoverProjects([container(ID)], PREFIX, ended, NOW)).toEqual([]);
    });

    it("takes down one with no row, but not before its row could still be written", () => {
        expect(leftoverProjects([container(OTHER)], PREFIX, new Map(), NOW)).toEqual([
            `${PREFIX}${OTHER}`
        ]);
        expect(leftoverProjects([container(OTHER, 1000)], PREFIX, new Map(), NOW)).toEqual([]);
    });

    it("never touches a container outside the prefix", () => {
        const stranger = {
            name: "polaris-web-589",
            project: "polaris",
            createdAt: ago(86_400_000)
        };
        expect(leftoverProjects([stranger], PREFIX, new Map(), NOW)).toEqual([]);
    });
});

describe("reaping a session that ended on its own", () => {
    beforeEach(() => {
        state.composeDown.mockClear();
        state.endContainerSession.mockClear();
        state.listed = [
            {
                Names: [`/${PREFIX}${ID}-agent-1`],
                Labels: { "com.docker.compose.project": `${PREFIX}${ID}` },
                Created: Math.floor(ago(86_400_000).getTime() / 1000)
            }
        ];
    });

    it("saves its work first instead of taking the container down blind", async () => {
        state.sessions = [
            { id: ID, state: "stopped", finishedAt: ago(86_400_000), workState: null, containerId: `${PREFIX}${ID}` }
        ];
        expect(await reapLeftoverContainers(NOW)).toBe(1);
        expect(state.endContainerSession).toHaveBeenCalledWith(ID);
        expect(state.composeDown).not.toHaveBeenCalled();
    });

    it("does not count one whose work had to be kept", async () => {
        state.sessions = [
            { id: ID, state: "failed", finishedAt: ago(86_400_000), workState: null, containerId: `${PREFIX}${ID}` }
        ];
        state.endContainerSession.mockResolvedValueOnce({ kind: "kept", commits: 2, branch: "polaris/x" } as never);
        expect(await reapLeftoverContainers(NOW)).toBe(0);
        expect(state.composeDown).not.toHaveBeenCalled();
    });

    it("takes down one whose work was already pushed without asking again", async () => {
        state.sessions = [
            { id: ID, state: "stopped", finishedAt: ago(86_400_000), workState: "pushed", containerId: `${PREFIX}${ID}` }
        ];
        expect(await reapLeftoverContainers(NOW)).toBe(1);
        expect(state.endContainerSession).not.toHaveBeenCalled();
        expect(state.composeDown).toHaveBeenCalledWith(`${PREFIX}${ID}`);
    });
});
