/**
 * Ingesting a session's transcript: a read claimed once per few seconds, rows
 * stored once per transcript line however often they are read, a prompt typed
 * in Polaris linked to its transcript line rather than shown twice, the cursor
 * kept, and the action behind the page open only to who may read the session.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";

interface Message {
    id: string;
    sessionId: string;
    role: string;
    kind: string;
    subject: string;
    ref: string;
    body: string;
    authorId: string | null;
    vendorId: string | null;
    createdAt: Date;
}

const db = vi.hoisted(() => ({
    session: null as null | Record<string, unknown>,
    messages: [] as Message[],
    seq: 0,
    owned: true,
    shared: false,
    virtual: "/root/.claude/projects/-session-repo/6f1c.jsonl",
    real: ""
}));

vi.mock("@polaris/db", () => {
    const matchesSession = (
        row: Record<string, unknown>,
        where: Record<string, unknown>
    ): boolean => {
        if (where.id !== row.id) return false;
        if ("transcriptFile" in where && where.transcriptFile !== row.transcriptFile) return false;
        if ("transcriptOffset" in where && where.transcriptOffset !== row.transcriptOffset)
            return false;
        if (Array.isArray(where.OR)) {
            const at = row.transcriptSyncedAt as Date | null;
            return where.OR.some((one: Record<string, unknown>) =>
                one.transcriptSyncedAt === null
                    ? at === null
                    : at !== null && at < (one.transcriptSyncedAt as { lt: Date }).lt
            );
        }
        return true;
    };
    return {
        prisma: {
            agentSession: {
                findUnique: vi.fn(async () => (db.session ? { ...db.session } : null)),
                updateMany: vi.fn(
                    async ({
                        where,
                        data
                    }: {
                        where: Record<string, unknown>;
                        data: Record<string, unknown>;
                    }) => {
                        if (!db.session || !matchesSession(db.session, where)) return { count: 0 };
                        Object.assign(db.session, data);
                        return { count: 1 };
                    }
                )
            },
            agentSessionMessage: {
                findMany: vi.fn(
                    async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
                        let rows = db.messages.filter((one) => one.sessionId === where.sessionId);
                        const vendor = where.vendorId as { in?: string[] } | null | undefined;
                        if (vendor && "in" in vendor)
                            rows = rows.filter((one) => vendor.in!.includes(one.vendorId ?? ""));
                        if (vendor === null) rows = rows.filter((one) => one.vendorId === null);
                        if (where.role) rows = rows.filter((one) => one.role === where.role);
                        if (where.authorId) rows = rows.filter((one) => one.authorId !== null);
                        rows = [...rows].sort(
                            (a, b) =>
                                b.createdAt.getTime() - a.createdAt.getTime() ||
                                (a.id < b.id ? 1 : -1)
                        );
                        return rows.slice(0, take ?? rows.length);
                    }
                ),
                findFirst: vi.fn(async () => null),
                updateMany: vi.fn(
                    async ({
                        where,
                        data
                    }: {
                        where: { id: string };
                        data: { vendorId: string; createdAt?: Date };
                    }) => {
                        const row = db.messages.find(
                            (one) => one.id === where.id && one.vendorId === null
                        );
                        if (!row) return { count: 0 };
                        if (
                            db.messages.some(
                                (one) =>
                                    one.sessionId === row.sessionId &&
                                    one.vendorId === data.vendorId
                            )
                        )
                            throw new Error("unique violation");
                        row.vendorId = data.vendorId;
                        if (data.createdAt) row.createdAt = data.createdAt;
                        return { count: 1 };
                    }
                ),
                createMany: vi.fn(
                    async ({ data }: { data: Omit<Message, "id" | "authorId">[] }) => {
                        let count = 0;
                        for (const one of data) {
                            if (
                                db.messages.some(
                                    (m) =>
                                        m.sessionId === one.sessionId && m.vendorId === one.vendorId
                                )
                            )
                                continue;
                            db.messages.push({
                                ...one,
                                authorId: null,
                                id: `m-${String(++db.seq).padStart(4, "0")}`
                            });
                            count++;
                        }
                        return { count };
                    }
                )
            }
        }
    };
});
vi.mock("@/lib/agents/session-runtime", () => ({
    // The session's machine: the transcript path it reports is a POSIX one, and
    // here it is a throwaway file wherever this machine keeps them.
    runInSession: vi.fn(async (_id: string, script: string) => ({
        code: 0,
        output: execFileSync("sh", ["-c", script.split(db.virtual).join(db.real)], {
            encoding: "utf8"
        })
    }))
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/github-service", () => ({}));
vi.mock("@/lib/github-access", () => ({
    credentialFor: vi.fn(),
    githubCredentialsForUser: vi.fn(async () => [])
}));
vi.mock("@/lib/github-app-reach", () => ({
    githubInstallGapForRepo: vi.fn(),
    installGapMessage: vi.fn()
}));
vi.mock("@/lib/agents/session-work", () => ({ saveSessionWork: vi.fn() }));
vi.mock("@/lib/agents/session-review", () => ({}));
vi.mock("@/lib/agents/repo-options", () => ({}));
vi.mock("@/lib/tasks/access", () => ({}));
vi.mock("@/lib/tasks/task-detail-service", () => ({ addComment: vi.fn() }));
vi.mock("@/lib/agents/agent-readiness", () => ({
    agentChoicesFor: vi.fn(),
    agentOptionsFor: vi.fn()
}));
vi.mock("@/lib/agents/session-capacity", () => ({}));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));
vi.mock("@/lib/agents/words", () => ({ agentText: vi.fn(), knownAgentText: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async () => ({ id: "viewer" })),
    sessionCan: vi.fn(async () => true)
}));
vi.mock("@/lib/agents/session-service", () => ({
    getSession: vi.fn(async () => (db.owned ? { id: "s-1" } : null)),
    sharedSession: vi.fn(async () => (db.shared ? { id: "s-1" } : null))
}));

import { sessionHistoryAction } from "@/components/agents/sessions/actions";
import {
    MAX_ROWS_PER_SYNC,
    SYNC_DEBOUNCE_MS,
    historyPage,
    syncSessionHistory,
    syncSessionHistorySoon
} from "@/lib/agents/session-history";

const SESSION = "0196f0a0-0000-7000-8000-000000000001";

function transcript(): string {
    const dir = join(
        mkdtempSync(join(tmpdir(), "polaris-history-")),
        ".claude",
        "projects",
        "-session-repo"
    );
    mkdirSync(dir, { recursive: true });
    return join(dir, "6f1c.jsonl").replace(/\\/g, "/");
}

const user = (uuid: string, text: string, timestamp?: string) =>
    JSON.stringify({
        type: "user",
        uuid,
        timestamp,
        isSidechain: false,
        message: { role: "user", content: text }
    });
const reply = (uuid: string, text: string, timestamp?: string) =>
    JSON.stringify({
        type: "assistant",
        uuid,
        timestamp,
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text }] }
    });

let path = "";
beforeEach(() => {
    path = transcript();
    db.real = path;
    db.messages = [];
    db.seq = 0;
    db.owned = true;
    db.shared = false;
    db.session = {
        id: SESSION,
        cli: "claude",
        state: "idle",
        transcriptPath: db.virtual,
        transcriptFile: null,
        transcriptOffset: null,
        transcriptSyncedAt: null
    };
});

const later = (ms: number) => new Date(Date.now() + ms);

describe("syncSessionHistory", () => {
    it("stores each line once, however many times it is read, and keeps the cursor", async () => {
        writeFileSync(path, `${user("u-1", "fix the login bug")}\n${reply("a-1", "On it.")}\n`);
        expect(await syncSessionHistory(SESSION, { now: later(0) })).toBe("synced");
        expect(db.messages.map((one) => [one.role, one.body])).toEqual([
            ["user", "fix the login bug"],
            ["agent", "On it."]
        ]);
        const size = Buffer.byteLength(
            `${user("u-1", "fix the login bug")}\n${reply("a-1", "On it.")}\n`
        );
        expect(db.session!.transcriptOffset).toBe(BigInt(size));
        expect(db.session!.transcriptFile).toBe(db.virtual);

        // Read again from the start - a replaced file, a lost cursor - and
        // nothing is stored twice.
        db.session!.transcriptOffset = 0n;
        expect(await syncSessionHistory(SESSION, { now: later(SYNC_DEBOUNCE_MS + 1) })).toBe(
            "synced"
        );
        expect(db.messages).toHaveLength(2);

        appendFileSync(path, `${reply("a-2", "Done.")}\n`);
        await syncSessionHistory(SESSION, { now: later(2 * SYNC_DEBOUNCE_MS + 2) });
        expect(db.messages.map((one) => one.body)).toEqual([
            "fix the login bug",
            "On it.",
            "Done."
        ]);
    });

    it("is one read per few seconds however many ask", async () => {
        writeFileSync(path, `${user("u-1", "hello")}\n`);
        const now = later(0);
        expect(await syncSessionHistory(SESSION, { now })).toBe("synced");
        appendFileSync(path, `${reply("a-1", "hi")}\n`);
        expect(await syncSessionHistory(SESSION, { now: new Date(now.getTime() + 500) })).toBe(
            "skipped"
        );
        expect(db.messages).toHaveLength(1);
    });

    it("links a prompt typed in Polaris to its transcript line instead of showing it twice", async () => {
        db.messages.push({
            id: "typed-1",
            sessionId: SESSION,
            role: "user",
            kind: "text",
            subject: "",
            ref: "",
            body: "run the tests",
            authorId: "owner",
            vendorId: null,
            createdAt: new Date(Date.now() - 1000)
        });
        writeFileSync(
            path,
            `${user("u-1", "run the tests")}\n${user("u-2", "typed in the terminal")}\n`
        );
        await syncSessionHistory(SESSION, { now: later(0) });
        expect(db.messages.map((one) => [one.id, one.body, one.vendorId, one.authorId])).toEqual([
            ["typed-1", "run the tests", "u-1:0", "owner"],
            ["m-0001", "typed in the terminal", "u-2:0", null]
        ]);
    });

    it("starts again at 0 for a new transcript file, and reads nothing for an ended session or a bad path", async () => {
        writeFileSync(path, `${user("u-9", "new conversation")}\n`);
        db.session!.transcriptFile = "/root/.claude/projects/-session-repo/old.jsonl";
        db.session!.transcriptOffset = 999_999n;
        await syncSessionHistory(SESSION, { now: later(0) });
        expect(db.messages.map((one) => one.body)).toEqual(["new conversation"]);

        db.session!.state = "stopped";
        expect(await syncSessionHistory(SESSION, { now: later(SYNC_DEBOUNCE_MS * 3) })).toBe(
            "skipped"
        );
        db.session!.state = "idle";
        db.session!.transcriptPath = "/etc/passwd";
        expect(await syncSessionHistory(SESSION, { now: later(SYNC_DEBOUNCE_MS * 4) })).toBe(
            "skipped"
        );
        db.session!.transcriptPath = db.virtual;
        db.session!.cli = "copilot";
        expect(await syncSessionHistory(SESSION, { now: later(SYNC_DEBOUNCE_MS * 5) })).toBe(
            "skipped"
        );
    });
});

describe("the end of a session", () => {
    it("reads the last turn of a session that has ended when asked for its final read", async () => {
        writeFileSync(path, `${user("u-1", "ship it")}\n${reply("a-1", "Shipped.")}\n`);
        db.session!.state = "stopped";
        db.session!.transcriptSyncedAt = new Date();
        expect(await syncSessionHistory(SESSION)).toBe("skipped");
        expect(await syncSessionHistory(SESSION, { final: true })).toBe("synced");
        expect(db.messages.map((one) => one.body)).toEqual(["ship it", "Shipped."]);
    });

    it("drains a backlog larger than one read in one sync", async () => {
        const count = MAX_ROWS_PER_SYNC * 2 + 25;
        const lines = Array.from({ length: count }, (_, index) =>
            reply(`a-${index}`, `line ${index}`)
        );
        writeFileSync(path, `${lines.join("\n")}\n`);
        expect(await syncSessionHistory(SESSION, { now: later(0) })).toBe("synced");
        expect(db.messages).toHaveLength(count);
        expect(db.session!.transcriptOffset).toBe(
            BigInt(Buffer.byteLength(`${lines.join("\n")}\n`))
        );
    }, 120_000);

    it("reads once more after the debounce when a read came too soon", async () => {
        writeFileSync(path, `${reply("a-1", "Last answer.")}\n`);
        db.session!.transcriptSyncedAt = new Date(Date.now() - SYNC_DEBOUNCE_MS + 50);
        expect(await syncSessionHistorySoon(SESSION, { wait: 150 })).toBe("synced");
        expect(db.messages.map((one) => one.body)).toEqual(["Last answer."]);
    });
});

describe("order", () => {
    it("sorts by when the agent wrote a line, not when it was read", async () => {
        const sent = Date.now() - 1_000;
        db.messages.push({
            id: "typed-b",
            sessionId: SESSION,
            role: "user",
            kind: "text",
            subject: "",
            ref: "",
            body: "now the docs",
            authorId: "owner",
            vendorId: null,
            createdAt: new Date(sent)
        });
        writeFileSync(
            path,
            [
                reply("a-1", "Tests pass.", new Date(sent - 2_000).toISOString()),
                user("u-b", "now the docs", new Date(sent + 20).toISOString()),
                reply("a-2", "Docs updated.", new Date(sent + 5_000).toISOString())
            ].join("\n") + "\n"
        );
        await syncSessionHistory(SESSION, { now: later(60_000) });
        const page = await historyPage(SESSION);
        expect(page.messages.map((one) => one.body)).toEqual([
            "Tests pass.",
            "now the docs",
            "Docs updated."
        ]);
        expect(db.messages.find((one) => one.id === "typed-b")!.vendorId).toBe("u-b:0");
    });

    it("links a typed prompt whose transcript copy differs only in spacing", async () => {
        db.messages.push({
            id: "typed-1",
            sessionId: SESSION,
            role: "user",
            kind: "text",
            subject: "",
            ref: "",
            body: "first line\r\nsecond line",
            authorId: "owner",
            vendorId: null,
            createdAt: new Date(Date.now() - 1000)
        });
        writeFileSync(path, `${user("u-1", "first line\nsecond line")}\n`);
        await syncSessionHistory(SESSION, { now: later(0) });
        expect(db.messages.map((one) => [one.id, one.vendorId])).toEqual([["typed-1", "u-1:0"]]);
    });
});

describe("sessionHistoryAction", () => {
    it("answers whoever may read the session, owner or shared, and nobody else", async () => {
        writeFileSync(path, `${user("u-1", "hello")}\n`);
        db.owned = false;
        db.shared = true;
        const shared = await sessionHistoryAction({ sessionId: SESSION });
        expect(shared.messages?.map((one) => one.body)).toEqual(["hello"]);

        db.shared = false;
        const stranger = await sessionHistoryAction({ sessionId: SESSION });
        expect(stranger.messages).toBeUndefined();
        expect(stranger.error).toBeTruthy();
    });

    it("refuses an input that does not parse", async () => {
        expect((await sessionHistoryAction({ sessionId: "../x" })).error).toBeTruthy();
        expect(
            (await sessionHistoryAction({ sessionId: SESSION, before: "not-a-uuid" })).error
        ).toBeTruthy();
    });
});
