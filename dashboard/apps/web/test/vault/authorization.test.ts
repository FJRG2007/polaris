/**
 * Letting the extension in from a browser that is already inside the vault.
 *
 * The thing being tested is a credential handover, so the tests are about the ways
 * it must refuse: a code that was already answered, an approval with nothing
 * sealed into it, and above all a claim that could be spent twice - which is the
 * difference between a one-time approval and a password anybody watching the poll
 * could copy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    codeHash: string;
    userCode: string;
    publicKey: string;
    wrappedKey: string | null;
    status: string;
    userId: string | null;
    deviceIdentifier: string;
    deviceName: string;
    deviceType: number;
    requestIp: string | null;
    requestUserAgent: string | null;
    requestHost: string | null;
    extensionSessionId: string | null;
    expiresAt: Date;
    createdAt: Date;
}

/** A browser extension's connection to an account, as the two checks that read
 *  one need it: who it belongs to, and whether it has been ended. */
interface Connection {
    id: string;
    userId: string;
    revokedAt: Date | null;
}

let rows: Row[] = [];
let connections: Connection[] = [];
let nextId = 1;
/** Stand in the gap between the read that looks for a collision and the write that
 *  loses to one: the next lookup answers "free" for a code that is not. */
let missNextRead = false;

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [field, wanted] of Object.entries(where)) {
        const held = row[field as keyof Row];
        if (wanted && typeof wanted === "object" && "lt" in (wanted as object)) {
            if (!((held as Date) < (wanted as { lt: Date }).lt)) return false;
            continue;
        }
        if (wanted && typeof wanted === "object" && "gt" in (wanted as object)) {
            if (!((held as Date) > (wanted as { gt: Date }).gt)) return false;
            continue;
        }
        if (held !== wanted) return false;
    }
    return true;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultAuthorization: {
            create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
                // The unique index on the short code, which the database has and a
                // fake without it does not: leave it out and the retry that loses a
                // race to another opener is a path no test here can reach.
                if (rows.some((row) => row.userCode === data.userCode)) {
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                const row: Row = { id: `a${nextId++}`, createdAt: new Date(), ...data };
                rows.push(row);
                return row;
            },
            findUnique: async ({ where }: { where: Record<string, unknown> }) => {
                if (missNextRead) {
                    missNextRead = false;
                    return null;
                }
                return rows.find((row) => matches(row, where)) ?? null;
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<Row>;
            }) => {
                const hit = rows.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const before = rows.length;
                rows = rows.filter((row) => !matches(row, where));
                return { count: before - rows.length };
            }
        },
        extensionSession: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                connections.find((one) => one.id === where.id) ?? null
        }
    }
}));

const {
    answerVaultAuthorization,
    AUTHORIZATION_TTL_MS,
    claimVaultAuthorization,
    describeVaultAuthorization,
    formatUserCode,
    newUserCode,
    openVaultAuthorization,
    readUserCode
} = await import("@/lib/vault/authorization");

const NOW = new Date("2026-09-14T10:00:00Z");

/** Deterministic bytes, so a test can say which code comes out. */
function bytes(...values: number[]): (size: number) => Uint8Array {
    return (size) => {
        const out = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) out[index] = values[index % values.length]!;
        return out;
    };
}

const REQUEST = {
    publicKey: "PUBLIC-KEY-BASE64",
    deviceIdentifier: "extension-1",
    deviceName: "Polaris for Chrome",
    deviceType: 2,
    requestIp: "203.0.113.7",
    requestUserAgent: "Chrome",
    requestHost: "polaris.example"
} as const;

/** One draw after another, so a test can say what the second attempt picks. The
 *  last is repeated, which is how a run of collisions is written. */
function draws(...picks: number[][]): (size: number) => Uint8Array {
    let at = 0;
    return (size) => {
        const values = picks[Math.min(at, picks.length - 1)]!;
        at += 1;
        const out = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) out[index] = values[index % values.length]!;
        return out;
    };
}

beforeEach(() => {
    rows = [];
    connections = [];
    nextId = 1;
    missNextRead = false;
});

describe("the code somebody reads off the popup", () => {
    it("draws every character from the alphabet", () => {
        const code = newUserCode(bytes(0, 1, 2, 3, 4, 5, 6, 7));
        expect(code).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ23456789]{8}$/);
    });

    it("leaves out the characters people mistype", () => {
        // No vowels, so nothing spells a word to be read aloud; and none of 0/O or
        // 1/I/L, which is what gets typed wrong between two screens.
        let seen = "";
        for (let value = 0; value < 28; value += 1) seen += newUserCode(bytes(value))[0];
        expect(seen).not.toMatch(/[AEIOU01IL]/);
    });

    it("is read back through whatever separators it was shown with", () => {
        const code = newUserCode(bytes(3, 9, 14, 2, 7, 21, 5, 11));
        expect(readUserCode(formatUserCode(code))).toBe(code);
        expect(readUserCode(` ${code.slice(0, 4)} ${code.slice(4)} `)).toBe(code);
        expect(readUserCode(code.toLowerCase())).toBe(code);
    });

    it("refuses anything that is not one", () => {
        expect(readUserCode("")).toBeNull();
        expect(readUserCode("ABC")).toBeNull();
        // A vowel cannot be in one, so a word is not a near miss - it is not a code.
        expect(readUserCode("PASSWORD")).toBeNull();
        expect(readUserCode("BCDFGHJK9")).toBeNull();
    });
});

