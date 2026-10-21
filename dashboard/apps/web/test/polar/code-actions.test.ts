/**
 * Polar's Code side reads through the Agents app's own actions, and only after
 * it knows this account may: those actions send somebody without the
 * permission to another page, which a panel beside some other screen must not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";

const state = {
    held: new Set<string>(),
    listed: 0,
    limit: undefined as number | undefined,
    page: undefined as unknown,
    rows: null as unknown[] | null,
    detailed: 0
};

const session = {
    id: SESSION,
    title: "Fix the login form",
    repoFullName: "acme/web",
    branch: "polaris/fix-the-login-form",
    state: "working",
    lastEventAt: "2026-10-20T10:00:02.000Z",
    createdAt: "2026-10-20T10:00:00.000Z",
    error: null as string | null
};

const USER = { id: "u1", isAdmin: false } as never;

vi.mock("@/lib/session", () => ({
    userHasManage: async (_user: unknown, permission: string) => state.held.has(permission)
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => `t:${key}`
}));
vi.mock("@/app/(app)/apps/agents/sessions/actions", () => ({
    listSessionsAction: async (limit?: number, page?: unknown) => {
        state.listed += 1;
        state.limit = limit;
        state.page = page;
        return (
            state.rows ?? [
                session,
                {
                    ...session,
                    id: "s2",
                    title: "Review the API",
                    state: "stopped",
                    repoFullName: "",
                    createdAt: "2026-10-19T10:00:00.000Z"
                }
            ]
        );
    },
    sessionChoicesAction: async () => ({
        agents: [],
        repos: [],
        hosts: [],
        sharedWorkspace: false
    }),
    startSessionAction: async () => ({ id: "started" }),
    promptSessionAction: async () => ({}),
    sessionDetailAction: async () => {
        state.detailed += 1;
        return {
            session,
            messages: [
                { role: "user", body: "Fix it", authorId: "u1", at: "2026-10-20T10:00:01.000Z" }
            ],
            events: [
                { kind: "tool.start", detail: "", subject: "Edit", at: "2026-10-20T10:00:03.000Z" },
                { kind: "session.start", detail: "", subject: "", at: "2026-10-20T10:00:00.500Z" },
                { kind: "made.up", detail: "", subject: "", at: "2026-10-20T10:00:04.000Z" }
            ]
        };
    }
}));

const { polarCodeOverview, polarCodeStart, polarCodeThread } = await import("@/lib/polar/code");

beforeEach(() => {
    state.held = new Set();
    state.listed = 0;
    state.detailed = 0;
    state.rows = null;
    state.page = undefined;
});

/** A session `minutes` after the first, on the same repository. */
function at(index: number, title = `Task ${index}`) {
    const minute = String(index).padStart(2, "0");
    return {
        ...session,
        id: `00000000-0000-4000-8000-0000000000${minute}`,
        title,
        createdAt: `2026-10-20T10:${minute}:00.000Z`
    };
}

describe("polarCodeOverview", () => {
    it("answers none and asks Agents nothing for an account without it", async () => {
        expect(await polarCodeOverview(USER)).toEqual({
            access: "none",
            sessions: [],
            next: null
        });
        expect(state.listed).toBe(0);
    });

    it("lists the sessions, labelled, for somebody who can read them", async () => {
        state.held.add("agents.read");
        const overview = await polarCodeOverview(USER);
        expect(overview.access).toBe("read");
        expect(overview.sessions).toHaveLength(2);
        expect(overview.sessions[0]).toMatchObject({
            id: SESSION,
            repo: "acme/web",
            live: true,
            stateLabel: "t:labels.sessionState.working"
        });
        expect(overview.sessions[1]).toMatchObject({ live: false, repo: "" });
        expect(overview.next).toBeNull();
    });

    it("asks for this person's own sessions only, a page and one more", async () => {
        state.held.add("agents.read");
        await polarCodeOverview(USER);
        expect(state.page).toEqual({ mine: true });
        expect(state.limit).toBe(21);
    });

    it("lists a task started again once, by its newest session", async () => {
        state.held.add("agents.read");
        // Newest first, as the Agents list answers.
        state.rows = [at(3, "Fix the login form"), at(2, "Other"), at(1, " fix the  login form ")];
        const overview = await polarCodeOverview(USER);
        expect(overview.sessions.map((row) => row.id)).toEqual([at(3).id, at(2).id]);
    });

    it("says where the next page starts, from the last session read", async () => {
        state.held.add("agents.read");
        // 21 rows: a full page and one more. The page's last two are the same task.
        state.rows = Array.from({ length: 21 }, (_, index) =>
            at(40 - index, index >= 18 ? "Same task" : `Task ${index}`)
        );
        const first = await polarCodeOverview(USER);
        expect(first.sessions).toHaveLength(19);
        expect(first.next).toBe(at(21).id);
        await polarCodeOverview(USER, first.next);
        expect(state.page).toEqual({ mine: true, after: at(21).id });
    });

    it("says manage for somebody who can start sessions", async () => {
        state.held.add("agents.manage");
        expect((await polarCodeOverview(USER)).access).toBe("manage");
    });
});

describe("polarCodeThread", () => {
    it("is null and asks Agents nothing without the permission", async () => {
        expect(await polarCodeThread(USER, SESSION)).toBeNull();
        expect(state.detailed).toBe(0);
    });

    it("merges messages and events in time order, in the reader's words", async () => {
        state.held.add("agents.read");
        const thread = await polarCodeThread(USER, SESSION);
        expect(thread?.entries.map((entry) => entry.text)).toEqual([
            "t:session.events.sessionStart",
            "Fix it",
            "t:session.events.toolStart",
            // An event this build has no words for shows as itself.
            "made.up"
        ]);
        // A tool line with no detail names the tool.
        expect(thread?.entries[2]?.detail).toBe("Edit");
        expect(thread?.error).toBeNull();
    });
});

describe("polarCodeStart", () => {
    it("refuses, in words, somebody who can only read sessions", async () => {
        state.held.add("agents.read");
        expect(await polarCodeStart(USER, {})).toEqual({ error: "t:code.noAccess" });
    });

    it("hands the body to the Agents start action for somebody who can manage", async () => {
        state.held.add("agents.manage");
        expect(await polarCodeStart(USER, {})).toEqual({ id: "started" });
    });
});
