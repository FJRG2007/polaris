/**
 * A session moved to another account by hand: only to an account the rotation
 * could pick, once under two switches at once, with a notice, a restart on the
 * new account, and the turn a limit held sent again. Codex accounts rotate on
 * a usage limit the same way Claude's do.
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
vi.mock("@/lib/agents/session-runtime", () => ({ queueTurnAgain: async () => true }));
vi.mock("@/lib/agents/model-keys", () => ({ instanceKeysAreShared: async () => false }));

const rotation = await import("@/lib/agents/account-rotation");

const CODEX = "agent-signin-codex-chatgpt-auth";

function key(id: string, name: string, priority: number, extra: Partial<KeyRow> = {}): KeyRow {
    return {
        id,
        userId: OWNER,
        provider: CODEX,
        name,
        config: JSON.stringify({ email: `${name}@example.test` }),
        priority,
        createdAt: new Date(NOW - priority),
        enabled: true,
        expiresAt: null,
        coolingUntil: null,
        coolingReason: null,
        ...extra
    };
}

function ports() {
    const notices: string[] = [];
    const restarted: string[] = [];
    const resent: string[] = [];
    return {
        notices,
        restarted,
        resent,
        ports: {
            notice: async (_id: string, body: string) => {
                notices.push(body);
            },
            restart: async (id: string) => {
                restarted.push(id);
            },
            resend: async (id: string) => {
                resent.push(id);
                return true;
            },
            sleep: async () => undefined
        }
    };
}

beforeEach(() => {
    rotation.resetCoolingLevels();
    db.prompt = "Fix the flaky test";
    db.keys = [key(A, "first", 0), key(B, "second", 1), key(C, "third", 2)];
    db.session = {
        id: SESSION,
        startedById: OWNER,
        cli: "codex",
        accountId: A,
        useMachineLogin: false,
        state: "idle",
        limitSeq: null,
        limitWaitUntil: null,
        limitRetries: 0
    };
});

describe("switchSessionAccount", () => {
    it("moves once under two switches at once, says so, and restarts on the new account", async () => {
        const seen = ports();
        const outcomes = await Promise.all([
            rotation.switchSessionAccount(SESSION, B, seen.ports),
            rotation.switchSessionAccount(SESSION, B, seen.ports)
        ]);
        expect(outcomes.sort()).toEqual(["moved", "raced"]);
        expect(db.session!.accountId).toBe(B);
        expect(seen.notices).toEqual(["Moved to second@example.test from first@example.test."]);
        expect(seen.restarted).toEqual([SESSION]);
        expect(seen.resent).toEqual([]);
    });

    it("ends a wait on a usage limit and sends the held turn on the new account", async () => {
        db.session!.limitWaitUntil = new Date(NOW + 60_000);
        db.session!.limitRetries = 1;
        const seen = ports();
        expect(await rotation.switchSessionAccount(SESSION, C, seen.ports)).toBe("moved");
        expect(db.session!.limitWaitUntil).toBeNull();
        expect(db.session!.limitRetries).toBe(0);
        expect(seen.resent).toEqual([SESSION]);
    });

    it("refuses an account outside the rotation, the one in use, a machine login and an ended session", async () => {
        const seen = ports();
        expect(await rotation.switchSessionAccount(SESSION, "not-an-account", seen.ports)).toBe("unknown");
        expect(await rotation.switchSessionAccount(SESSION, A, seen.ports)).toBe("same");
        db.session!.useMachineLogin = true;
        expect(await rotation.switchSessionAccount(SESSION, B, seen.ports)).toBe("machine");
        db.session!.useMachineLogin = false;
        db.session!.state = "stopped";
        expect(await rotation.switchSessionAccount(SESSION, B, seen.ports)).toBe("over");
        expect(db.session!.accountId).toBe(A);
        expect(seen.notices).toEqual([]);
        expect(seen.restarted).toEqual([]);
    });

    it("lists the accounts a running session could move to, cooling ones dated", async () => {
        db.keys[1]!.coolingUntil = new Date(NOW + 3_600_000);
        db.keys[1]!.coolingReason = "rate";
        const found = await rotation.sessionAccountChoices(SESSION);
        expect(found?.current).toBe(A);
        expect(found?.accounts.map((account) => account.id)).toEqual([A, B, C]);
        expect(found?.accounts[1]!.coolingUntil).toBe(NOW + 3_600_000);
        db.session!.useMachineLogin = true;
        expect(await rotation.sessionAccountChoices(SESSION)).toBeNull();
    });
});

describe("Codex on a usage limit", () => {
    it("rotates to the next ChatGPT account with the reset Codex printed", async () => {
        const seen = ports();
        const payload = { error: "", message: "You've hit your usage limit. Try again at 3:05 PM." };
        expect(await rotation.handleTurnFailure(SESSION, payload, 3n, seen.ports, NOW)).toBe("rotated");
        expect(db.session!.accountId).toBe(B);
        expect(seen.notices[0]).toBe(
            "Switched to second@example.test - first@example.test hit its limit, resets at 2026-11-15T15:05:00.000Z."
        );
    });
});
