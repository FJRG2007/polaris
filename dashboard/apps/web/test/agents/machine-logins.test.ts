/**
 * An agent signed in on the sessions' machine is an ordinary connection row:
 * written once however many reads race to write it, skipped by the rotation
 * while it is switched off, and handed to a session as nothing at all - the
 * tool uses the login already on the machine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000aa";
const STORED = "agent-signin-claude-code-oauth-token";
const MACHINE = "agent-signin-claude-home-login";
const MACHINE_ENV = "CLAUDE_HOME_LOGIN";

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
    secretFingerprint: string | null;
}

const db = vi.hoisted(() => ({ keys: [] as KeyRow[], creates: 0 }));

/** Enough of Prisma's `where` for these reads: equality, `in`, OR and AND. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([field, wanted]) => {
        if (field === "OR") return (wanted as Record<string, unknown>[]).some((one) => matches(row, one));
        if (field === "AND") return (wanted as Record<string, unknown>[]).every((one) => matches(row, one));
        if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
            const condition = wanted as { in?: unknown[]; gt?: unknown };
            if (condition.in) return condition.in.includes(row[field]);
            // A date bound: the fixtures never expire.
            return true;
        }
        return row[field] === wanted;
    });
}

function clash(target: string[]): Error {
    return Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                db.keys.find((row) => matches(row as unknown as Record<string, unknown>, where)) ?? null,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                db.keys
                    .filter((row) => matches(row as unknown as Record<string, unknown>, where))
                    .sort((x, y) => x.priority - y.priority)
                    .map((row) => ({ ...row })),
            create: async ({ data }: { data: KeyRow }) => {
                // Yields first, so two reads started together both get here.
                await Promise.resolve();
                if (db.keys.some((row) => row.userId === data.userId && row.name === data.name))
                    throw clash(["userId", "name"]);
                if (
                    db.keys.some(
                        (row) =>
                            row.userId === data.userId &&
                            row.provider === data.provider &&
                            row.secretFingerprint === data.secretFingerprint
                    )
                )
                    throw clash(["userId", "provider", "secretFingerprint"]);
                db.creates += 1;
                const row: KeyRow = {
                    ...data,
                    id: `row-${db.keys.length + 1}`,
                    createdAt: new Date(),
                    enabled: true,
                    expiresAt: null,
                    coolingUntil: null,
                    coolingReason: null
                };
                db.keys.push(row);
                return row;
            }
        }
    }
}));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/agents/signin-runtime", () => ({
    homeSigninSlugs: (cli: string) => (cli === "claude" ? [MACHINE] : [])
}));
vi.mock("@/lib/agents/session-service", () => ({ addSessionMessage: async () => undefined }));
vi.mock("@/lib/agents/session-runtime", () => ({
    queueTurnAgain: async () => true,
    moveAgentToAccount: async () => "next-turn",
    promptMovedAgent: async () => true
}));
vi.mock("@/lib/agents/model-keys", () => ({ instanceKeysAreShared: async () => false }));

const rows = await import("@/lib/agents/machine-login-rows");
const logins = await import("@/lib/agents/machine-logins");
const rotation = await import("@/lib/agents/account-rotation");
const { sessionCredentials } = await import("@/lib/agents/agent-readiness");
const core = await import("@polaris/core");

const SIGNIN = { env: MACHINE_ENV, slug: MACHINE, label: "Claude Code" };

function stored(id: string, priority: number, extra: Partial<KeyRow> = {}): KeyRow {
    return {
        id,
        userId: OWNER,
        provider: STORED,
        name: `Account ${id}`,
        config: JSON.stringify({ email: `${id}@example.test` }),
        priority,
        createdAt: new Date(priority),
        enabled: true,
        expiresAt: null,
        coolingUntil: null,
        coolingReason: null,
        secretFingerprint: `fp-${id}`,
        ...extra
    };
}

beforeEach(() => {
    db.keys = [];
    db.creates = 0;
});

describe("ensureMachineLogins", () => {
    it("writes one row per agent at the end of the order, holding no secret", async () => {
        db.keys.push(stored("a", 0));
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        const machine = db.keys.find((row) => row.provider === MACHINE)!;
        expect(machine.name).toBe("Claude Code login");
        expect(machine.priority).toBe(1);
        expect(JSON.parse(machine.config)).toEqual({ machineLogin: MACHINE_ENV });
        expect(machine.secretFingerprint).toBe(`machine-login:${MACHINE_ENV}`);
        expect((machine as unknown as { encryptedSecret: Uint8Array }).encryptedSecret.length).toBe(0);
    });

    it("is idempotent, and two reads racing write it once", async () => {
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        db.keys = [];
        db.creates = 0;
        await Promise.all([rows.ensureMachineLogins(OWNER, [SIGNIN]), rows.ensureMachineLogins(OWNER, [SIGNIN])]);
        expect(db.keys.filter((row) => row.provider === MACHINE)).toHaveLength(1);
        expect(db.creates).toBe(1);
    });

    it("leaves a renamed or switched-off row as it is", async () => {
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        Object.assign(db.keys[0]!, { name: "Laptop", enabled: false });
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        expect(db.keys).toHaveLength(1);
        expect(db.keys[0]).toMatchObject({ name: "Laptop", enabled: false });
    });

    it("takes the next free name when its own is used by another row", async () => {
        db.keys.push(stored("a", 0, { name: "Claude Code login" }));
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        expect(db.keys.find((row) => row.provider === MACHINE)?.name).toBe("Claude Code login 2");
    });
});

describe("rotation and launch", () => {
    it("moves between stored accounts and the machine login, skipping it while switched off", async () => {
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        const machineId = db.keys[0]!.id;
        db.keys.push(stored("a", 5));
        expect((await rotation.rotationAccounts(OWNER, "claude", "a")).map((one) => one.id)).toEqual([machineId, "a"]);
        db.keys[0]!.enabled = false;
        expect((await rotation.rotationAccounts(OWNER, "claude", "a")).map((one) => one.id)).toEqual(["a"]);
        expect((await rotation.rotationAccounts(OWNER, "claude", null)).map((one) => one.id)).toEqual(["a"]);
    });

    it("hands a session on the machine login nothing, and stops once it is switched off", async () => {
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        const machineId = db.keys[0]!.id;
        expect(await logins.machineLoginChosen(OWNER, "claude", machineId)).toBe(true);
        db.keys[0]!.enabled = false;
        expect(await logins.machineLoginChosen(OWNER, "claude", machineId)).toBe(false);
        // Not someone else's row.
        db.keys[0]!.enabled = true;
        expect(await logins.machineLoginChosen("someone-else", "claude", machineId)).toBe(false);

        const cli = core.agentCliById("claude")!;
        const secret = { env: "CLAUDE_CODE_OAUTH_TOKEN", secret: "fixture-token", apiKey: false, extra: {} };
        expect(sessionCredentials(cli, { CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" }, secret, true)).toEqual({});
    });

    it("uses the machine login with no account picked only when it is first in the order", async () => {
        db.keys.push(stored("a", 0));
        await rows.ensureMachineLogins(OWNER, [SIGNIN]);
        // Behind a stored account: the stored one is what the session gets.
        expect(await logins.machineLoginChosen(OWNER, "claude", null)).toBe(false);
        db.keys.find((row) => row.provider === MACHINE)!.priority = -1;
        expect(await logins.machineLoginChosen(OWNER, "claude", null)).toBe(true);
        // With no stored account to outrank, nothing changes.
        db.keys = db.keys.filter((row) => row.provider === MACHINE);
        expect(await logins.machineLoginChosen(OWNER, "claude", null)).toBe(false);
    });
});
