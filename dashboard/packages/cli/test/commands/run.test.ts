/**
 * `plr run`: starts a session (or prompts one), follows its event stream, and
 * leaves with the exit code a CI step branches on. The agent's answer on
 * stdout, its steps on stderr.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import type { Probe } from "../../src/guard.js";
import { scriptedFetch, testContext } from "../helpers/context.js";

const URL = "https://polaris.example.com";
const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
const clean: Probe = { exists: () => false, read: () => null };
const env = { POLARIS_TOKEN: TOKEN, POLARIS_URL: URL };
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROW = "0190a1b2-c3d4-7e5f-8a9b-000000000001";

const session = (state: string) => ({
    id: ID,
    title: "Fix the build",
    state,
    repo: "acme/shop",
    branch: "polaris/fix",
    agent: "claude",
    detail: "",
    error: null,
    pullRequest: null,
    createdAt: "2026-11-16T10:00:00.000Z",
    finishedAt: null
});

function sse(frames: [string, unknown][]): Response {
    const text = frames
        .map(([event, data], n) => `id: ${n + 1}.${ROW}~0\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        .join("");
    return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

const message = (role: string, body: string) => ({
    id: ROW,
    role,
    kind: "text",
    subject: "",
    body,
    at: "2026-11-16T10:00:01.000Z"
});
const event = (kind: string) => ({ id: ROW, kind, detail: "", subject: "", at: "2026-11-16T10:00:02.000Z" });

function server(frames: [string, unknown][], options: { refuse?: number } = {}) {
    return scriptedFetch({
        "POST /api/v1/sessions": () =>
            options.refuse
                ? Response.json({ error: "This API key does not have the agents.manage permission." }, { status: options.refuse })
                : Response.json({ session: session("starting"), queuedAt: null }, { status: 201 }),
        [`GET /api/v1/sessions/${ID}`]: () => Response.json({ session: session("waiting"), cursor: `5.${ROW}~0` }),
        [`POST /api/v1/sessions/${ID}/prompt`]: () => Response.json({ sent: true }),
        [`POST /api/v1/sessions/${ID}/stop`]: () => Response.json({ stopped: true }),
        [`GET /api/v1/sessions/${ID}/events`]: () => sse(frames)
    });
}

describe("plr run", () => {
    it("starts a session, prints the answer on stdout and exits 0 at the end of the turn", async () => {
        const { fetch, seen } = server([
            ["session", session("starting")],
            ["message", message("user", "Fix the build")],
            ["event", event("tool")],
            ["message", message("agent", "Fixed.")],
            ["event", event("turn.end")]
        ]);
        const { context, stdout, stderr } = await testContext({ fetch, env });
        await run(["run", "Fix the build", "--repo", "acme/shop", "--model", "anthropic/claude-opus-4-1", "--stop"], context, clean);
        expect(stdout()).toBe("Fixed.\n");
        expect(stderr()).toContain("- tool");
        const create = seen.find((call) => call.method === "POST" && call.url.endsWith("/api/v1/sessions"))!;
        expect(create.body).toMatchObject({ prompt: "Fix the build", repo: "acme/shop", model: "anthropic/claude-opus-4-1" });
        expect(create.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        expect(seen.some((call) => call.url.endsWith(`/${ID}/stop`))).toBe(true);
    });

    it("exits 1 when the turn fails", async () => {
        const { fetch } = server([["session", session("working")], ["event", event("turn.failed")]]);
        const { context } = await testContext({ fetch, env });
        await expect(run(["run", "go"], context, clean)).rejects.toMatchObject({ exitCode: 1 });
    });

    it("exits 3 when the agent waits on an answer, and --continue answers it after the cursor", async () => {
        const waiting = server([["session", session("working")], ["session", session("waiting")]]);
        const first = await testContext({ fetch: waiting.fetch, env });
        await expect(run(["run", "go"], first.context, clean)).rejects.toMatchObject({ exitCode: 3 });

        // The snapshot on connect still says waiting; it is not taken for an answer.
        const answered = server([["session", session("waiting")], ["event", event("turn.end")]]);
        const second = await testContext({ fetch: answered.fetch, env });
        await run(["run", "--continue", ID, "yes"], second.context, clean);
        const follow = answered.seen.find((call) => call.url.endsWith("/events"))!;
        expect(follow.headers.get("last-event-id")).toBe(`5.${ROW}~0`);
        expect(answered.seen.find((call) => call.url.endsWith("/prompt"))!.body).toEqual({ text: "yes" });
    });

    it("prints every frame as JSON with --format json", async () => {
        const { fetch } = server([["session", session("working")], ["event", event("turn.end")]]);
        const { context, stdout } = await testContext({ fetch, env });
        await run(["run", "go", "--format", "json"], context, clean);
        const lines = stdout().trim().split("\n").map((line) => JSON.parse(line) as { type: string });
        expect(lines.map((line) => line.type)).toEqual(["started", "session", "event"]);
    });

    it("says which permission the key needs when it is refused", async () => {
        const { fetch } = server([], { refuse: 403 });
        const { context } = await testContext({ fetch, env });
        await expect(run(["run", "go"], context, clean)).rejects.toThrow(/agents\.manage/);
    });

    it("needs a prompt", async () => {
        const { fetch } = server([]);
        const { context } = await testContext({ fetch, env });
        await expect(run(["run"], context, clean)).rejects.toMatchObject({ exitCode: 2 });
    });
});