describe("opening a request", () => {
    it("hands back a code to show and a secret to poll with", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(1), NOW);
        expect(opened.userCode).toHaveLength(8);
        expect(opened.deviceCode.length).toBeGreaterThan(32);
        expect(opened.expiresAt.getTime()).toBe(NOW.getTime() + AUTHORIZATION_TTL_MS);
    });

    it("never stores the polling secret as it was handed out", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(1), NOW);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.codeHash).not.toBe(opened.deviceCode);
        expect(JSON.stringify(rows[0])).not.toContain(opened.deviceCode);
    });

    it("clears out the requests nobody answered", async () => {
        rows.push({
            ...REQUEST,
            id: "old",
            codeHash: "old",
            userCode: "OLDCODE1",
            wrappedKey: null,
            status: "pending",
            userId: null,
            extensionSessionId: null,
            expiresAt: new Date(NOW.getTime() - 1000),
            createdAt: new Date(NOW.getTime() - 600_000)
        });
        await openVaultAuthorization(REQUEST, bytes(1), NOW);
        expect(rows.some((row) => row.id === "old")).toBe(false);
    });

    it("draws again when another opener took the code between the read and the write", async () => {
        // Two opens can pick the same code at once: the read tells both it is
        // free and the index refuses the second write. That refusal is what the
        // retry is for, so it draws another code - rather than escaping as a
        // failure the extension can neither read nor do anything about.
        const first = await openVaultAuthorization(REQUEST, draws([1]), NOW);
        missNextRead = true;
        const second = await openVaultAuthorization(REQUEST, draws([1], [2]), NOW);
        expect(second).not.toBeNull();
        expect(second!.userCode).not.toBe(first!.userCode);
        expect(rows).toHaveLength(2);
    });

    it("gives up with an answer rather than an exception", async () => {
        // Every draw already taken. Null is a refusal the caller turns into
        // something the client understands; a throw reached it as a 500.
        await openVaultAuthorization(REQUEST, draws([1]), NOW);
        expect(await openVaultAuthorization(REQUEST, draws([1]), NOW)).toBeNull();
        expect(rows).toHaveLength(1);
    });
});

describe("what the person approving is shown", () => {
    it("describes a waiting request, with the key to seal to", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(2), NOW);
        const pending = await describeVaultAuthorization(opened.userCode, NOW);
        expect(pending?.device).toBe("Polaris for Chrome");
        expect(pending?.publicKey).toBe("PUBLIC-KEY-BASE64");
        expect(pending?.host).toBe("polaris.example");
    });

    it("says nothing about a code that is not waiting", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(2), NOW);
        // Unknown, expired and already answered are one answer: a code is short
        // enough to guess at, and three different answers would say which guesses
        // were close.
        expect(await describeVaultAuthorization("BCDFGHJK", NOW)).toBeNull();
        expect(
            await describeVaultAuthorization(
                opened.userCode,
                new Date(NOW.getTime() + AUTHORIZATION_TTL_MS + 1)
            )
        ).toBeNull();
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: false },
            NOW
        );
        expect(await describeVaultAuthorization(opened.userCode, NOW)).toBeNull();
    });
});

describe("answering it", () => {
    it("refuses to approve without the sealed key", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(3), NOW);
        const result = await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true },
            NOW
        );
        // A row marked approved with nothing sealed in it is a client let in that
        // can read nothing - which looks like success and is worse than a refusal.
        expect(result.error).toBeTruthy();
        expect(rows[0]!.status).toBe("pending");
    });

    it("takes an approval once", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(3), NOW);
        expect(
            await answerVaultAuthorization(
                { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
                NOW
            )
        ).toEqual({});
        // The second dashboard to press it finds nothing waiting.
        const again = await answerVaultAuthorization(
            { userId: "u2", userCode: opened.userCode, approve: true, wrappedKey: "OTHER" },
            NOW
        );
        expect(again.error).toBeTruthy();
        expect(rows[0]!.userId).toBe("u1");
        expect(rows[0]!.wrappedKey).toBe("SEALED");
    });

    it("will not answer a request that has run out", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(3), NOW);
        const late = await answerVaultAuthorization(
            {
                userId: "u1",
                userCode: opened.userCode,
                approve: true,
                wrappedKey: "SEALED"
            },
            new Date(NOW.getTime() + AUTHORIZATION_TTL_MS + 1)
        );
        expect(late.error).toBeTruthy();
    });
});

