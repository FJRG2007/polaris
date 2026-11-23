/**
 * Proving and setting a password over OPAQUE (docs/chat-e2ee-phase1.md,
 * "Password flows over OPAQUE"): the browser half (`password-flows-client.ts`)
 * against the real `/api/e2ee/keys` handler and the server half the actions call
 * (`opaque-password.ts`), real OPAQUE on both sides over an in-memory database.
 *
 * Pinned: neither password ever reaches the server on the new path; a wrong
 * password, a replayed or foreign proof and a record that was never verified are
 * refused; every worker or network failure reads as "use the old action"; the
 * kill switch and an account not moved yet keep the old action; and the old
 * hash stops opening the account once a password was set over OPAQUE.
 */

import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface UserRow {
    id: string;
    email: string;
}

const state = vi.hoisted(() => ({
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    users: [] as { id: string; email: string }[],
    credentials: new Map<string, string>(),
    tables: {
        setup: new Map<string, Record<string, unknown>>(),
        records: new Map<string, Record<string, unknown>>(),
        logins: new Map<string, Record<string, unknown>>(),
        keys: new Map<string, Record<string, unknown>>(),
        locks: new Map<string, Record<string, unknown>>()
    },
    sessionUser: null as { id: string; name?: string; email?: string; sessionId?: string } | null,
    hashed: [] as string[],
    bodies: [] as string[],
    issued: [] as { userId: string; challenged: boolean }[],
    twoFactor: new Set<string>(),
    limits: new Map<string, number>(),
    limitCap: Number.POSITIVE_INFINITY
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: state.masterKey }) }));

vi.mock("@polaris/db", () => {
    class PrismaClientKnownRequestError extends Error {
        code: string;
        constructor(code: string) {
            super(code);
            this.code = code;
        }
    }
    const conflict = () => new PrismaClientKnownRequestError("P2002");
    const t = state.tables;
    const lockKey = (w: { userId: string; kind: string; lockId: string }) => `${w.userId}|${w.kind}|${w.lockId}`;
    const prisma = {
        $transaction: (operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
            typeof operations === "function" ? operations(prisma) : Promise.all(operations),
        opaqueServerSetup: {
            findUnique: async ({ where }: { where: { id: string } }) => t.setup.get(where.id) ?? null,
            create: async ({ data }: { data: Record<string, unknown> & { id: string } }) => {
                if (t.setup.has(data.id)) throw conflict();
                t.setup.set(data.id, { ...data });
                return data;
            },
            delete: async ({ where }: { where: { id: string } }) => t.setup.delete(where.id)
        },
        opaqueRecord: {
            findUnique: async ({ where }: { where: { userId: string } }) => {
                const row = t.records.get(where.userId);
                return row ? { ...row } : null;
            },
            upsert: async ({ where, create, update }: Record<string, Record<string, unknown>>) => {
                const id = where!.userId as string;
                const existing = t.records.get(id);
                t.records.set(id, existing ? { ...existing, ...update } : { verifiedAt: null, ...create });
            },
            updateMany: async ({ where, data }: { where: { userId: string; record: string }; data: object }) => {
                const row = t.records.get(where.userId);
                if (!row || row.record !== where.record) return { count: 0 };
                t.records.set(where.userId, { ...row, ...data });
                return { count: 1 };
            },
            deleteMany: async () => {
                const count = t.records.size;
                t.records.clear();
                return { count };
            }
        },
        opaqueLogin: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const id = randomUUID();
                t.logins.set(id, { ...data, id });
                return { id };
            },
            findUnique: async ({ where }: { where: { id: string } }) => t.logins.get(where.id) ?? null,
            deleteMany: async ({ where }: { where: { id?: string; expiresAt?: { lte: Date } } }) => {
                if (where.id) return { count: t.logins.delete(where.id) ? 1 : 0 };
                let count = 0;
                for (const [id, row] of t.logins)
                    if ((row.expiresAt as Date) <= where.expiresAt!.lte) count += Number(t.logins.delete(id));
                return { count };
            }
        },
        account: {
            updateMany: async ({ where, data }: { where: { userId: string }; data: { password: string } }) => {
                if (!state.credentials.has(where.userId)) return { count: 0 };
                state.credentials.set(where.userId, data.password);
                return { count: 1 };
            },
            findFirst: async ({ where }: { where: { userId: string } }) => {
                const password = state.credentials.get(where.userId);
                return password ? { password } : null;
            }
        },
        user: {
            findUnique: async ({ where }: { where: { email: string } }) =>
                state.users.find((user) => user.email === where.email) ?? null
        },
        chatAccountKey: {
            findUnique: async ({ where }: { where: { userId: string } }) => t.keys.get(where.userId) ?? null,
            create: async ({ data }: { data: Record<string, unknown> & { userId: string } }) => {
                if (t.keys.has(data.userId)) throw conflict();
                t.keys.set(data.userId, data);
                return data;
            }
        },
        chatAccountKeyLock: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                [...t.locks.values()].filter((row) => row.userId === where.userId),
            findUnique: async ({ where }: { where: { userId_kind_lockId: { userId: string; kind: string; lockId: string } } }) =>
                t.locks.get(lockKey(where.userId_kind_lockId)) ?? null,
            upsert: async ({ where, create, update }: { where: { userId_kind_lockId: { userId: string; kind: string; lockId: string } }; create: object; update: object }) => {
                const key = lockKey(where.userId_kind_lockId);
                const existing = t.locks.get(key);
                t.locks.set(key, existing ? { ...existing, ...update } : { ...create });
            },
            deleteMany: async ({ where }: { where: { userId: string; kind: string; lockId: string } }) => {
                t.locks.delete(lockKey(where));
                return { count: 1 };
            }
        }
    };
    return { prisma, Prisma: { PrismaClientKnownRequestError } };
});

