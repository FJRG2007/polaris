/**
 * A session whose agent hits a usage limit moves to the next of its owner's
 * accounts and sends the failed turn again; an overloaded provider gets the
 * turn again after a wait; every account at its limit leaves the session
 * waiting with a notice. Two copies of one failure move it once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);
const SESSION = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

interface KeyRow {
    id: string;
    userId: string | null;
    provider: string;
    name: string;
    config: string;
    priority: number;
    createdAt: Date;
    enabled: boolean;
    expiresAt: Date | null;
    coolingUntil: Date | null;
    coolingReason: string | null;
}

const db = vi.hoisted(() => ({
    session: null as Record<string, unknown> | null,
    keys: [] as KeyRow[],
    prompt: "Fix the flaky test" as string | null
}));

function same(left: unknown, right: unknown): boolean {
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    return left === right;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: async () => {
                await Promise.resolve();
                return db.session ? { ...db.session } : null;
            },
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                await Promise.resolve();
                const row = db.session;
                if (!row) return { count: 0 };
                for (const [key, value] of Object.entries(where)) {
                    if (key === "OR") continue;
                    if (!same(row[key], value)) return { count: 0 };
                }
                Object.assign(row, data);
                return { count: 1 };
            },
            findMany: async () => (db.session ? [{ ...db.session }] : [])
        },
        userModelKey: {
            findFirst: async ({ where }: { where: { id: string } }) =>
                db.keys.find((key) => key.id === where.id) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) =>
                db.keys.find((key) => key.id === where.id) ?? null,
            findMany: async () =>
                [...db.keys].sort((x, y) => x.priority - y.priority).map((key) => ({ ...key })),
            updateMany: async ({ where, data }: { where: { id: string }; data: Partial<KeyRow> }) => {
                const key = db.keys.find((row) => row.id === where.id);
                if (key) Object.assign(key, data);
                return { count: key ? 1 : 0 };
            }
        },
        agentSessionMessage: {
            findFirst: async () => (db.prompt ? { body: db.prompt } : null)
        }
    }
}));
vi.mock("@/lib/agents/session-service", () => ({ addSessionMessage: async () => undefined }));
vi.mock("@/lib/agents/session-runtime", () => ({
    queueTurnAgain: async () => true,
    moveAgentToAccount: async () => "next-turn",
    promptMovedAgent: async () => true
}));
vi.mock("@/lib/agents/model-keys", () => ({ instanceKeysAreShared: async () => false }));

const rotation = await import("@/lib/agents/account-rotation");

function key(id: string, name: string, priority: number, cooling: Partial<KeyRow> = {}): KeyRow {
    return {
        id,
        userId: OWNER,
        provider: "agent-signin-claude-code-oauth-token",
        name,
        config: JSON.stringify({ email: `${name}@example.test` }),
        priority,
        createdAt: new Date(NOW - priority),
        enabled: true,
        expiresAt: null,
        coolingUntil: null,
        coolingReason: null,
        ...cooling
    };
}

function ports() {
    const notices: string[] = [];
    const resent: string[] = [];
    const slept: number[] = [];
    return {
        notices,
        resent,
        slept,
        ports: {
            notice: async (_id: string, body: string) => {
                notices.push(body);
            },
            resend: async (id: string) => {
                resent.push(id);
                return true;
            },
            sleep: async (ms: number) => {
                slept.push(ms);
            }
        }
    };
}

const LIMITED = {
    hook_event_name: "StopFailure",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
    last_assistant_message: "You've hit your session limit · resets 2:40pm (Europe/Istanbul)"
};

describe("limitOf", () => {
    it("reads Claude Code's typed error first", () => {
        expect(rotation.limitOf({ error: "rate_limit", text: "" }, NOW).kind).toBe("rate_limit");
        expect(rotation.limitOf({ error: "overloaded", text: "" }, NOW).kind).toBe("overloaded");
        expect(rotation.limitOf({ error: "authentication_failed", text: "401" }, NOW).kind).toBe("other");
        expect(rotation.limitOf({ error: "billing_error", text: "" }, NOW).kind).toBe("other");
    });

    it("reads the words when no type is named", () => {
        const kind = (text: string) => rotation.limitOf({ text }, NOW).kind;
        expect(kind("API Error: Rate limit reached")).toBe("rate_limit");
        expect(kind("Claude AI usage limit reached|1794830400")).toBe("rate_limit");
        expect(kind("You’ve hit your usage limit. To get more access now, send a request to your admin or try again later.")).toBe("rate_limit");
        expect(kind("You exceeded your current quota, please check your plan and billing details.")).toBe("rate_limit");
        expect(kind('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("overloaded");
        expect(kind("Selected model is at capacity. Please try a different model.")).toBe("overloaded");
        expect(kind("The model is overloaded. Please try again later.")).toBe("overloaded");
        expect(kind("Error on line 429 of the file")).toBe("other");
        expect(kind("")).toBe("other");
    });

    it("reads the reset each tool prints", () => {
        const at = (text: string) => rotation.resetFromText(text, NOW);
        // 2:40pm in Istanbul (UTC+3) is 11:40 UTC, later the same day.
        expect(at("resets 2:40pm (Europe/Istanbul)")).toBe(Date.UTC(2026, 10, 15, 11, 40));
        // 2am in Berlin (UTC+1) has passed today, so tomorrow: 01:00 UTC.
        expect(at("You've hit your session limit · resets 2am (Europe/Berlin)")).toBe(Date.UTC(2026, 10, 16, 1, 0));
        expect(at("resets 12:30pm")).toBe(Date.UTC(2026, 10, 15, 12, 30));
        expect(at(`usage limit reached|${NOW / 1000 + 3600}`)).toBe(NOW + 3_600_000);
        expect(at("You’ve hit your usage limit. Try again at 3:05 PM.")).toBe(Date.UTC(2026, 10, 15, 15, 5));
        expect(at("You’ve hit your usage limit. Try again at Nov 20th, 2026 3:05 PM.")).toBe(Date.UTC(2026, 10, 20, 15, 5));
        expect(at("Please retry in 40.025771073s.")).toBe(NOW + 40_026);
        expect(at("Please retry in 900.2ms.")).toBe(NOW + 901);
        expect(at("resets 2pm (Not/AZone)")).toBe(Date.UTC(2026, 10, 15, 14, 0));
        expect(at("no time here")).toBeNull();
    });

    it("reads the whole hook payload, past the stored line's clip", () => {
        const reading = rotation.limitOf(rotation.failureOf(LIMITED), NOW);
        expect(reading).toEqual({ kind: "rate_limit", resetAt: Date.UTC(2026, 10, 15, 11, 40) });
        expect(rotation.failureOf({ hook_event_name: "errorOccurred", error: { message: "Quota exceeded for metric: x" } }).text).toContain("Quota exceeded");
    });
});

describe("cooling and order", () => {
    beforeEach(() => rotation.resetCoolingLevels());

    it("keeps the reported reset, else 2 minutes doubling to 30", () => {
        expect(rotation.coolingUntil(A, NOW + 3_600_000, NOW)).toBe(NOW + 3_600_000);
        rotation.resetCoolingLevels();
        const steps = [0, 1, 2, 3, 4, 5].map(() => rotation.coolingUntil(B, null, NOW) - NOW);
        expect(steps).toEqual([2, 4, 8, 16, 30, 30].map((minutes) => minutes * 60_000));
        // Long after the last one, it starts over.
        expect(rotation.coolingUntil(B, null, NOW + 3 * 3_600_000) - (NOW + 3 * 3_600_000)).toBe(120_000);
    });

    it("takes the first ready account in the owner's order, skipping cooling and refused ones", () => {
        const accounts = [
            { id: A, name: "a", coolingUntil: null, coolingReason: null },
            { id: B, name: "b", coolingUntil: NOW + 60_000, coolingReason: "rate" },
            { id: C, name: "c", coolingUntil: null, coolingReason: null }
        ];
        expect(rotation.nextAccount(accounts, A, NOW)?.id).toBe(C);
        expect(rotation.nextAccount(accounts, C, NOW)?.id).toBe(A);
        expect(rotation.nextAccount([accounts[0]!, accounts[1]!], A, NOW)).toBeNull();
        // Once B's cool-down has passed it is ready again.
        expect(rotation.nextAccount(accounts, A, NOW + 120_000)?.id).toBe(B);
    });

    it("names the first to free up, never a refused key", () => {
        const accounts = [
            { id: A, name: "a", coolingUntil: NOW + 600_000, coolingReason: "rate" },
            { id: B, name: "b", coolingUntil: NOW + 60_000, coolingReason: "key" },
            { id: C, name: "c", coolingUntil: NOW + 300_000, coolingReason: "rate" }
        ];
        expect(rotation.firstFree(accounts, NOW)).toEqual({ account: accounts[2], at: NOW + 300_000 });
        expect(rotation.firstFree([accounts[1]!], NOW)).toBeNull();
    });
});

describe("handleTurnFailure", () => {
    beforeEach(() => {
        rotation.resetCoolingLevels();
        db.prompt = "Fix the flaky test";
        db.keys = [key(A, "first", 0), key(B, "second", 1), key(C, "third", 2)];
        db.session = {
            id: SESSION,
            startedById: OWNER,
            cli: "claude",
            accountId: A,
            useMachineLogin: false,
            state: "idle",
            limitSeq: null,
            limitWaitUntil: null,
            limitRetries: 0
        };
    });

    it("moves to the next account once under a concurrent duplicate, and sends the turn again once", async () => {
        const seen = ports();
        const outcomes = await Promise.all([
            rotation.handleTurnFailure(SESSION, LIMITED, 5n, seen.ports, NOW),
            rotation.handleTurnFailure(SESSION, LIMITED, 5n, seen.ports, NOW)
        ]);
        expect(outcomes.sort()).toEqual(["ignored", "rotated"]);
        expect(db.session!.accountId).toBe(B);
        expect(db.session!.limitSeq).toBe(5n);
        expect(seen.resent).toEqual([SESSION]);
        expect(seen.notices).toEqual([
            "Switched to second@example.test - first@example.test hit its limit, resets at 2026-11-15T11:40:00.000Z."
        ]);
        expect(db.keys[0]!.coolingUntil?.getTime()).toBe(Date.UTC(2026, 10, 15, 11, 40));
        expect(db.keys[0]!.coolingReason).toBe("rate");
        // A late copy of the same failure moves nothing.
        expect(await rotation.handleTurnFailure(SESSION, LIMITED, 5n, seen.ports, NOW)).toBe("ignored");
        expect(db.session!.accountId).toBe(B);
    });

    it("waits with a notice when every account is at its limit, without failing the session", async () => {
        db.keys[1]!.coolingUntil = new Date(NOW + 20 * 60_000);
        db.keys[1]!.coolingReason = "rate";
        db.keys[2]!.coolingUntil = new Date(NOW + 6 * 3_600_000);
        db.keys[2]!.coolingReason = "key";
        const seen = ports();
        const outcome = await rotation.handleTurnFailure(
            SESSION,
            { error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" },
            7n,
            seen.ports,
            NOW
        );
        expect(outcome).toBe("waiting");
        expect(db.session!.accountId).toBe(A);
        expect(db.session!.state).toBe("idle");
        // A cooled for the default 2 minutes, so it frees up first.
        expect((db.session!.limitWaitUntil as Date).getTime()).toBe(NOW + 120_000);
        expect(seen.resent).toEqual([]);
        expect(seen.notices).toEqual([
            "Every account for this agent is at its limit (first@example.test, second@example.test, third@example.test). The session waits and carries on at 2026-11-15T10:02:00.000Z on first@example.test."
        ]);
        // A duplicate of the same wait says nothing twice.
        const again = await Promise.all([
            rotation.handleTurnFailure(SESSION, { error: "rate_limit" }, 7n, seen.ports, NOW),
            rotation.handleTurnFailure(SESSION, { error: "rate_limit" }, null, seen.ports, NOW)
        ]);
        expect(again).toEqual(["ignored", "ignored"]);
        expect(seen.notices).toHaveLength(1);
    });

    it("carries the waiting session on once an account frees up", async () => {
        db.session!.limitWaitUntil = new Date(NOW - 1);
        db.keys[0]!.coolingUntil = new Date(NOW - 1);
        const seen = ports();
        expect(await rotation.resumeLimitedSessions(seen.ports, NOW)).toBe(1);
        expect(db.session!.limitWaitUntil).toBeNull();
        expect(seen.notices).toEqual(["Carrying on with first@example.test now that its limit has reset."]);
        expect(seen.resent).toEqual([SESSION]);
    });

    it("sends an overloaded turn again after a wait, without rotating, at most twice", async () => {
        const seen = ports();
        const overloaded = { error: "overloaded", error_details: "529" };
        expect(await rotation.handleTurnFailure(SESSION, overloaded, 1n, seen.ports, NOW)).toBe("retried");
        expect(await rotation.handleTurnFailure(SESSION, overloaded, 2n, seen.ports, NOW)).toBe("retried");
        expect(await rotation.handleTurnFailure(SESSION, overloaded, 3n, seen.ports, NOW)).toBe("ignored");
        expect(db.session!.accountId).toBe(A);
        expect(seen.slept).toEqual([30_000, 60_000]);
        expect(seen.resent).toEqual([SESSION, SESSION]);
        expect(db.keys.every((row) => row.coolingUntil === null)).toBe(true);
    });

    it("leaves anything that is not a limit, and a machine that signs itself in, alone", async () => {
        const seen = ports();
        expect(await rotation.handleTurnFailure(SESSION, { error: "invalid_request" }, 1n, seen.ports, NOW)).toBe("ignored");
        db.session!.useMachineLogin = true;
        expect(await rotation.handleTurnFailure(SESSION, LIMITED, 2n, seen.ports, NOW)).toBe("ignored");
        expect(seen.notices).toEqual([]);
        expect(db.session!.accountId).toBe(A);
    });
});

describe("a turn that cannot be queued again", () => {
    beforeEach(() => {
        rotation.resetCoolingLevels();
        db.keys = [key(A, "first", 0), key(B, "second", 1)];
        db.session = {
            id: SESSION,
            startedById: OWNER,
            cli: "claude",
            accountId: A,
            useMachineLogin: false,
            state: "idle",
            limitSeq: null,
            limitWaitUntil: null,
            limitRetries: 0
        };
    });

    it("still switches, and asks the person to send it", async () => {
        const seen = ports();
        const refusing = { ...seen.ports, resend: async () => false };
        expect(await rotation.handleTurnFailure(SESSION, LIMITED, 9n, refusing, NOW)).toBe("rotated");
        expect(db.session!.accountId).toBe(B);
        expect(seen.notices.at(-1)).toBe(rotation.RESEND_YOURSELF);
    });
});
