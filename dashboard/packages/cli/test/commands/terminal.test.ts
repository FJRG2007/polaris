/**
 * `plr terminal`: finding the terminals on this computer from their discovery
 * records, the request envelope the command line builds, one request through
 * the relay, the local broker-then-endpoint exchange, and the list that puts
 * both together.
 */

import { join } from "node:path";
import { run } from "../../src/cli.js";
import { createServer } from "node:net";
import { parse } from "../../src/args.js";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import type { Probe } from "../../src/guard.js";
import { writeFile, mkdir } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { envelopeFor, sendRemote } from "../../src/commands/terminal.js";
import { scriptedFetch, tempDir, testContext } from "../helpers/context.js";
import { localTerminals, sendLocal, trustworthy, type LocalRecord } from "../../src/terminal-local.js";

const clean: Probe = { exists: () => false, read: () => null };
const ID = `inst_${"a".repeat(32)}`;

function record(overrides: Partial<LocalRecord> = {}): LocalRecord {
    return {
        protocol_version: 1,
        instance_id: ID,
        pid: process.pid,
        channel: "oss",
        app_id: "dev.polaris.PolarisTerminal",
        app_version: "0.2026.11.23",
        started_at: "2026-11-23T10:00:00Z",
        endpoint: { host: "127.0.0.1", port: 4321 },
        credential_broker: { socket_path: `${ID}.broker.sock` },
        ...overrides
    };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
    try {
        await promise;
    } catch (caught) {
        expect(caught).toBeInstanceOf(CliError);
        return caught as CliError;
    }
    throw new Error("expected a failure");
}

describe("discovery records", () => {
    it("follows only a record with the terminal's own shape and authority", () => {
        expect(trustworthy(record())).toBe(true);
        expect(trustworthy(record({ endpoint: null, credential_broker: null }))).toBe(true);
        expect(trustworthy(record({ endpoint: { host: "192.0.2.7", port: 4321 } }))).toBe(false);
        expect(trustworthy(record({ credential_broker: { socket_path: "../elsewhere.sock" } }))).toBe(false);
        expect(trustworthy(record({ credential_broker: null }))).toBe(false);
        expect(trustworthy(record({ protocol_version: 2 }))).toBe(false);
    });

    it("reads the Polaris and the Rook directories, skipping dead, malformed and stray files", async () => {
        const polaris = await tempDir();
        const rook = await tempDir();
        const other = `inst_${"b".repeat(32)}`;
        await writeFile(join(polaris, `${ID}.json`), JSON.stringify(record()));
        await writeFile(join(polaris, "broken.json"), "{");
        await writeFile(join(polaris, `${ID}.json.tmp`), JSON.stringify(record()));
        await writeFile(
            join(rook, `${other}.json`),
            JSON.stringify(record({ instance_id: other, endpoint: null, credential_broker: null }))
        );
        await writeFile(
            join(rook, "dead.json"),
            JSON.stringify(record({ instance_id: `inst_${"c".repeat(32)}`, pid: 999_999, credential_broker: { socket_path: `inst_${"c".repeat(32)}.broker.sock` } }))
        );
        const host = {
            platform: "linux" as const,
            home: polaris,
            env: { POLARIS_TERMINAL_LOCAL_CONTROL_DISCOVERY_DIR: polaris, ROOK_LOCAL_CONTROL_DISCOVERY_DIR: rook }
        };
        const found = await localTerminals(host, (pid) => pid === process.pid);
        expect(found.map((one) => [one.record.instance_id, one.dir, one.scripting])).toEqual([
            [ID, polaris, true],
            [other, rook, false]
        ]);
    });
});

