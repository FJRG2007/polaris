/**
 * The step-by-step log of adding a server.
 *
 * Two halves have to agree: the service appends an event at each stage of the
 * exchange, and the dialog turns those events into steps. The service half is
 * checked through the claim with a machine that does or does not answer; the
 * dialog half through `enrollmentTimeline`, which is pure.
 */

import type { EnrollmentEvent } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row extends Record<string, unknown> {
    id: string;
    claimedAt: Date | null;
    expiresAt: Date;
    hostId: string | null;
    error: string | null;
    progress: unknown;
}

let row: Row | null = null;
/** Every event the service tried to append, in order. */
const notes: Record<string, unknown>[] = [];
let answers: Array<() => Promise<string>> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        // The append is one raw statement; the event is its first JSON value.
        $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            const json = values.find((value) => typeof value === "string" && value.startsWith("["));
            if (typeof json === "string")
                notes.push(...(JSON.parse(json) as Record<string, unknown>[]));
            return 1;
        },
        enrollment: {
            findFirst: async () => row,
            findUnique: async () => row,
            updateMany: async () => ({ count: row ? 1 : 0 }),
            update: async () => row
        },
        host: { create: async () => ({ id: "host_1" }) }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    decryptSecret: () => "private",
    encryptSecret: () => ({ ciphertext: Buffer.from(""), nonce: Buffer.from(""), keyId: "k" }),
    encryptCredentials: () => ({ ciphertext: Buffer.from(""), nonce: Buffer.from(""), keyId: "k" })
}));
vi.mock("@polaris/ssh", () => ({
    generateSshKeyPair: () => ({ publicKey: "pub", privateKey: "priv" }),
    publicKeyBlob: (line: string) => line.split(" ")[1] ?? null,
    testAndCaptureHostKey: async () => (answers.shift() ?? (async () => "AAAA"))()
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/local-server", () => ({ setLocalHostId: async () => undefined }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => null }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));

const { claimEnrollment, getEnrollmentStatus, refuseEnrollment } = await import(
    "../../src/lib/enrollment-service"
);
const {
    ENROLLMENT_PROGRESS_LIMIT,
    ENROLLMENT_SETUP_DEADLINE_MS,
    enrollmentTimeline,
    enrollmentStillRunning,
    readEnrollmentProgress,
    settleStalledSetup
} = await import("@polaris/core");

const claim = {
    hostname: "web-1",
    platform: "linux" as const,
    arch: "x86_64",
    os: "Debian GNU/Linux 12",
    port: 22,
    username: "polaris",
    addresses: ["10.0.0.5"],
    hostKeys: ["ssh-ed25519 AAAA"],
    docker: true,
    root: true
};

beforeEach(() => {
    notes.length = 0;
    answers = [];
    row = {
        id: "0190a1b2-0000-7000-8000-000000000001",
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
        progress: null
    };
});

describe("what the exchange writes down", () => {
    it("logs each stage of a claim that works, through to the setup it queues", async () => {
        const result = await claimEnrollment("tok", claim, "203.0.113.8");
        expect(result.ok).toBe(true);
        expect(notes.map((note) => `${note.step}:${note.state}:${note.code}`)).toEqual([
            "checked:done:machineReported",
            "connect:active:trying",
            "connect:done:connected",
            "registered:done:registered",
            "setup:active:setupQueued"
        ]);
        expect(notes[0].facts).toEqual({
            platform: "linux",
            arch: "x86_64",
            os: "Debian GNU/Linux 12",
            docker: true,
            root: true
        });
        // The setup that follows is the route's to run; it needs to know which
        // log to finish.
        expect(result.setup?.enrollmentId).toBe(row?.id);
    });

    it("logs each address it gave up on, and ends the step with why", async () => {
        answers = [
            async () => {
                throw new Error("connect ECONNREFUSED");
            },
            async () => {
                throw new Error("connect ETIMEDOUT");
            }
        ];
        const result = await claimEnrollment("tok", claim, "203.0.113.8");
        expect(result.ok).toBe(false);
        const connect = notes.filter((note) => note.step === "connect");
        expect(connect.map((note) => note.code)).toEqual([
            "trying",
            "unreachable",
            "trying",
            "unreachable",
            "unreachable"
        ]);
        expect(connect.at(-1)?.state).toBe("failed");
        expect(connect.filter((note) => note.state === "failed")).toHaveLength(1);
    });

    it("tells an impostor apart from a machine that did not answer", async () => {
        answers = [async () => "BBBB", async () => "BBBB"];
        await claimEnrollment("tok", claim, "203.0.113.8");
        expect(notes.filter((note) => note.state === "failed").map((note) => note.code)).toEqual([
            "wrongMachine"
        ]);
    });

    it("records a refusal against the checks, by code and never by sentence", async () => {
        await refuseEnrollment("tok", "ssh-not-listening", "203.0.113.8");
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({
            step: "checked",
            state: "failed",
            code: "refused",
            reason: "ssh-not-listening"
        });
        expect(notes[0]).not.toHaveProperty("detail");
    });

    it("hands the dialog the stored log, without the entries it cannot read", async () => {
        if (!row) throw new Error("no row");
        row.progress = [
            { step: "command", state: "done", code: "created", at: "2026-10-15T10:00:00.000Z" },
            { step: "teleport", state: "done", code: "created", at: "2026-10-15T10:00:01.000Z" },
            "not an event"
        ];
        const status = await getEnrollmentStatus(row.id, "usr_1");
        expect(status?.progress).toHaveLength(1);
        expect(status?.progress[0].code).toBe("created");
    });
});

function event(
    partial: Omit<EnrollmentEvent, "at">,
    at = "2026-10-15T10:00:00.000Z"
): EnrollmentEvent {
    return { ...partial, at };
}

describe("enrollmentTimeline", () => {
    it("lists every step but setup while nothing says setup applies", () => {
        const steps = enrollmentTimeline([
            event({ step: "command", state: "done", code: "created" })
        ]);
        expect(steps.map((step) => step.step)).toEqual([
            "command",
            "fetched",
            "checked",
            "connect",
            "registered"
        ]);
        expect(steps.map((step) => step.status)).toEqual([
            "done",
            "waiting",
            "waiting",
            "waiting",
            "waiting"
        ]);
    });

    // A machine that refused and was then fixed and re-run has a failure followed
    // by a success on the same step. The success is what happened.
    it("takes a step's status from its latest event, so a recovered refusal is not still failed", () => {
        const steps = enrollmentTimeline([
            event({
                step: "checked",
                state: "failed",
                code: "refused",
                reason: "ssh-not-listening"
            }),
            event({ step: "checked", state: "done", code: "machineReported" })
        ]);
        const checked = steps.find((step) => step.step === "checked");
        expect(checked?.status).toBe("done");
        expect(checked?.failure).toBeNull();
        expect(checked?.events).toHaveLength(2);
    });

    it("names the event that failed a step", () => {
        const steps = enrollmentTimeline([
            event({ step: "connect", state: "active", code: "trying", address: "10.0.0.5" }),
            event({ step: "connect", state: "failed", code: "keyRefused" })
        ]);
        expect(steps.find((step) => step.step === "connect")?.failure?.code).toBe("keyRefused");
    });

    it("keeps watching while a queued setup has not finished", () => {
        const queued = [event({ step: "setup", state: "active", code: "setupQueued" })];
        expect(enrollmentStillRunning(queued)).toBe(true);
        expect(enrollmentTimeline(queued).at(-1)?.step).toBe("setup");
        expect(
            enrollmentStillRunning([
                ...queued,
                event({ step: "setup", state: "failed", code: "setupFailed", detail: "No root" })
            ])
        ).toBe(false);
    });

    // Past the limit the oldest lines are the ones dropped, so a step whose lines
    // went is still ticked when a later one has moved.
    it("ticks a step whose lines were dropped once a later step has moved", () => {
        const steps = enrollmentTimeline([
            event({ step: "registered", state: "done", code: "registered" })
        ]);
        expect(steps.map((step) => step.status)).toEqual(["done", "done", "done", "done", "done"]);
    });

    it("keeps the newest events of a log over the limit", () => {
        const stored = [
            ...Array.from({ length: ENROLLMENT_PROGRESS_LIMIT }, () =>
                event({ step: "connect", state: "active", code: "trying", address: "10.0.0.5" })
            ),
            event({ step: "registered", state: "done", code: "registered" })
        ];
        const read = readEnrollmentProgress(stored);
        expect(read).toHaveLength(ENROLLMENT_PROGRESS_LIMIT);
        expect(read.at(-1)?.code).toBe("registered");
    });

    it("closes a setup that has been quiet past its deadline", () => {
        const queuedAt = new Date("2026-10-15T10:00:00.000Z");
        const queued = [
            event({ step: "setup", state: "active", code: "setupQueued" }, queuedAt.toISOString())
        ];
        const soon = new Date(queuedAt.getTime() + ENROLLMENT_SETUP_DEADLINE_MS - 1000);
        expect(settleStalledSetup(queued, soon)).toBe(queued);
        const late = settleStalledSetup(
            queued,
            new Date(queuedAt.getTime() + ENROLLMENT_SETUP_DEADLINE_MS)
        );
        expect(enrollmentStillRunning(late)).toBe(false);
        expect(enrollmentTimeline(late).at(-1)?.failure?.code).toBe("setupStalled");
        const done = [...queued, event({ step: "setup", state: "done", code: "setupDone" })];
        expect(
            settleStalledSetup(
                done,
                new Date(queuedAt.getTime() + 2 * ENROLLMENT_SETUP_DEADLINE_MS)
            )
        ).toBe(done);
    });

    it("reads a column that is not a list as no log at all", () => {
        expect(readEnrollmentProgress(null)).toEqual([]);
        expect(readEnrollmentProgress({ step: "command" })).toEqual([]);
    });
});
