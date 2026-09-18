/**
 * The browser extension's connection to an account.
 *
 * The rules this pins are the ones that make a connection worth listing: a token
 * that is only ever stored hashed, an approval that can be collected exactly
 * once, a connection that is cut off the moment it is ended - along with the
 * vault client it let in - and an extension that was signed in to a vault before
 * connections existed being adopted rather than left unmanaged.
 */

import { hashToken } from "@polaris/core/tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";

interface Row {
    [key: string]: unknown;
}

let authorizations: Row[] = [];
let sessions: Row[] = [];
let devices: Row[] = [];
let refreshTokens: Row[] = [];
let users: Row[] = [];

function match(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "revokedAt" && value === null) return row["revokedAt"] === null;
        if (key === "expiresAt" && typeof value === "object" && value !== null) {
            const rule = value as { lt?: Date; gt?: Date };
            const at = row["expiresAt"] as Date;
            if (rule.lt) return at < rule.lt;
            if (rule.gt) return at > rule.gt;
        }
        if (key === "extensionSessionId" && typeof value === "object" && value !== null) {
            const rule = value as { in?: string[] };
            return rule.in ? rule.in.includes(row[key] as string) : false;
        }
        if (key === "deviceId" && typeof value === "object" && value !== null) {
            const rule = value as { in?: string[] };
            return rule.in ? rule.in.includes(row[key] as string) : false;
        }
        if (key === "userId_deviceId") {
            const pair = value as { userId: string; deviceId: string };
            return row["userId"] === pair.userId && row["deviceId"] === pair.deviceId;
        }
        return row[key] === value;
    });
}

/** What a row looks like once the rows it is read with are attached - the
 *  account behind a connection, which the service reads through `select`. */
function table(
    rows: () => Row[],
    set: (next: Row[]) => void,
    join: (row: Row) => Row = (row) => row
) {
    const found = (where: Row): Row | null => {
        const hit = rows().find((row) => match(row, where));
        return hit ? join(hit) : null;
    };
    const stamped = (data: Row): Row => ({
        createdAt: new Date(),
        lastSeenAt: new Date(),
        revokedAt: null,
        ...data
    });
    return {
        findUnique: async ({ where }: { where: Row }) => found(where),
        findFirst: async ({ where }: { where: Row }) => found(where),
        findMany: async ({ where }: { where?: Row } = {}) =>
            (where ? rows().filter((row) => match(row, where)) : rows()).map(join),
        create: async ({ data }: { data: Row }) => {
            const made = { id: `id-${rows().length + 1}`, ...stamped(data) };
            set([...rows(), made]);
            return made;
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
            const found = rows().find((row) => match(row, where));
            if (!found) throw new Error("not found");
            Object.assign(found, data);
            return found;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            const found = rows().filter((row) => match(row, where));
            for (const row of found) Object.assign(row, data);
            return { count: found.length };
        },
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
            const found = rows().find((row) => match(row, where));
            if (found) {
                Object.assign(found, update);
                return found;
            }
            const made = { id: `id-${rows().length + 1}`, ...stamped(create) };
            set([...rows(), made]);
            return made;
        },
        deleteMany: async ({ where }: { where: Row }) => {
            const kept = rows().filter((row) => !match(row, where));
            const count = rows().length - kept.length;
            set(kept);
            return { count };
        }
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        get extensionAuthorization() {
            return table(
                () => authorizations,
                (next) => (authorizations = next)
            );
        },
        get extensionSession() {
            return table(
                () => sessions,
                (next) => (sessions = next),
                (row) => ({
                    ...row,
                    user: users.find((one) => one["id"] === row["userId"]) ?? null
                })
            );
        },
        get vaultDevice() {
            return table(
                () => devices,
                (next) => (devices = next)
            );
        },
        get vaultRefreshToken() {
            return table(
                () => refreshTokens,
                (next) => (refreshTokens = next)
            );
        },
        get user() {
            return table(
                () => users,
                (next) => (users = next)
            );
        }
    }
}));

const {
    answerExtensionConnection,
    claimExtensionConnection,
    describeExtensionConnection,
    listExtensionSessions,
    openExtensionConnection,
    readExtensionToken,
    revokeExtensionSession
} = await import("@/lib/extension/sessions");

const SEEN = {
    ip: "203.0.113.4",
    userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0",
    host: "polaris.example"
};

/** Deterministic codes, so a test can name the one it expects. */
const fixedRandom = (size: number) => new Uint8Array(size).fill(3);

beforeEach(() => {
    authorizations = [];
    sessions = [];
    devices = [];
    refreshTokens = [];
    users = [{ id: ALICE, name: "Ada", email: "ada@example.com", bannedAt: null }];
});

async function connect(): Promise<{ token: string; sessionId: string }> {
    const opened = await openExtensionConnection(
        {
            deviceId: "install-1",
            deviceName: "Chrome on Windows",
            ...SEEN,
            requestIp: SEEN.ip,
            requestUserAgent: SEEN.userAgent,
            requestHost: SEEN.host
        },
        fixedRandom
    );
    await answerExtensionConnection({
        userId: ALICE,
        userCode: opened!.userCode,
        approve: true,
        sessionId: "session-1"
    });
    const claim = await claimExtensionConnection(opened!.deviceCode, SEEN);
    if (claim.status !== "approved") throw new Error("not approved");
    return { token: claim.token, sessionId: sessions[0]!["id"] as string };
}