describe("spending it", () => {
    it("keeps the extension waiting while nobody has answered", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(4), NOW);
        expect(await claimVaultAuthorization(opened.deviceCode, NOW)).toEqual({
            status: "pending"
        });
    });

    it("hands over the sealed key and the device it was asked for", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(4), NOW);
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        const claim = await claimVaultAuthorization(opened.deviceCode, NOW);
        expect(claim.status).toBe("approved");
        expect(claim.claimed?.userId).toBe("u1");
        expect(claim.claimed?.wrappedKey).toBe("SEALED");
        expect(claim.claimed?.device).toEqual({
            identifier: "extension-1",
            name: "Polaris for Chrome",
            type: 2
        });
    });

    it("cannot be spent twice", async () => {
        // The one that matters. A claim that answered twice would be a credential
        // anybody who saw the poll could take their own copy of.
        const opened = await openVaultAuthorization(REQUEST, bytes(4), NOW);
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        expect((await claimVaultAuthorization(opened.deviceCode, NOW)).status).toBe("approved");
        expect((await claimVaultAuthorization(opened.deviceCode, NOW)).status).toBe("expired");
        expect(rows).toHaveLength(0);
    });

    it("reports a refusal once and forgets it", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(4), NOW);
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: false },
            NOW
        );
        expect((await claimVaultAuthorization(opened.deviceCode, NOW)).status).toBe("denied");
        expect(rows).toHaveLength(0);
    });

    it("tells an unknown secret nothing about why", async () => {
        expect(await claimVaultAuthorization("not-a-code", NOW)).toEqual({ status: "expired" });
    });

    it("does not hand over an approval that sat too long", async () => {
        const opened = await openVaultAuthorization(REQUEST, bytes(4), NOW);
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        const late = await claimVaultAuthorization(
            opened.deviceCode,
            new Date(NOW.getTime() + AUTHORIZATION_TTL_MS + 1)
        );
        expect(late.status).toBe("expired");
        expect(rows).toHaveLength(0);
    });
});

/**
 * A request the browser extension opened under its connection to an account.
 *
 * The connection is what ties the vault client to something that can be ended:
 * ending it revokes the vault tokens it let in. That only holds if the
 * connection is checked at both ends of the exchange - when somebody approves,
 * and again when the extension collects - because the two are minutes apart and
 * a disconnection in between is exactly the case this exists for.
 */
describe("a request that came from a connected extension", () => {
    const FROM_EXTENSION = { ...REQUEST, extensionSessionId: "connection-1" } as const;

    async function waiting(): Promise<{ userCode: string; deviceCode: string }> {
        connections.push({ id: "connection-1", userId: "u1", revokedAt: null });
        return openVaultAuthorization(FROM_EXTENSION, bytes(5), NOW);
    }

    it("is refused by an account the extension is not connected as", async () => {
        const opened = await waiting();
        const answered = await answerVaultAuthorization(
            { userId: "u2", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        expect(answered.error).toBeTruthy();
        expect(rows[0]!.status).toBe("pending");
    });

    it("cannot be approved once the connection has been ended", async () => {
        const opened = await waiting();
        connections[0]!.revokedAt = NOW;
        const answered = await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        expect(answered.error).toBeTruthy();
        expect(rows[0]!.status).toBe("pending");
    });

    it("cannot be collected once the connection has been ended", async () => {
        // The window this closes: approved while the connection stood, collected
        // after somebody disconnected it. The token minted from that claim would
        // be bound to a connection nothing can end again, which is the one thing
        // ending a connection is supposed to make impossible.
        const opened = await waiting();
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        connections[0]!.revokedAt = NOW;
        const claim = await claimVaultAuthorization(opened.deviceCode, NOW);
        expect(claim.status).toBe("denied");
        expect(claim.claimed).toBeUndefined();
        // And the approval is gone with it, rather than waiting for a reconnection
        // to collect a key nobody approved for that connection.
        expect(rows).toHaveLength(0);
    });

    it("carries the connection to the client it lets in", async () => {
        const opened = await waiting();
        await answerVaultAuthorization(
            { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
            NOW
        );
        const claim = await claimVaultAuthorization(opened.deviceCode, NOW);
        expect(claim.claimed?.extensionSessionId).toBe("connection-1");
    });

    it("leaves a request from anything else alone", async () => {
        // Every other client signs in this way too, and none of them has a
        // connection to check.
        const opened = await openVaultAuthorization(REQUEST, bytes(5), NOW);
        expect(
            await answerVaultAuthorization(
                { userId: "u1", userCode: opened.userCode, approve: true, wrappedKey: "SEALED" },
                NOW
            )
        ).toEqual({});
        expect((await claimVaultAuthorization(opened.deviceCode, NOW)).status).toBe("approved");
    });
});