vi.mock("@/lib/auth", () => ({
    auth: {
        $context: Promise.resolve({
            password: {
                hash: async (password: string) => {
                    state.hashed.push(password);
                    return `scrypt:${password}`;
                },
                verify: async ({ hash, password }: { hash: string; password: string }) => hash === `scrypt:${password}`
            }
        })
    }
}));

vi.mock("@polaris/auth", () => ({
    signInWithOpaque: async (_auth: unknown, userId: string) => {
        const challenged = state.twoFactor.has(userId);
        state.issued.push({ userId, challenged });
        return { cookies: [], challenged };
    }
}));

vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.sessionUser }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        const count = (state.limits.get(key) ?? 0) + 1;
        state.limits.set(key, count);
        return { ok: count <= state.limitCap, retryAfterMs: 60_000 };
    }
}));

// The password worker runs the same four OPAQUE steps; vitest has no Worker, so
// they run here - or fail, as a worker that never started does.
const worker = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/chat/e2ee/password-worker-client", async () => {
    const real = await import("@polaris/chat-crypto/password-lock");
    const guarded =
        <A extends unknown[], R>(step: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
            if (worker.down) throw new Error("The password worker stopped");
            return step(...args);
        };
    return {
        startPasswordRegistration: guarded(real.startPasswordRegistration),
        finishPasswordRegistration: guarded(real.finishPasswordRegistration),
        startPasswordLogin: guarded(real.startPasswordLogin),
        finishPasswordLogin: guarded(real.finishPasswordLogin)
    };
});

const handlers = await import("@/lib/chat/e2ee/handlers");
const service = await import("@/lib/chat/e2ee/opaque-service");
const client = await import("@/lib/chat/e2ee/sign-in-client");
const flows = await import("@/lib/chat/e2ee/password-flows-client");
const server = await import("@/lib/chat/e2ee/opaque-password");

const PASSWORD = "correct horse battery";
const NEXT = "a brand new staple 42";

/** An account already moved onto OPAQUE, signed in on this session. */
async function adoptedAccount(email = "alice@example.com"): Promise<UserRow> {
    const user = account(email, PASSWORD);
    expect(await client.adoptOpaque(user.email, PASSWORD)).toBe(true);
    state.sessionUser = { id: user.id, name: "Alice Example", email: user.email, sessionId: "session-1" };
    state.bodies.length = 0;
    return user;
}

/** Whether a password appears in anything the browser sent. */
function sent(password: string): boolean {
    return state.bodies.some((body) => body.includes(password));
}

function account(email: string, password: string | null): UserRow {
    const user = { id: randomUUID(), email };
    state.users.push(user);
    if (password) state.credentials.set(user.id, `scrypt:${password}`);
    return user;
}

