/**
 * The move of every password account onto OPAQUE, end to end: the browser half
 * (`sign-in-client.ts`) talking to the real route handlers, real OPAQUE on both
 * sides at the real Argon2id profile, over an in-memory database.
 *
 * What is pinned is the owner's rule for the transition: an account keeps
 * signing in with its password exactly as before, moves to OPAQUE on its next
 * successful sign-in, and can never be locked out by the move - an interrupted
 * or racing adoption, a password reset, a replaced master key all fall back to
 * the old sign-in, and accounts without a password are never touched. With the
 * internal flag off nothing here exists at all.
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
    sessionUser: null as { id: string } | null,
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
        $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
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
                hash: async (password: string) => `scrypt:${password}`,
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
    state.limitCap = Number.POSITIVE_INFINITY;
    state.sessionUser = null;
    service.resetServerSetupCache();
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        post(url, init.body as string, (init.headers as Record<string, string>)["content-type"])
    );
});

afterEach(() => {
    delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
    delete process.env.POLARIS_INTERNAL_PASSWORD_LOCK;
    vi.unstubAllGlobals();
});

describe("the switches", () => {
    it("has the password lock on with nothing set, and passkey locks still behind the chat flag", async () => {
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        const { chatE2eeEnabled, passwordLockEnabled } = await import("@/lib/chat/e2ee/flag");
        expect(chatE2eeEnabled()).toBe(false);
        expect(passwordLockEnabled()).toBe(true);
        // The sign-in route exists: a malformed body is a 400, not a 404.
        expect((await post("/api/e2ee/sign-in", { op: "sign-in-start" })).status).toBe(400);
        const alice = account("alice@example.com", "correct horse battery");
        state.sessionUser = { id: alice.id };
        expect((await post("/api/e2ee/keys", { op: "state" })).status).toBe(200);
        // Passkey locks are not part of the password lock.
        const passkey = await post("/api/e2ee/keys", { op: "delete-passkey-lock", lockId: "x".repeat(22) });
        expect([400, 404]).toContain(passkey.status);
        expect(passkey.status).not.toBe(200);
    });

    it("the kill switch takes both routes away and the form signs in the old way", async () => {
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        const alice = account("alice@example.com", "correct horse battery");
        expect(await client.adoptOpaque(alice.email, "correct horse battery")).toBe(true);
        process.env.POLARIS_INTERNAL_PASSWORD_LOCK = "0";
        const { passwordLockEnabled } = await import("@/lib/chat/e2ee/flag");
        expect(passwordLockEnabled()).toBe(false);
        expect((await post("/api/e2ee/sign-in", { op: "sign-in-start" })).status).toBe(404);
        state.sessionUser = { id: alice.id };
        expect((await post("/api/e2ee/keys", { op: "state" })).status).toBe(404);
        // An account already moved: OPAQUE answers nothing, the old route still has its hash.
        expect(await client.signInWithOpaque(alice.email, "correct horse battery")).toBeNull();
        expect(state.issued).toEqual([]);
        expect(state.credentials.get(alice.id)).toBe("scrypt:correct horse battery");
        expect(await client.adoptOpaque(alice.email, "correct horse battery")).toBe(false);
    });

    it("a worker that does not start leaves the old way running and the account unmoved", async () => {
        const alice = account("alice@example.com", "correct horse battery");
        worker.down = true;
        expect(await client.signInWithOpaque(alice.email, "correct horse battery")).toBeNull();
        expect(await client.adoptOpaque(alice.email, "correct horse battery")).toBe(false);
        expect(state.tables.records.get(alice.id)).toBeUndefined();
        expect(state.credentials.get(alice.id)).toBe("scrypt:correct horse battery");
        // Next sign-in, with a working worker, moves it.
        worker.down = false;
        expect(await client.adoptOpaque(alice.email, "correct horse battery")).toBe(true);
        expect(await client.signInWithOpaque(alice.email, "correct horse battery")).toEqual({ challenged: false });
    });
});

describe("in the background", { timeout: 300_000 }, () => {
    it("adopts without holding the sign-in, and the next sign-in is over OPAQUE", async () => {
        const alice = account("alice@example.com", "correct horse battery");
        let settled = false;
        const queued = client.adoptInBackground(alice.email, "correct horse battery", true).then(() => {
            settled = true;
        });
        // The call hands back at once; the work finishes behind it.
        expect(settled).toBe(false);
        await queued;
        await client.backgroundIdle();
        expect(state.tables.records.get(alice.id)?.verifiedAt).toBeInstanceOf(Date);
        expect(state.tables.records.get(alice.id)?.ksfVersion).toBe(2);
        expect(await client.signInWithOpaque(alice.email, "correct horse battery")).toEqual({ challenged: false });
    });

    it("a background adoption that fails never throws, and is retried next time", async () => {
        const bob = account("bob@example.com", "a long passphrase");
        worker.down = true;
        await expect(client.adoptInBackground(bob.email, "a long passphrase", true)).resolves.toBeUndefined();
        worker.down = false;
        expect(await client.signInWithOpaque(bob.email, "a long passphrase")).toBeNull();
        await client.adoptInBackground(bob.email, "a long passphrase", true);
        expect(await client.signInWithOpaque(bob.email, "a long passphrase")).toEqual({ challenged: false });
    });

    it("a record made with profile v1 keeps signing in", async () => {
        const carol = account("carol@example.com", "an older record");
        const opaque = await import("@serenity-kit/opaque");
        const { PASSWORD_KSF_V1 } = await import("@polaris/chat-crypto/password-lock");
        await opaque.ready;
        const started = opaque.client.startRegistration({ password: "an older record" });
        const answered = (await (await post("/api/e2ee/sign-in", {
            op: "adopt-start",
            email: carol.email,
            registrationRequest: started.registrationRequest
        })).json()) as { userId: string; registrationResponse: string };
        const made = opaque.client.finishRegistration({
            clientRegistrationState: started.clientRegistrationState,
            registrationResponse: answered.registrationResponse,
            password: "an older record",
            identifiers: { client: answered.userId },
            keyStretching: PASSWORD_KSF_V1
        });
        // A client from before v2 names no profile.
        const stored = await post("/api/e2ee/sign-in", {
            op: "adopt-finish",
            email: carol.email,
            password: "an older record",
            registrationRecord: made.registrationRecord
        });
        expect(stored.status).toBe(200);
        expect(state.tables.records.get(carol.id)?.ksfVersion).toBe(1);
        const row = state.tables.records.get(carol.id);
        if (row) row.verifiedAt = new Date();
        expect(await client.signInWithOpaque(carol.email, "an older record")).toEqual({ challenged: false });
    });
});

describe("the move to OPAQUE", { timeout: 300_000 }, () => {
    it("leaves an existing account on its password until it adopts, then signs in over OPAQUE", async () => {
        const alice = account("alice@example.com", "correct horse battery");
        // Before: nothing to sign in with yet, so the form falls back to the old way.
        expect(await client.signInWithOpaque(alice.email, "correct horse battery")).toBeNull();
        expect(state.issued).toEqual([]);
        // The old sign-in succeeded; the form adopts while it holds the password.
        expect(await client.adoptOpaque(alice.email, "correct horse battery")).toBe(true);
        expect(state.tables.records.get(alice.id)?.verifiedAt).toBeInstanceOf(Date);
        // The old hash is untouched.
        expect(state.credentials.get(alice.id)).toBe("scrypt:correct horse battery");
        // After: OPAQUE signs in.
        expect(await client.signInWithOpaque(alice.email, "correct horse battery")).toEqual({ challenged: false });
        expect(state.issued).toEqual([{ userId: alice.id, challenged: false }]);
        // A wrong password issues nothing and falls back (and the old way refuses it).
        expect(await client.signInWithOpaque(alice.email, "wrong horse battery")).toBeNull();
        expect(state.issued).toHaveLength(1);
    });

    it("keeps the second-factor challenge for an account that has one", async () => {
        const bob = account("bob@example.com", "a long passphrase");
        state.twoFactor.add(bob.id);
        expect(await client.adoptOpaque(bob.email, "a long passphrase")).toBe(true);
        expect(await client.signInWithOpaque(bob.email, "a long passphrase")).toEqual({ challenged: true });
    });

    it("an interrupted adoption leaves the account on its password and finishes next time", async () => {
        const carol = account("carol@example.com", "interrupted pass");
        // Record stored, verification never ran (tab closed, network gone).
        const opaqueClient = await import("@polaris/chat-crypto/password-lock");
        const started = await opaqueClient.startPasswordRegistration("interrupted pass");
        const answered = (await (await post("/api/e2ee/sign-in", {
            op: "adopt-start",
            email: carol.email,
            registrationRequest: started.registrationRequest
        })).json()) as { userId: string; registrationResponse: string };
        const made = await opaqueClient.finishPasswordRegistration({
            state: started.state,
            registrationResponse: answered.registrationResponse,
            password: "interrupted pass",
            userId: answered.userId
        });
        const stored = await post("/api/e2ee/sign-in", {
            op: "adopt-finish",
            email: carol.email,
            password: "interrupted pass",
            registrationRecord: made.registrationRecord,
            ksfVersion: made.ksfVersion
        });
        expect(stored.status).toBe(200);
        expect(state.tables.records.get(carol.id)?.verifiedAt).toBeNull();
        // An unverified record never signs in: the old way runs.
        expect(await client.signInWithOpaque(carol.email, "interrupted pass")).toBeNull();
        // Next sign-in adopts again and completes.
        expect(await client.adoptOpaque(carol.email, "interrupted pass")).toBe(true);
        expect(await client.signInWithOpaque(carol.email, "interrupted pass")).toEqual({ challenged: false });
    });

    it("two sign-ins adopting at once end with one working record", async () => {
        const dan = account("dan@example.com", "racing passwords");
        const results = await Promise.all([
            client.adoptOpaque(dan.email, "racing passwords"),
            client.adoptOpaque(dan.email, "racing passwords")
        ]);
        expect(results).toContain(true);
        expect(await client.signInWithOpaque(dan.email, "racing passwords")).toEqual({ challenged: false });
        // A later adoption never replaces the verified record in use.
        const before = state.tables.records.get(dan.id)?.record;
        expect(await client.adoptOpaque(dan.email, "racing passwords")).toBe(true);
        expect(state.tables.records.get(dan.id)?.record).toBe(before);
    });

    it("a password reset retires the record: the old password stops, the new one adopts", async () => {
        const erin = account("erin@example.com", "the old password");
        expect(await client.adoptOpaque(erin.email, "the old password")).toBe(true);
        // Any reset path rewrites the better-auth hash; nothing else is told.
        state.credentials.set(erin.id, "scrypt:the new password");
        expect(await client.signInWithOpaque(erin.email, "the old password")).toBeNull();
        expect(await client.signInWithOpaque(erin.email, "the new password")).toBeNull();
        expect(await client.adoptOpaque(erin.email, "the new password")).toBe(true);
        expect(await client.signInWithOpaque(erin.email, "the new password")).toEqual({ challenged: false });
        expect(await client.signInWithOpaque(erin.email, "the old password")).toBeNull();
    });

    it("never touches an account without a password (passkey, emailed link, connection)", async () => {
        const fran = account("fran@example.com", null);
        expect(await client.adoptOpaque(fran.email, "anything at all")).toBe(false);
        expect(state.tables.records.size).toBe(0);
        expect(await client.signInWithOpaque(fran.email, "anything at all")).toBeNull();
        expect(state.issued).toEqual([]);
    });

    it("a replaced master key drops every record and the old sign-in carries on", async () => {
        const gus = account("gus@example.com", "master key test");
        expect(await client.adoptOpaque(gus.email, "master key test")).toBe(true);
        state.masterKey = Buffer.alloc(32, 9).toString("base64");
        service.resetServerSetupCache();
        expect(await client.signInWithOpaque(gus.email, "master key test")).toBeNull();
        expect(state.tables.records.size).toBe(0);
        expect(await client.adoptOpaque(gus.email, "master key test")).toBe(true);
        expect(await client.signInWithOpaque(gus.email, "master key test")).toEqual({ challenged: false });
        state.masterKey = Buffer.alloc(32, 7).toString("base64");
    });
});

describe("the routes, as a hostile caller sees them", { timeout: 300_000 }, () => {
    it("answers an unknown address exactly like a known one", async () => {
        account("known@example.com", "pass phrase one");
        const opaqueClient = await import("@polaris/chat-crypto/password-lock");
        const shapes: string[] = [];
        for (const email of ["known@example.com", "nobody@example.com"]) {
            const started = await opaqueClient.startPasswordLogin("pass phrase one");
            const response = await post("/api/e2ee/sign-in", {
                op: "sign-in-start",
                email,
                startLoginRequest: started.startLoginRequest
            });
            expect(response.status).toBe(200);
            const body = (await response.json()) as Record<string, string>;
            shapes.push(`${Object.keys(body).sort().join(",")}:${body.loginResponse!.length}`);
            expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(shapes[0]).toBe(shapes[1]);
    });

    it("a login state is single use, and a finish replayed is refused", async () => {
        const hal = account("hal@example.com", "single use pass");
        expect(await client.adoptOpaque(hal.email, "single use pass")).toBe(true);
        const opaqueClient = await import("@polaris/chat-crypto/password-lock");
        const started = await opaqueClient.startPasswordLogin("single use pass");
        const step = (await (await post("/api/e2ee/sign-in", {
            op: "sign-in-start",
            email: hal.email,
            startLoginRequest: started.startLoginRequest
        })).json()) as { loginId: string; loginResponse: string; userId: string; ksfVersion: 1 | 2 };
        const finished = await opaqueClient.finishPasswordLogin({
            state: started.state,
            loginResponse: step.loginResponse,
            password: "single use pass",
            userId: step.userId,
            ksfVersion: step.ksfVersion
        });
        const finish = { op: "sign-in-finish", loginId: step.loginId, finishLoginRequest: finished.finishLoginRequest };
        expect((await post("/api/e2ee/sign-in", finish)).status).toBe(200);
        expect((await post("/api/e2ee/sign-in", finish)).status).toBe(401);
        expect(state.issued).toHaveLength(1);
    });

    it("refuses a body not sent as JSON, a malformed one, and too many attempts", async () => {
        account("ivy@example.com", "rate limited pass");
        const body = { op: "sign-in-start", email: "ivy@example.com", startLoginRequest: "A".repeat(40) };
        expect((await post("/api/e2ee/sign-in", body, "text/plain")).status).toBe(400);
        expect((await post("/api/e2ee/sign-in", { op: "sign-in-start", email: "x" })).status).toBe(400);
        state.limitCap = 0;
        expect((await post("/api/e2ee/sign-in", body)).status).toBe(429);
    });

    it("never releases the password envelope without a password proof, and never another account's", async () => {
        const jo = account("jo@example.com", "envelope owner");
        const kim = account("kim@example.com", "someone else");
        expect(await client.adoptOpaque(jo.email, "envelope owner")).toBe(true);
        expect(await client.adoptOpaque(kim.email, "someone else")).toBe(true);
        state.tables.keys.set(jo.id, { userId: jo.id, akVersion: 1, signPublicKey: new Uint8Array(32), hpkePublicKey: new Uint8Array(1216) });
        state.tables.locks.set(`${jo.id}|password|password`, { userId: jo.id, kind: "password", lockId: "password", akVersion: 1, envelope: new Uint8Array(82).fill(1) });
        // No session: the keys route refuses outright.
        expect((await post("/api/e2ee/keys", { op: "state" })).status).toBe(401);
        // Jo's session: the state lists no password envelope bytes at all.
        state.sessionUser = { id: jo.id };
        const listed = (await (await post("/api/e2ee/keys", { op: "state" })).json()) as { accountKey: Record<string, unknown> };
        expect(listed.accountKey.hasPasswordLock).toBe(true);
        expect(JSON.stringify(listed)).not.toContain("AQEBAQEB");
        // Kim proves Kim's password, then tries to spend that login on Jo's session.
        const opaqueClient = await import("@polaris/chat-crypto/password-lock");
        state.sessionUser = { id: kim.id };
        const started = await opaqueClient.startPasswordLogin("someone else");
        const step = (await (await post("/api/e2ee/keys", { op: "unlock-start", startLoginRequest: started.startLoginRequest })).json()) as { loginId: string; loginResponse: string; userId: string; ksfVersion: 1 | 2 };
        const finished = await opaqueClient.finishPasswordLogin({ state: started.state, loginResponse: step.loginResponse, password: "someone else", userId: step.userId, ksfVersion: step.ksfVersion });
        state.sessionUser = { id: jo.id };
        const stolen = await post("/api/e2ee/keys", { op: "unlock-finish", loginId: step.loginId, finishLoginRequest: finished.finishLoginRequest });
        expect(stolen.status).toBe(401);
        // Jo's own proof on Jo's session is what releases it.
        const own = await opaqueClient.startPasswordLogin("envelope owner");
        const ownStep = (await (await post("/api/e2ee/keys", { op: "unlock-start", startLoginRequest: own.startLoginRequest })).json()) as { loginId: string; loginResponse: string; userId: string; ksfVersion: 1 | 2 };
        const ownFinished = await opaqueClient.finishPasswordLogin({ state: own.state, loginResponse: ownStep.loginResponse, password: "envelope owner", userId: ownStep.userId, ksfVersion: ownStep.ksfVersion });
        const released = (await (await post("/api/e2ee/keys", { op: "unlock-finish", loginId: ownStep.loginId, finishLoginRequest: ownFinished.finishLoginRequest })).json()) as { passwordLock: { akVersion: number } | null };
        expect(released.passwordLock?.akVersion).toBe(1);
    });

    it("withholds the envelope from a sign-in still owing its second factor", async () => {
        const lee = account("lee@example.com", "second factor owed");
        state.twoFactor.add(lee.id);
        expect(await client.adoptOpaque(lee.email, "second factor owed")).toBe(true);
        state.tables.keys.set(lee.id, { userId: lee.id, akVersion: 1 });
        state.tables.locks.set(`${lee.id}|password|password`, { userId: lee.id, kind: "password", lockId: "password", akVersion: 1, envelope: new Uint8Array(82).fill(1) });
        const responses: unknown[] = [];
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            const response = await realFetch(url, init);
            responses.push(await response.clone().json());
            return response;
        });
        expect(await client.signInWithOpaque(lee.email, "second factor owed")).toEqual({ challenged: true });
        expect(responses.at(-1)).toEqual({ challenged: true, passwordLock: null });
    });

    it("refuses a sign-in whose password changed between its two steps", async () => {
        const max = account("max@example.com", "changing midway");
        expect(await client.adoptOpaque(max.email, "changing midway")).toBe(true);
        const opaqueClient = await import("@polaris/chat-crypto/password-lock");
        const started = await opaqueClient.startPasswordLogin("changing midway");
        const step = (await (await post("/api/e2ee/sign-in", { op: "sign-in-start", email: max.email, startLoginRequest: started.startLoginRequest })).json()) as { loginId: string; loginResponse: string; userId: string; ksfVersion: 1 | 2 };
        const finished = await opaqueClient.finishPasswordLogin({ state: started.state, loginResponse: step.loginResponse, password: "changing midway", userId: step.userId, ksfVersion: step.ksfVersion });
        state.credentials.set(max.id, "scrypt:reset by an administrator");
        const response = await post("/api/e2ee/sign-in", { op: "sign-in-finish", loginId: step.loginId, finishLoginRequest: finished.finishLoginRequest });
        expect(response.status).toBe(401);
        expect(state.issued).toEqual([]);
    });
});
