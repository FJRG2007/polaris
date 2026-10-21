/**
 * An agent that needs somebody tells them, and a session's work is never
 * removed with its container.
 *
 * The database, the host daemon and the bell are all fakes here: what is under
 * test is which of them gets asked what, and in which order - one notice per
 * waiting episode, one per finished run, and a container taken down only once
 * its work is on GitHub or there was none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface SessionRow {
    id: string;
    title: string;
    startedById: string | null;
    state: string;
    place: string;
    containerId: string | null;
    workdir: string;
    branch: string;
    waitingNotifiedAt: Date | null;
    workState: string | null;
    workCommits: number | null;
    workBranch: string | null;
    workError: string | null;
    lastEventAt: Date | null;
    createdAt: Date;
    repo: { ownerId: string; repoFullName: string; push: string } | null;
}

const db = vi.hoisted(() => ({
    sessions: new Map<string, Record<string, unknown>>(),
    runs: new Map<string, Record<string, unknown>>(),
    notifications: [] as Record<string, unknown>[]
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, want] of Object.entries(where)) {
        const have = row[key];
        if (want === null) {
            if (have !== null && have !== undefined) return false;
        } else if (typeof want === "object" && want !== null && !(want instanceof Date)) {
            const rule = want as { not?: unknown; in?: unknown[]; notIn?: unknown[] };
            if ("not" in rule && rule.not === null && (have === null || have === undefined)) return false;
            if (rule.in && !rule.in.includes(have)) return false;
            if (rule.notIn && rule.notIn.includes(have)) return false;
        } else if (have !== want) return false;
    }
    return true;
}

vi.mock("@polaris/db", () => {
    const table = (rows: Map<string, Record<string, unknown>>) => ({
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
            const { OR: _or, createdAt: _created, ...rest } = where;
            return [...rows.values()].filter((row) => matches(row, rest));
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.get(where.id)!;
            Object.assign(row, data);
            return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const row of rows.values()) {
                if (!matches(row, where)) continue;
                Object.assign(row, data);
                count += 1;
            }
            return { count };
        }
    });
    return {
        prisma: {
            agentSession: table(db.sessions),
            agentRun: table(db.runs),
            agentSessionEvent: { createMany: async () => ({ count: 0 }) },
            notification: {
                updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                    let count = 0;
                    for (const row of db.notifications) {
                        if (row.type !== where.type || row.href !== where.href) continue;
                        if (where.userId && row.userId !== where.userId) continue;
                        Object.assign(row, data);
                        count += 1;
                    }
                    return { count };
                }
            },
            $transaction: async (calls: Promise<unknown>[]) => Promise.all(calls)
        }
    };
});

const notify = vi.hoisted(() =>
    vi.fn(async (input: Record<string, unknown>) => {
        db.notifications.push({ ...input, type: input.event, readAt: null });
        return { inapp: "sent" };
    })
);
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));

const daemon = vi.hoisted(() => ({
    runIn: vi.fn(async (_container: string, _argv: string[]) => ({ code: 0, output: "" })),
    writeFile: vi.fn(async () => undefined),
    composeDown: vi.fn(async () => undefined)
}));
vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class {
        runIn = daemon.runIn;
        writeFile = daemon.writeFile;
        composeDown = daemon.composeDown;
    }
}));
vi.mock("@/lib/github-service", () => ({
    githubAppInstallationToken: async () => "installation-token",
    cloneAuthHeader: (token: string | null) => (token ? `Authorization: Basic ${token}` : null),
    resolveGithubRepo: async () => ({ fullName: "acme/web", defaultBranch: "main", private: true })
}));
// What the runtime reaches for to start a session; nothing here starts one.
vi.mock("@polaris/ssh", () => ({ execCommand: vi.fn() }));
vi.mock("@/lib/connection-pool", () => ({ borrowSsh: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/host-service", () => ({ getHostConnectionUnscoped: vi.fn() }));
vi.mock("@/lib/agents/agent-readiness", () => ({ credentialsForAgent: () => ({}) }));
vi.mock("@/lib/agents/model-keys", () => ({ secretForAccount: vi.fn(), sessionSecretsFor: vi.fn() }));
vi.mock("@/lib/agents/agent-defaults-service", () => ({
    GENERAL_SCOPE: "general",
    getPlatformAgentDefaults: vi.fn(),
    scopeOf: vi.fn()
}));
vi.mock("@/lib/agents/agent-gate", () => ({ parseGateSteps: () => [] }));

const service = await import("@/lib/agents/session-service");
const runtime = await import("@/lib/agents/session-runtime");
const runs = await import("@/lib/agents/agent-run-service");
const work = await import("@/lib/agents/session-work");

function session(overrides: Partial<SessionRow> = {}): SessionRow {
    const row: SessionRow = {
        id: "s1",
        title: "Fix the login",
        startedById: "u1",
        state: "working",
        place: "local",
        containerId: "polaris-session-s1",
        workdir: "/session/repo",
        branch: "polaris/fix-login",
        waitingNotifiedAt: null,
        workState: null,
        workCommits: null,
        workBranch: null,
        workError: null,
        lastEventAt: new Date(),
        createdAt: new Date(),
        repo: { ownerId: "u1", repoFullName: "acme/web", push: "restricted" },
        ...overrides
    };
    db.sessions.set(row.id, row as unknown as Record<string, unknown>);
    return row;
}

const said = (output: string) => daemon.runIn.mockResolvedValueOnce({ code: 0, output });

beforeEach(() => {
    db.sessions.clear();
    db.runs.clear();
    db.notifications.length = 0;
    notify.mockClear();
    daemon.runIn.mockReset();
    daemon.runIn.mockResolvedValue({ code: 0, output: "" });
    daemon.writeFile.mockClear();
    daemon.composeDown.mockClear();
});

describe("an agent that needs you", () => {
    const ask = { kind: "permission" as const, detail: "Run npm test?", subject: "" };
    const work = { kind: "tool.start" as const, detail: "", subject: "" };

    it("tells the owner once per waiting episode, however often it asks", async () => {
        session();
        await service.recordSessionEvents("s1", [ask]);
        await service.recordSessionEvents("s1", [ask]);
        await service.recordSessionEvents("s1", [{ ...ask, kind: "question" }]);

        const waiting = notify.mock.calls.filter(([input]) => input.event === "agent.waiting");
        expect(waiting).toHaveLength(1);
        expect(waiting[0]![0]).toMatchObject({
            userId: "u1",
            href: "/apps/agents/sessions/s1",
            actionRequired: true
        });
    });

    it("answers the notice when the session moves on, and tells again next time", async () => {
        session();
        await service.recordSessionEvents("s1", [ask]);
        await service.recordSessionEvents("s1", [work]);

        expect(db.notifications[0]).toMatchObject({ actionRequired: false });
        expect(db.notifications[0]!.readAt).toBeInstanceOf(Date);
        expect(db.sessions.get("s1")!.waitingNotifiedAt).toBeNull();

        await service.recordSessionEvents("s1", [ask]);
        expect(notify.mock.calls.filter(([input]) => input.event === "agent.waiting")).toHaveLength(2);
    });

    it("marks the notice read when the page is opened, without a second notice", async () => {
        session();
        const notices = await import("@/lib/agents/agent-notices");
        await service.recordSessionEvents("s1", [ask]);
        await notices.readSessionWaiting("s1", "u1");
        expect(db.notifications[0]!.readAt).toBeInstanceOf(Date);
        await service.recordSessionEvents("s1", [ask]);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it("says when a session fails on its own, and only on the way in", async () => {
        session();
        await service.recordSessionEvents("s1", [{ kind: "error", detail: "boom", subject: "" }]);
        await service.recordSessionEvents("s1", [{ kind: "error", detail: "boom", subject: "" }]);
        const ended = notify.mock.calls.filter(([input]) => input.event === "agent.ended");
        expect(ended).toHaveLength(1);
        expect(ended[0]![0]).toMatchObject({ level: "danger", metadata: { reason: "failed" } });
    });
});

describe("a background run that finished", () => {
    function run(id: string) {
        db.runs.set(id, {
            id,
            state: "running",
            startedById: null,
            createdAt: new Date(0),
            repo: { ownerId: "owner", repoFullName: "acme/web" }
        });
    }

    it("tells the owner how it went, once, linked to the run", async () => {
        run("r1");
        run("r2");
        await runs.finishAgentRun("r1", { state: "succeeded" });
        await runs.finishAgentRun("r1", { state: "failed" });
        await runs.finishAgentRun("r2", { state: "failed", error: "x" });

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[0]![0]).toMatchObject({
            userId: "owner",
            event: "agent.run",
            level: "success",
            href: "/apps/agents/runs?run=r1"
        });
        expect(notify.mock.calls[1]![0]).toMatchObject({ level: "danger" });
    });

    it("says nothing about a run somebody cancelled", async () => {
        run("r1");
        await runs.finishAgentRun("r1", { state: "cancelled" });
        expect(notify).not.toHaveBeenCalled();
    });

    it("tells about each run the sweep closed out", async () => {
        run("r1");
        expect(await runs.sweepStaleRuns()).toBe(1);
        expect(notify.mock.calls[0]![0]).toMatchObject({ event: "agent.run", level: "danger" });
    });
});

describe("stopping a session never loses its work", () => {
    it("removes a clean container and pushes nothing", async () => {
        session();
        said("polaris-work: clean 0 polaris/fix-login");
        const outcome = await runtime.stopSession("s1");

        expect(outcome).toEqual({ kind: "clean", branch: "polaris/fix-login" });
        expect(daemon.composeDown).toHaveBeenCalledWith("polaris-session-s1");
        expect(db.sessions.get("s1")).toMatchObject({ state: "stopped", workState: "clean" });
    });

    it("commits and pushes dirty work, then removes the container", async () => {
        session();
        said("polaris-work: pushed 3 polaris/fix-login");
        const outcome = await runtime.stopSession("s1");

        expect(outcome).toEqual({ kind: "pushed", commits: 3, branch: "polaris/fix-login" });
        // The credential went in as a file, never on the command line.
        expect(daemon.writeFile).toHaveBeenCalledTimes(1);
        const script = daemon.runIn.mock.calls[0]![1].join(" ");
        expect(script).not.toContain("installation-token");
        expect(script).not.toContain("--force");
        expect(daemon.composeDown).toHaveBeenCalledTimes(1);
        expect(db.sessions.get("s1")).toMatchObject({
            workState: "pushed",
            workCommits: 3,
            workBranch: "polaris/fix-login"
        });
    });

    it("keeps the container and tells the owner when the push fails", async () => {
        session();
        said("! [rejected] HEAD -> polaris/fix-login (fetch first)\npolaris-work: rejected 2 polaris/fix-login");
        const outcome = await runtime.stopSession("s1");

        expect(outcome).toMatchObject({ kind: "kept", commits: 2, reason: "rejected" });
        expect(daemon.composeDown).not.toHaveBeenCalled();
        expect(db.sessions.get("s1")).toMatchObject({ workState: "kept", workError: "rejected" });
        const kept = notify.mock.calls.filter(([input]) => input.event === "agent.work");
        expect(kept).toHaveLength(1);
        expect(kept[0]![0]).toMatchObject({ actionRequired: true, href: "/apps/agents/sessions/s1" });
    });

    it("keeps the container when the machine cannot be asked at all", async () => {
        session();
        daemon.runIn.mockRejectedValueOnce(new Error("socket closed"));
        const outcome = await runtime.stopSession("s1");
        expect(outcome).toMatchObject({ kind: "kept", reason: "unreachable" });
        expect(daemon.composeDown).not.toHaveBeenCalled();
    });

    it("pushes on retry and then removes the container, answering the notice", async () => {
        session();
        said("polaris-work: rejected 1 polaris/fix-login");
        await runtime.stopSession("s1");
        said("polaris-work: pushed 1 polaris/fix-login");
        const outcome = await work.endContainerSession("s1");
        expect(outcome.kind).toBe("pushed");
        expect(daemon.composeDown).toHaveBeenCalledTimes(1);
        expect(db.notifications.find((row) => row.type === "agent.work")).toMatchObject({
            actionRequired: false
        });
    });

    it("removes the container when kept work is discarded", async () => {
        session({ state: "stopped", workState: "kept", workError: "rejected" });
        await work.discardSessionWork("s1");
        expect(daemon.composeDown).toHaveBeenCalledWith("polaris-session-s1");
        expect(db.sessions.get("s1")).toMatchObject({ workState: "discarded" });
    });

    it("leaves a session on somebody's own server alone", async () => {
        session({ place: "host", containerId: null, hostId: "h1" } as Partial<SessionRow>);
        daemon.runIn.mockClear();
        expect(await work.saveSessionWork("s1")).toEqual({ kind: "none" });
    });
});

describe("the sweep of silent sessions", () => {
    it("takes the same path as Stop: push first, keep on failure", async () => {
        session({ id: "s1", lastEventAt: new Date(0) });
        session({ id: "s2", containerId: "polaris-session-s2", lastEventAt: new Date(0) });
        said("polaris-work: pushed 1 polaris/fix-login");
        said("polaris-work: noauth 4 polaris/fix-login");

        expect(await runtime.sweepSilentSessions(1)).toBe(2);

        expect(daemon.composeDown).toHaveBeenCalledTimes(1);
        expect(daemon.composeDown).toHaveBeenCalledWith("polaris-session-s1");
        expect(db.sessions.get("s1")).toMatchObject({ state: "failed", workState: "pushed" });
        expect(db.sessions.get("s2")).toMatchObject({ state: "failed", workState: "kept", workError: "auth" });
        const events = notify.mock.calls.map(([input]) => input.event);
        expect(events.filter((event) => event === "agent.ended")).toHaveLength(2);
        expect(events.filter((event) => event === "agent.work")).toHaveLength(1);
    });
});