function post(path: string, body: unknown, type = "application/json"): Promise<Response> {
    const route = path.endsWith("/keys") ? handlers.handleKeys : handlers.handleSignIn;
    return route(new Request(`https://polaris.example.com${path}`, {
        method: "POST",
        headers: { "content-type": type },
        body: typeof body === "string" ? body : JSON.stringify(body)
    }));
}

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    delete process.env.POLARIS_INTERNAL_PASSWORD_LOCK;
    worker.down = false;
    for (const table of Object.values(state.tables)) table.clear();
    state.users.length = 0;
    state.credentials.clear();
    state.issued.length = 0;
    state.twoFactor.clear();
    state.limits.clear();
    state.hashed.length = 0;
    state.bodies.length = 0;
    state.limitCap = Number.POSITIVE_INFINITY;
    state.sessionUser = null;
    service.resetServerSetupCache();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        // The breach check's own range route is not under test: it fails open.
        if (url.startsWith("/api/polaris/pwned/")) return new Response("", { status: 404 });
        state.bodies.push(String(init.body));
        return post(url, init.body as string, (init.headers as Record<string, string>)["content-type"]);
    });
});

afterEach(() => {
    delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
    delete process.env.POLARIS_INTERNAL_PASSWORD_LOCK;
    vi.unstubAllGlobals();
});

describe("which path a form takes", () => {
    it("an account moved onto OPAQUE gets its identity for the rules", async () => {
        const alice = await adoptedAccount();
        expect(await flows.opaquePasswordReady()).toEqual({ name: "Alice Example", email: alice.email });
    });

    it("an account not moved yet, with or without the kill switch, and no session keep the old action", async () => {
        const bob = account("bob@example.com", PASSWORD);
        state.sessionUser = { id: bob.id, name: "Bob", email: bob.email, sessionId: "session-b" };
        expect(await flows.opaquePasswordReady()).toBeNull();

        process.env.POLARIS_INTERNAL_PASSWORD_LOCK = "0";
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(await flows.opaquePasswordReady()).toBeNull();
        expect((await post("/api/e2ee/keys", { op: "state" })).status).toBe(404);
        expect(await server.provesPassword(bob.id, { loginId: randomUUID() })).toBe(false);

        delete process.env.POLARIS_INTERNAL_PASSWORD_LOCK;
        state.sessionUser = null;
        expect(await flows.opaquePasswordReady()).toBeNull();
    });
});

describe("proving the current password", () => {
    it("proves the right password without sending it, once", async () => {
        const alice = await adoptedAccount();
        const proof = await flows.provePassword(PASSWORD);
        expect(proof.finishLoginRequest).toBeTruthy();
        expect(sent(PASSWORD)).toBe(false);
        expect(await server.provesPassword(alice.id, proof)).toBe(true);
        // Spent: the same proof never opens a second action.
        expect(await server.provesPassword(alice.id, proof)).toBe(false);
    });

    it("a wrong password sends no finish, and the server still spends and refuses it", async () => {
        const alice = await adoptedAccount();
        const proof = await flows.provePassword("not the password at all");
        expect(proof.finishLoginRequest).toBeUndefined();
        expect(sent("not the password at all")).toBe(false);
        expect(state.tables.logins.size).toBe(1);
        expect(await server.provesPassword(alice.id, proof)).toBe(false);
        expect(state.tables.logins.size).toBe(0);
    });

    it("a proof made on one account does not prove another", async () => {
        await adoptedAccount();
        const proof = await flows.provePassword(PASSWORD);
        const mallory = account("mallory@example.com", PASSWORD);
        expect(await server.provesPassword(mallory.id, proof)).toBe(false);
    });

    it("a proof finishes only on the session that started it", async () => {
        const alice = await adoptedAccount();
        const proof = await flows.provePassword(PASSWORD);
        state.sessionUser = { ...state.sessionUser!, sessionId: "session-2" };
        expect(await server.provesPassword(alice.id, proof)).toBe(false);
        state.sessionUser = { ...state.sessionUser!, sessionId: "session-1" };
        const set = await flows.prepareNewPassword(NEXT, { email: alice.email });
        state.sessionUser = null;
        expect(await server.setPasswordOverOpaque(alice.id, set)).toBe(false);
        expect(state.credentials.get(alice.id)).toBe(`scrypt:${PASSWORD}`);
    });

    it("is rate limited per account", async () => {
        await adoptedAccount();
        state.limitCap = 0;
        await expect(flows.provePassword(PASSWORD)).rejects.toBeInstanceOf(flows.PasswordFlowUnavailable);
        expect([...state.limits.keys()].some((key) => key.startsWith("e2ee-proof:"))).toBe(true);
    });

    it("a step-up password becomes its OPAQUE proof, or goes as it was", async () => {
        const alice = await adoptedAccount();
        let stretched = false;
        const proof = await flows.sentStepUpProof({ proof: "password", password: PASSWORD }, () => {
            stretched = true;
        });
        expect(proof.proof).toBe("opaque-password");
        expect(stretched).toBe(true);
        expect(JSON.stringify(proof)).not.toContain(PASSWORD);
        expect(await server.provesPassword(alice.id, proof as { loginId: string; finishLoginRequest?: string; })).toBe(true);

        // A code is never touched; a worker that is down falls back to the password.
        expect(await flows.sentStepUpProof({ proof: "totp", code: "123456" })).toEqual({ proof: "totp", code: "123456" });
        worker.down = true;
        expect(await flows.sentStepUpProof({ proof: "password", password: PASSWORD })).toEqual({
            proof: "password",
            password: PASSWORD
        });
    });
});

