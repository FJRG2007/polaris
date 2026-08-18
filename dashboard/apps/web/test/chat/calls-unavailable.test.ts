/**
 * Whether a call may be started at all.
 *
 * There is one way to carry a call now, so "no call server" is not a state to
 * degrade into - it is a state to refuse. That refusal is the whole point of
 * this file: without it a browser opens a microphone, joins a room, shows
 * everybody's name and carries no sound, which is a failure nobody inside the
 * call can diagnose and the one people actually report.
 *
 * The three cases are deliberately separate. Nothing configured, configured but
 * silent (a container still starting, or one that died), and answering. The
 * middle one is the interesting one: it looks configured from the database and
 * is exactly as useless as the first.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: { meetingParticipant: { findUnique: async () => null } } }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null,
    upsertIntegration: async () => undefined
}));

let env: Record<string, string | undefined> = {};
vi.mock("@polaris/config", () => ({ loadEnv: () => env }));

/** What the media server answers when it is asked whether it is up. */
let reachable = true;
const asked: string[] = [];
vi.stubGlobal("fetch", async (input: string) => {
    asked.push(String(input));
    if (!reachable) throw new Error("connection refused");
    return { ok: true } as Response;
});

/** The volume the dashboard and the media server share their key on, somewhere
 *  this suite may write. */
const keysDir = await mkdtemp(join(tmpdir(), "polaris-call-keys-"));
process.env.POLARIS_CALL_KEYS_DIR = keysDir;

const calls = await import("@/lib/chat/call-server");

beforeEach(() => {
    env = {};
    reachable = true;
    asked.length = 0;
    // The answer is cached for a few seconds so every open tab does not knock,
    // and each case here is a different instance.
    calls.forgetAnswer();
});

describe("whether a call can be started", () => {
    it("runs on the shipped server with nothing configured at all", async () => {
        // Not "refused because nothing is set up", which is what this used to
        // say: a deployment where nobody has touched anything is the ordinary
        // one, and calls have to work there.
        expect(await calls.callsUnavailable()).toBeNull();
    });

    it("refuses when there is nowhere for a call to run at all", async () => {
        // No volume for the shared key, which is a process running outside the
        // Polaris stack - and there is no media server beside it either.
        process.env.POLARIS_CALL_KEYS_DIR = join(keysDir, "missing");
        try {
            expect(await calls.callsUnavailable()).toBe(calls.NO_CALL_SERVER);
        } finally {
            process.env.POLARIS_CALL_KEYS_DIR = keysDir;
        }
    });

    it("refuses when the server is there and not answering", async () => {
        reachable = false;
        // Configured is not the same as working, and this is the case that
        // looked fine from every screen: the address is set, the key is set, and
        // the container is not there.
        expect(await calls.callsUnavailable()).toBe(calls.NO_CALL_SERVER);
    });

    it("allows it once the server answers", async () => {
        expect(await calls.callsUnavailable()).toBeNull();
    });

    it("asks the shipped server on the host rather than on its path", async () => {
        await calls.callsUnavailable();
        // `/livekit` is an address only a browser can resolve - it means "the
        // host this page came from". Asked from here it would be a path against
        // nothing, so the check goes to the machine instead.
        expect(asked.every((address) => address.startsWith("http"))).toBe(true);
        expect(asked.some((address) => address.includes("7880"))).toBe(true);
    });

    it("asks a server somebody typed at the address they typed", async () => {
        env = {
            POLARIS_CALL_SERVER_URL: "wss://calls.example.com",
            POLARIS_CALL_SERVER_API_KEY: "polaris",
            POLARIS_CALL_SERVER_API_SECRET: "s".repeat(32)
        };
        await calls.callsUnavailable();
        expect(asked).toEqual(["https://calls.example.com"]);
    });

    it("asks once for a burst of readers", async () => {
        await calls.callsUnavailable();
        const first = asked.length;
        await calls.callsUnavailable();
        // Every open Chat tab asks this. Without the cache a busy instance
        // knocks on the media server once per reader per poll for a fact that
        // changes when a container restarts.
        expect(asked.length).toBe(first);
    });
});
