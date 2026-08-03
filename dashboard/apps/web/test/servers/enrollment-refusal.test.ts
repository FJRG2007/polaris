/**
 * A machine that stops before claiming is the one failure the enrollment is meant
 * to survive: the token is deliberately left unspent so the same command works
 * once the SSH server is on.
 *
 * That makes `failed` a state to come back from rather than the end of one, which
 * is a thing three places have to agree on - the refusal must not spend the token,
 * the status has to say the command is still good, and the claim that follows must
 * not still be reporting the refusal it just recovered from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row extends Record<string, unknown> {
    id: string;
    claimedAt: Date | null;
    expiresAt: Date;
    hostId: string | null;
    error: string | null;
}

let row: Row | null = null;
const updateManyArgs: Record<string, unknown>[] = [];
const updateArgs: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        enrollment: {
            findFirst: async () => row,
            findUnique: async () => row,
            updateMany: async (args: Record<string, unknown>) => {
                updateManyArgs.push(args);
                return { count: row ? 1 : 0 };
            },
            update: async (args: Record<string, unknown>) => {
                updateArgs.push(args);
                return row;
            }
        }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    decryptSecret: () => "private",
    encryptSecret: () => ({ ciphertext: Buffer.from(""), nonce: Buffer.from(""), keyId: "k" })
}));
vi.mock("@polaris/ssh", () => ({
    generateSshKeyPair: () => ({ publicKey: "pub", privateKey: "priv" }),
    publicKeyBlob: (line: string) => line,
    testAndCaptureHostKey: async () => "ssh-ed25519 AAAA"
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/local-server", () => ({ setLocalHostId: async () => undefined }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));

const { claimEnrollment, getEnrollmentStatus, refuseEnrollment } = await import("../../src/lib/enrollment-service");
const { ENROLLMENT_REFUSAL_MESSAGES } = await import("@polaris/core");

function enrollment(overrides: Partial<Row> = {}): Row {
    return {
        id: "enr_1",
        name: "New server",
        kind: "server",
        createdById: "usr_1",
        environment: "unknown",
        encryptedKey: Buffer.from(""),
        keyNonce: Buffer.from(""),
        keyKeyId: "k",
        claimedAt: null,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        hostId: null,
        error: null,
        ...overrides
    };
}

beforeEach(() => {
    updateManyArgs.length = 0;
    updateArgs.length = 0;
    row = enrollment();
});

describe("refuseEnrollment", () => {
    it("records Polaris's own sentence for the code and nothing the machine sent", async () => {
        await refuseEnrollment("tok", "ssh-not-listening", "203.0.113.8");
        expect(updateManyArgs).toHaveLength(1);
        expect(updateManyArgs[0].data).toEqual({ error: ENROLLMENT_REFUSAL_MESSAGES["ssh-not-listening"] });
    });

    // The whole point of stopping before the claim. Spending the token here would
    // leave the operator fixing their SSH server for a command that is already gone.
    it("leaves the command unspent, so the same one still works", async () => {
        await refuseEnrollment("tok", "remote-login-off", "203.0.113.8");
        const data = updateManyArgs[0].data as Record<string, unknown>;
        expect(data).not.toHaveProperty("claimedAt");
        expect(data).not.toHaveProperty("hostId");
        // Only an enrollment that is still live can be refused, so a spent token
        // cannot be talked back into showing an error.
        expect(updateManyArgs[0].where).toMatchObject({ claimedAt: null, hostId: null });
    });
});

describe("what the waiting dialog is told", () => {
    it("calls a refusal recoverable, because the command it describes still works", async () => {
        row = enrollment({ error: ENROLLMENT_REFUSAL_MESSAGES["ssh-not-listening"] });
        const status = await getEnrollmentStatus("enr_1", "usr_1");
        expect(status?.state).toBe("failed");
        expect(status?.retryable).toBe(true);
    });

    // A claim that failed burned the token on its way past, so there is nothing to
    // come back to and the dialog has to stop watching.
    it("calls a failed claim final, because that one did spend the token", async () => {
        row = enrollment({ claimedAt: new Date(), error: "Polaris could not reach the machine" });
        const status = await getEnrollmentStatus("enr_1", "usr_1");
        expect(status?.state).toBe("failed");
        expect(status?.retryable).toBe(false);
    });

    // A refusal that outlives its command stops being something to retry, which is
    // what turns the dialog's "still works" line off without it having to guess.
    //
    // The state has to move with it. `error` used to imply a claim, so reading it
    // first was harmless; a refusal puts one on a live row, and leaving that row
    // `failed` forever meant a dead command still showing what to fix as though
    // fixing it would help.
    it("stops calling a refusal recoverable once the command has expired", async () => {
        row = enrollment({
            error: ENROLLMENT_REFUSAL_MESSAGES["remote-login-off"],
            expiresAt: new Date(Date.now() - 1000)
        });
        const status = await getEnrollmentStatus("enr_1", "usr_1");
        expect(status?.retryable).toBe(false);
        expect(status?.state).toBe("expired");
        // The reason survives the state change, so the dialog can still say what
        // the machine refused over rather than pretending it never ran.
        expect(status?.error).toBe(ENROLLMENT_REFUSAL_MESSAGES["remote-login-off"]);
    });

    // A claim spends the token, so what happened to it stays the answer no matter
    // what the clock did afterwards - there is nothing left to come back to.
    it("keeps a failed claim failed even after the clock runs out", async () => {
        row = enrollment({
            claimedAt: new Date(),
            error: "Polaris could not reach the machine",
            expiresAt: new Date(Date.now() - 1000)
        });
        expect((await getEnrollmentStatus("enr_1", "usr_1"))?.state).toBe("failed");
    });
});

// Every one of these ends up on screen next to a command that may be alive or dead,
// and only the renderer knows which. A stored sentence that picks one is wrong half
// the time - and it was wrong in the direction of telling somebody to paste a token
// that no longer exists.
describe("ENROLLMENT_REFUSAL_MESSAGES", () => {
    it("says what to fix without saying what to do with the command", async () => {
        const { ENROLLMENT_REFUSAL_REASONS } = await import("@polaris/core");
        for (const reason of ENROLLMENT_REFUSAL_REASONS) {
            const message = ENROLLMENT_REFUSAL_MESSAGES[reason];
            expect(message.length).toBeGreaterThan(0);
            expect(message).not.toMatch(/run (it|the command) again/i);
            expect(message).not.toMatch(/generate a new/i);
        }
    });
});

describe("claimEnrollment after a refusal", () => {
    // The row is claimable with a stale error on it, and the state machine reads
    // `error` before `claimedAt` - so without this the dialog spends the whole
    // outbound probe reporting the failure the machine already came back from.
    it("clears the refusal as it burns the token, not only once it succeeds", async () => {
        row = enrollment({ error: ENROLLMENT_REFUSAL_MESSAGES["ssh-not-listening"] });
        await claimEnrollment(
            "tok",
            {
                hostname: "box",
                platform: "linux",
                arch: "x86_64",
                username: "polaris",
                port: 22,
                hostKeys: ["ssh-ed25519 AAAA"],
                addresses: [],
                docker: false,
                root: false
            },
            undefined
        );
        const burn = updateArgs[0].data as Record<string, unknown>;
        expect(burn.claimedAt).toBeInstanceOf(Date);
        expect(burn.error).toBeNull();
    });
});