describe("setting a new password", () => {
    it("replaces the password without the server ever seeing either", async () => {
        const alice = await adoptedAccount();
        const proof = await flows.provePassword(PASSWORD);
        const set = await flows.prepareNewPassword(NEXT, { name: "Alice Example", email: alice.email });
        expect(await server.provesPassword(alice.id, proof)).toBe(true);
        expect(await server.setPasswordOverOpaque(alice.id, set)).toBe(true);
        expect(sent(PASSWORD) || sent(NEXT)).toBe(false);
        expect(state.hashed).not.toContain(NEXT);

        // The old hash route opens with neither password now.
        const hash = state.credentials.get(alice.id)!;
        expect(hash).not.toBe(`scrypt:${PASSWORD}`);
        expect(hash).not.toBe(`scrypt:${NEXT}`);

        // The new password signs in over OPAQUE; the old one does not.
        state.sessionUser = null;
        expect(await client.signInWithOpaque(alice.email, NEXT)).toEqual({ challenged: false });
        expect(await client.signInWithOpaque(alice.email, PASSWORD)).toBeNull();
        await client.backgroundIdle();
    });

    it("refuses a password that breaks a rule before anything is sent", async () => {
        const alice = await adoptedAccount();
        for (const [password, problem] of [
            ["short", "length"],
            ["x".repeat(257), "length"],
            ["alice@example.com!!", "identity"]
        ] as const) {
            await expect(
                flows.prepareNewPassword(password, { name: "Alice Example", email: alice.email })
            ).rejects.toMatchObject({ name: "PasswordRuleError", problem });
        }
        expect(state.bodies).toEqual([]);
    });

    it("a set made for one account cannot be committed on another, nor twice", async () => {
        const alice = await adoptedAccount();
        const set = await flows.prepareNewPassword(NEXT, { email: alice.email });
        const mallory = account("mallory@example.com", PASSWORD);
        expect(await server.setPasswordOverOpaque(mallory.id, set)).toBe(false);
        expect(state.credentials.get(mallory.id)).toBe(`scrypt:${PASSWORD}`);
        // The refused attempt spent it.
        expect(await server.setPasswordOverOpaque(alice.id, set)).toBe(false);
        expect(state.credentials.get(alice.id)).toBe(`scrypt:${PASSWORD}`);
    });

    it("a set with no finish, or a forged one, changes nothing", async () => {
        const alice = await adoptedAccount();
        const set = await flows.prepareNewPassword(NEXT, { email: alice.email });
        expect(await server.setPasswordOverOpaque(alice.id, { loginId: set.loginId })).toBe(false);
        const again = await flows.prepareNewPassword(NEXT, { email: alice.email });
        expect(
            await server.setPasswordOverOpaque(alice.id, { loginId: again.loginId, finishLoginRequest: "A".repeat(86) })
        ).toBe(false);
        expect(state.credentials.get(alice.id)).toBe(`scrypt:${PASSWORD}`);
        // The account still signs in exactly as before.
        state.sessionUser = null;
        expect(await client.signInWithOpaque(alice.email, PASSWORD)).toEqual({ challenged: false });
        await client.backgroundIdle();
    });

    it("a worker that does not start means the old action, with nothing sent", async () => {
        const alice = await adoptedAccount();
        worker.down = true;
        await expect(flows.provePassword(PASSWORD)).rejects.toBeInstanceOf(flows.PasswordFlowUnavailable);
        await expect(flows.prepareNewPassword(NEXT, { email: alice.email })).rejects.toBeInstanceOf(
            flows.PasswordFlowUnavailable
        );
        expect(state.bodies).toEqual([]);
    });

    it("an old client's reset, which writes a real hash again, retires the OPAQUE record", async () => {
        const alice = await adoptedAccount();
        const set = await flows.prepareNewPassword(NEXT, { email: alice.email });
        expect(await server.setPasswordOverOpaque(alice.id, set)).toBe(true);
        state.credentials.set(alice.id, "scrypt:reset by an old client");
        state.sessionUser = null;
        expect(await client.signInWithOpaque(alice.email, NEXT)).toBeNull();
    });
});