describe("opening a request", () => {
    it("stores the polling secret hashed and shows a code somebody can read", async () => {
        const opened = await openExtensionConnection(
            {
                deviceId: "install-1",
                deviceName: "Chrome on Windows",
                requestIp: SEEN.ip,
                requestUserAgent: SEEN.userAgent,
                requestHost: SEEN.host
            },
            fixedRandom
        );

        expect(opened?.userCode).toHaveLength(8);
        expect(authorizations[0]?.["codeHash"]).toBe(hashToken(opened!.deviceCode));
        expect(authorizations[0]?.["codeHash"]).not.toBe(opened!.deviceCode);
        expect(authorizations[0]?.["status"]).toBe("pending");
    });

    it("describes it from what the request said, not from what the asker claimed", async () => {
        const opened = await openExtensionConnection(
            {
                deviceId: "install-1",
                deviceName: "Something else entirely",
                requestIp: SEEN.ip,
                requestUserAgent: SEEN.userAgent,
                requestHost: SEEN.host
            },
            fixedRandom
        );

        const pending = await describeExtensionConnection(opened!.userCode);
        expect(pending).toMatchObject({
            device: "Something else entirely",
            browser: "Chrome",
            os: "Windows",
            requestIp: SEEN.ip,
            host: SEEN.host
        });
    });
});

describe("collecting it", () => {
    it("waits until somebody answers, and hands the token over exactly once", async () => {
        const opened = await openExtensionConnection(
            {
                deviceId: "install-1",
                deviceName: "Chrome on Windows",
                requestIp: SEEN.ip,
                requestUserAgent: SEEN.userAgent,
                requestHost: SEEN.host
            },
            fixedRandom
        );

        expect(await claimExtensionConnection(opened!.deviceCode, SEEN)).toEqual({
            status: "pending"
        });

        await answerExtensionConnection({
            userId: ALICE,
            userCode: opened!.userCode,
            approve: true,
            sessionId: "session-1"
        });

        const claim = await claimExtensionConnection(opened!.deviceCode, SEEN);
        expect(claim.status).toBe("approved");
        // Stored hashed, never as it was handed over.
        const token = claim.status === "approved" ? claim.token : "";
        expect(sessions[0]?.["tokenHash"]).toBe(hashToken(token));
        // And spent: a second poll gets nothing.
        expect(await claimExtensionConnection(opened!.deviceCode, SEEN)).toEqual({
            status: "expired"
        });
    });

    it("says so when it was turned away", async () => {
        const opened = await openExtensionConnection(
            {
                deviceId: "install-1",
                deviceName: "Chrome on Windows",
                requestIp: null,
                requestUserAgent: null,
                requestHost: null
            },
            fixedRandom
        );
        await answerExtensionConnection({
            userId: ALICE,
            userCode: opened!.userCode,
            approve: false,
            sessionId: "session-1"
        });

        expect(await claimExtensionConnection(opened!.deviceCode, SEEN)).toEqual({
            status: "denied"
        });
        expect(sessions).toHaveLength(0);
    });

    it("adopts the vault client this same install was already signed in as", async () => {
        devices.push({
            id: "device-1",
            userId: ALICE,
            identifier: "install-1",
            extensionSessionId: null
        });

        const { sessionId } = await connect();

        expect(devices[0]?.["extensionSessionId"]).toBe(sessionId);
    });

    it("replaces what one install held rather than listing it twice", async () => {
        const first = await connect();
        const second = await connect();

        expect(sessions).toHaveLength(1);
        expect(await readExtensionToken(first.token)).toBeNull();
        expect(await readExtensionToken(second.token)).toMatchObject({ userId: ALICE });
    });
});

describe("the token", () => {
    it("names the connection behind it, and nothing for one that was ended", async () => {
        const { token, sessionId } = await connect();

        expect(await readExtensionToken(token)).toMatchObject({ id: sessionId, userId: ALICE });

        await revokeExtensionSession(ALICE, sessionId);
        expect(await readExtensionToken(token)).toBeNull();
    });

    it("is refused for an account that has been shut", async () => {
        const { token } = await connect();
        users[0]!["bannedAt"] = new Date();
        expect(await readExtensionToken(token)).toBeNull();
    });
});

describe("ending a connection", () => {
    it("revokes the vault tokens of the client it let in", async () => {
        const { sessionId } = await connect();
        devices.push({
            id: "device-1",
            userId: ALICE,
            identifier: "install-1",
            extensionSessionId: sessionId
        });
        refreshTokens.push({ id: "token-1", deviceId: "device-1", revokedAt: null });

        const ended = await revokeExtensionSession(ALICE, sessionId);

        expect(ended.revoked).toBe(true);
        expect(refreshTokens[0]?.["revokedAt"]).toBeInstanceOf(Date);
    });

    it("belongs to its owner and nobody else", async () => {
        const { sessionId, token } = await connect();

        const ended = await revokeExtensionSession(
            "22222222-2222-4222-8222-222222222222",
            sessionId
        );

        expect(ended.revoked).toBe(false);
        expect(await readExtensionToken(token)).toMatchObject({ userId: ALICE });
    });
});

describe("the list", () => {
    it("says what the request said about the browser, and how many vaults hang off it", async () => {
        const { sessionId } = await connect();
        sessions[0]!["_count"] = { vaultDevices: 1 };

        const [listed] = await listExtensionSessions(ALICE);

        expect(listed).toMatchObject({
            id: sessionId,
            browser: "Chrome",
            os: "Windows",
            ip: SEEN.ip,
            host: SEEN.host,
            vaultClients: 1
        });
    });
});