describe("the request envelope", () => {
    it("carries the action, its params and the target the flags name", () => {
        const { flags } = parse(["--params", '{"text":"ls"}', "--window", "active", "--tab", "2", "--pane", "pane_x"]);
        expect(envelopeFor("input.insert", flags, "r-1")).toEqual({
            protocol_version: 1,
            request_id: "r-1",
            target: { window: { type: "active" }, tab: { type: "index", index: 2 }, pane: { type: "id", id: "pane_x" } },
            action: { kind: "input.insert", params: { text: "ls" } }
        });
    });

    it("refuses a missing action, a made-up spelling and params that are not an object", () => {
        const { flags } = parse([]);
        expect(() => envelopeFor(undefined, flags)).toThrow(CliError);
        expect(() => envelopeFor("rm -rf", flags)).toThrow(CliError);
        expect(() => envelopeFor("pane.list", parse(["--params", "[1]"]).flags)).toThrow(CliError);
        expect(() => envelopeFor("pane.list", parse(["--params", "{"]).flags)).toThrow(CliError);
    });
});

/** A relay that answers one request the way `terminal-relay.mjs` does. */
function fakeRelay(reply: (frame: { instance: string; envelope: { request_id: string } }) => object | null) {
    const seen: { url: string; headers: Record<string, string>; frames: unknown[] } = { url: "", headers: {}, frames: [] };
    const open = (url: string, init: { headers: Record<string, string> }) => {
        seen.url = url;
        seen.headers = init.headers;
        const socket = {
            onopen: null as null | (() => void),
            onmessage: null as null | ((event: { data: unknown }) => void),
            onerror: null as null | (() => void),
            onclose: null as null | ((event: { code: number }) => void),
            send(data: string) {
                const frame = JSON.parse(data);
                seen.frames.push(frame);
                const answer = reply(frame);
                if (answer) queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(answer) }));
            },
            close() {}
        };
        queueMicrotask(() => socket.onopen?.());
        return socket;
    };
    return { open, seen };
}

describe("one request through the relay", () => {
    const connection = { url: "https://polaris.example.com", token: "plk_TESTONLY.fixture" };
    const envelope = envelopeFor("pane.list", parse([]).flags, "r-9");

    it("dials the controller role with the key and returns the terminal's data", async () => {
        const relay = fakeRelay(({ instance, envelope: sent }) => ({
            type: "response",
            instance,
            request_id: sent.request_id,
            envelope: { protocol_version: 1, request_id: sent.request_id, response: { status: "ok", data: { panes: [1] } } }
        }));
        expect(await sendRemote(connection, "term-1", envelope, relay.open)).toEqual({ panes: [1] });
        expect(relay.seen.url).toBe("wss://polaris.example.com/api/deploy/ws/terminal?role=controller");
        expect(relay.seen.headers).toEqual({ authorization: "Bearer plk_TESTONLY.fixture" });
        expect(relay.seen.frames).toEqual([{ type: "request", instance: "term-1", envelope }]);
    });

    it("says what a relay refusal and a terminal refusal mean", async () => {
        const offline = fakeRelay(({ instance, envelope: sent }) => ({ type: "error", instance, request_id: sent.request_id, code: "offline" }));
        expect((await failure(sendRemote(connection, "term-1", envelope, offline.open))).message).toContain("not connected");
        const refused = fakeRelay(({ envelope: sent }) => ({
            type: "response",
            request_id: sent.request_id,
            envelope: {
                protocol_version: 1,
                request_id: sent.request_id,
                response: { status: "error", error: { code: "local_control_disabled", message: "Scripting is off" } }
            }
        }));
        expect((await failure(sendRemote(connection, "term-1", envelope, refused.open))).message).toBe(
            "The terminal refused: Scripting is off (local_control_disabled)."
        );
    });

    it("gives up when no answer comes", async () => {
        const silent = fakeRelay(() => null);
        expect((await failure(sendRemote(connection, "term-1", envelope, silent.open, 20))).message).toContain("in time");
    });
});