describe("the kill switch never locks anybody out", () => {
    /** Alice changed her password over OPAQUE, so no hash opens her account;
     *  then the switch is thrown. */
    async function onlyOnOpaque(): Promise<UserRow> {
        const alice = await adoptedAccount();
        const set = await flows.prepareNewPassword(NEXT, { email: alice.email });
        expect(await server.setPasswordOverOpaque(alice.id, set)).toBe(true);
        process.env.POLARIS_INTERNAL_PASSWORD_LOCK = "0";
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        state.bodies.length = 0;
        return alice;
    }

    it("an account whose password was set over OPAQUE still signs in with it", async () => {
        const alice = await onlyOnOpaque();
        state.sessionUser = null;
        expect(await client.signInWithOpaque(alice.email, NEXT)).toEqual({ challenged: false });
        expect(state.issued.at(-1)).toEqual({ userId: alice.id, challenged: false });
        expect(sent(NEXT)).toBe(false);
        expect(await client.signInWithOpaque(alice.email, "not the password at all")).toBeNull();
        await client.backgroundIdle();

        // A second factor is still asked for.
        state.twoFactor.add(alice.id);
        expect(await client.signInWithOpaque(alice.email, NEXT)).toEqual({ challenged: true });
    });

    it("its proofs and a new password keep working", async () => {
        const alice = await onlyOnOpaque();
        expect(await flows.opaquePasswordReady()).toEqual({ name: "Alice Example", email: alice.email });
        const proof = await flows.provePassword(NEXT);
        expect(await server.provesPassword(alice.id, proof)).toBe(true);
        const third = "a third staple of 2026";
        const set = await flows.prepareNewPassword(third, { email: alice.email });
        expect(await server.setPasswordOverOpaque(alice.id, set)).toBe(true);
        expect(sent(NEXT) || sent(third)).toBe(false);
        state.sessionUser = null;
        expect(await client.signInWithOpaque(alice.email, third)).toEqual({ challenged: false });
        await client.backgroundIdle();
    });

    it("nobody new is moved onto OPAQUE, and an account not on it cannot sign in over it", async () => {
        await onlyOnOpaque();
        const bob = account("bob@example.com", PASSWORD);
        state.sessionUser = null;
        expect(await client.adoptOpaque(bob.email, PASSWORD)).toBe(false);
        expect(state.tables.records.has(bob.id)).toBe(false);
        for (const op of ["adopt-start", "adopt-finish", "verify-start", "verify-finish"])
            expect((await post("/api/e2ee/sign-in", { op })).status).toBe(404);
        // The start answers like any address, and can never finish.
        expect(await client.signInWithOpaque(bob.email, PASSWORD)).toBeNull();
        expect(state.issued.some((issued) => issued.userId === bob.id)).toBe(false);
        expect(state.credentials.get(bob.id)).toBe(`scrypt:${PASSWORD}`);
    });

    it("the sign-in stays rate limited", async () => {
        const alice = await onlyOnOpaque();
        state.sessionUser = null;
        state.limitCap = 0;
        expect(await client.signInWithOpaque(alice.email, NEXT)).toBeNull();
        expect([...state.limits.keys()]).toContain(`e2ee-sign-in:${alice.email}`);
    });
});