describe.skipIf(process.platform === "win32")("a terminal on this computer", () => {
    it("asks the broker for a credential for the one action, then calls the loopback endpoint with it", async () => {
        const dir = await tempDir();
        await mkdir(dir, { recursive: true });
        const brokerAsked: unknown[] = [];
        const broker = createServer((socket) => {
            let text = "";
            socket.on("data", (chunk) => (text += chunk));
            socket.on("end", () => {
                brokerAsked.push(JSON.parse(text));
                socket.end(JSON.stringify({ bearer_token: "scoped-secret", grant: {} }));
            });
        });
        await new Promise<void>((resolve) => broker.listen(join(dir, `${ID}.broker.sock`), resolve));
        const calls: { auth: string | undefined; body: string }[] = [];
        const endpoint = createHttpServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
                calls.push({ auth: request.headers.authorization, body });
                const sent = JSON.parse(body);
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ protocol_version: 1, request_id: sent.request_id, response: { status: "ok", data: { ok: true } } }));
            });
        });
        await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
        const port = (endpoint.address() as { port: number }).port;
        try {
            const terminal = { record: record({ endpoint: { host: "127.0.0.1", port } }), dir, scripting: true };
            const envelope = envelopeFor("app.ping", parse([]).flags, "r-2");
            expect(await sendLocal(terminal, envelope, "linux")).toEqual({ ok: true });
            expect(brokerAsked).toEqual([{ protocol_version: 1, request_id: "r-2", action: "app.ping" }]);
            expect(calls).toHaveLength(1);
            expect(calls[0]!.auth).toBe("Bearer scoped-secret");
            expect(JSON.parse(calls[0]!.body)).toEqual(envelope);
        } finally {
            broker.close();
            endpoint.close();
        }
    });
});

describe("plr terminal list", () => {
    it("lists this computer's terminals and, signed in, the account's through Polaris", async () => {
        const dir = await tempDir();
        await writeFile(join(dir, `${ID}.json`), JSON.stringify(record()));
        const { fetch } = scriptedFetch({
            "GET /api/terminal/instances": () =>
                Response.json({
                    terminals: [
                        { id: "term-1", name: "desk", os: "linux", version: "1", online: true, access: "owner", ownerName: null },
                        { id: "term-2", name: "lab", os: null, version: null, online: false, access: "view", ownerName: "Ada" }
                    ]
                })
        });
        const { context, stdout } = await testContext({
            fetch,
            env: {
                POLARIS_TERMINAL_LOCAL_CONTROL_DISCOVERY_DIR: dir,
                ROOK_LOCAL_CONTROL_DISCOVERY_DIR: dir,
                POLARIS_TOKEN: "plk_TESTONLY.fixture",
                POLARIS_URL: "https://polaris.example.com"
            }
        });
        await run(["terminal", "list"], context, clean);
        expect(stdout()).toContain(ID);
        expect(stdout()).toContain("this computer");
        expect(stdout()).toContain("term-1");
        expect(stdout()).toContain("offline, shared (view)");
    });

    it("lists only this computer's when nobody is signed in, and says how to see the rest", async () => {
        const dir = await tempDir();
        const { context, stdout } = await testContext({
            env: { POLARIS_TERMINAL_LOCAL_CONTROL_DISCOVERY_DIR: dir, ROOK_LOCAL_CONTROL_DISCOVERY_DIR: dir }
        });
        await run(["terminal"], context, clean);
        expect(stdout()).toContain("No terminals found.");
        expect(stdout()).toContain("plr login");
    });

    it("names the update when the Polaris is older than terminal control", async () => {
        const dir = await tempDir();
        const { context, stdout } = await testContext({
            fetch: scriptedFetch({}).fetch,
            env: {
                POLARIS_TERMINAL_LOCAL_CONTROL_DISCOVERY_DIR: dir,
                ROOK_LOCAL_CONTROL_DISCOVERY_DIR: dir,
                POLARIS_TOKEN: "plk_TESTONLY.fixture",
                POLARIS_URL: "https://polaris.example.com"
            }
        });
        await run(["terminal", "ls"], context, clean);
        expect(stdout()).toContain("Update Polaris from Settings");
    });
});
