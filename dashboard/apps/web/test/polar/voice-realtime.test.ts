/**
 * Realtime voice on a Code call: the client secret minted on the person's key
 * (which never comes back), the delegator's tools as realtime functions, one
 * tool call run with the same tools, and the browser link driven over fake
 * WebRTC - opened with the secret, tool calls answered on the data channel,
 * and kept on the session a tool showed.
 */

import { describe, expect, it, vi } from "vitest";
import type { DelegateDeps } from "@/lib/polar/voice-delegate";
import { realtimeToolBodySchema } from "@/lib/polar/voice-call";
import type { PolarCodeRow, PolarCodeThread } from "@/lib/polar/code";
import {
    REALTIME_MODEL,
    REALTIME_SECRETS_URL,
    mintRealtimeSecret,
    realtimeTools,
    runRealtimeTool
} from "@/lib/polar/voice-realtime";
import { REALTIME_CALLS_URL, functionCalls, openRealtimeLink, type RealtimeEnv } from "@/lib/polar/realtime-link";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "sk-fixture-own-key";

function row(id: string, title: string): PolarCodeRow {
    return { id, title, repo: "acme/app", branch: "main", state: "idle", stateLabel: "idle", live: true, createdAt: "2026-11-16T10:00:00.000Z" };
}

function thread(session: PolarCodeRow): PolarCodeThread {
    return { session, entries: [], error: null, permission: null } as unknown as PolarCodeThread;
}

function fakeDeps() {
    const prompts: Array<{ sessionId: string; text: string }> = [];
    const threads: Record<string, PolarCodeThread> = { [A]: thread(row(A, "Login")), [B]: thread(row(B, "Billing")) };
    const deps: DelegateDeps = {
        list: async () => [row(A, "Login"), row(B, "Billing")],
        thread: async (id) => threads[id] ?? null,
        prompt: async (sessionId, text) => {
            prompts.push({ sessionId, text });
            return {};
        },
        interrupt: async () => ({}),
        model: async () => ({}),
        models: async () => null,
        create: async () => ({ id: B }),
        sleep: async () => undefined
    };
    return { deps, prompts };
}

describe("the realtime client secret", () => {
    it("is minted on the person's key with the delegator's tools, and the key never comes back", async () => {
        const send = vi.fn(async () => Response.json({ value: "ek_fixture", expires_at: 1_800_000_000 }));
        const grant = await mintRealtimeSecret({
            apiKey: KEY,
            viewed: { id: A, title: "Login" },
            lang: "es-ES",
            fetch: send as unknown as typeof fetch
        });
        expect(grant).toEqual({ value: "ek_fixture", expiresAt: 1_800_000_000 });
        expect(JSON.stringify(grant)).not.toContain(KEY);

        const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(REALTIME_SECRETS_URL);
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
        const body = JSON.parse(String(init.body));
        expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 });
        expect(body.session).toMatchObject({
            type: "realtime",
            model: REALTIME_MODEL,
            audio: { output: { voice: "marin" } },
            tool_choice: "auto"
        });
        expect(body.session.instructions).toContain('"es-ES"');
        expect(body.session.instructions).toContain(A);
        const send_message = body.session.tools.find((tool: { name: string }) => tool.name === "send_message");
        expect(send_message).toMatchObject({ type: "function", parameters: { type: "object" } });
        expect(send_message.parameters.properties).toHaveProperty("text");
    });

    it("is null when OpenAI refuses or answers something else", async () => {
        const refused = vi.fn(async () => new Response("no", { status: 401 }));
        expect(
            await mintRealtimeSecret({ apiKey: KEY, viewed: { id: A, title: "x" }, lang: null, fetch: refused as never })
        ).toBeNull();
        const odd = vi.fn(async () => Response.json({ secret: "?" }));
        expect(
            await mintRealtimeSecret({ apiKey: KEY, viewed: { id: A, title: "x" }, lang: null, fetch: odd as never })
        ).toBeNull();
    });

    it("carries every delegator tool", async () => {
        const names = (await realtimeTools()).map((tool) => tool.name);
        expect(names).toEqual(
            expect.arrayContaining(["list_sessions", "read_session", "send_message", "open_session", "create_session"])
        );
    });
});

describe("a realtime tool call", () => {
    const base = { tail: [] as string[], explained: {}, signal: new AbortController().signal };

    it("sends work through the same tool, defaulting to the session on screen", async () => {
        const { deps, prompts } = fakeDeps();
        const answer = await runRealtimeTool({
            ...base,
            deps,
            viewed: A,
            name: "send_message",
            arguments: JSON.stringify({ text: "Fix the login test" })
        });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]!.sessionId).toBe(A);
        expect(prompts[0]!.text).toContain("Fix the login test");
        expect(JSON.parse(answer.output)).toEqual({ sent: A });
        expect(answer.sent.map((entry) => entry.sessionId)).toEqual([A]);
        expect(answer.explained[A]).toBeGreaterThan(0);
    });

    it("says which session to show", async () => {
        const { deps } = fakeDeps();
        const answer = await runRealtimeTool({ ...base, deps, viewed: A, name: "open_session", arguments: JSON.stringify({ session_id: B }) });
        expect(answer.open).toBe(B);
    });

    it("answers a bad name or bad arguments to the model, and does nothing", async () => {
        const { deps, prompts } = fakeDeps();
        const unknown = await runRealtimeTool({ ...base, deps, viewed: A, name: "delete_everything", arguments: "{}" });
        expect(JSON.parse(unknown.output)).toHaveProperty("error");
        const notJson = await runRealtimeTool({ ...base, deps, viewed: A, name: "send_message", arguments: "{text:" });
        expect(JSON.parse(notJson.output)).toHaveProperty("error");
        const wrong = await runRealtimeTool({
            ...base,
            deps,
            viewed: A,
            name: "send_message",
            arguments: JSON.stringify({ session_id: "not-a-session", text: "hi" })
        });
        expect(JSON.parse(wrong.output)).toHaveProperty("error");
        // Inherited names are not tools either.
        const inherited = await runRealtimeTool({ ...base, deps, viewed: A, name: "constructor", arguments: "{}" });
        expect(JSON.parse(inherited.output)).toHaveProperty("error");
        expect(prompts).toHaveLength(0);
    });

    it("refuses arguments past the cap", () => {
        const body = { sessionId: A, name: "send_message", arguments: "x".repeat(16 * 1024 + 1) };
        expect(realtimeToolBodySchema.safeParse(body).success).toBe(false);
        expect(realtimeToolBodySchema.safeParse({ ...body, arguments: "{}" }).success).toBe(true);
        expect(realtimeToolBodySchema.safeParse({ ...body, arguments: "{}", name: "Bad Name" }).success).toBe(false);
    });
});

describe("the function calls of a response", () => {
    it("reads function calls in order and skips anything else", () => {
        expect(
            functionCalls({
                type: "response.done",
                response: {
                    output: [
                        { type: "message", content: [] },
                        { type: "function_call", name: "read_session", call_id: "c1", arguments: "{}" },
                        { type: "function_call", name: 5, call_id: "c2" },
                        { type: "function_call", name: "list_sessions", call_id: "c3" }
                    ]
                }
            })
        ).toEqual([
            { name: "read_session", callId: "c1", arguments: "{}" },
            { name: "list_sessions", callId: "c3", arguments: "" }
        ]);
        expect(functionCalls({ type: "response.done" })).toEqual([]);
        expect(functionCalls(null)).toEqual([]);
    });
});

/** A WebRTC stand-in: records what was sent, and lets the test deliver events. */
function fakeEnv(routes: (url: string, init: RequestInit) => Response) {
    const sent: unknown[] = [];
    const fetches: Array<{ url: string; init: RequestInit }> = [];
    const track = { enabled: true, stop: vi.fn() };
    const channel = {
        readyState: "connecting",
        onopen: null as null | (() => void),
        onmessage: null as null | ((event: { data: string }) => void),
        send: (data: string) => sent.push(JSON.parse(data)),
        close: vi.fn()
    };
    const peer = {
        ontrack: null,
        onconnectionstatechange: null,
        connectionState: "new",
        addTrack: vi.fn(),
        createDataChannel: vi.fn(() => channel),
        createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
        setLocalDescription: vi.fn(async () => undefined),
        setRemoteDescription: vi.fn(async () => undefined),
        close: vi.fn()
    };
    const env: RealtimeEnv = {
        fetch: (async (url: string, init: RequestInit) => {
            fetches.push({ url, init });
            return routes(url, init);
        }) as unknown as typeof fetch,
        microphone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
        peer: () => peer as unknown as RTCPeerConnection,
        audio: () => null,
        meter: () => null
    };
    const open = () => {
        channel.readyState = "open";
        channel.onopen?.();
    };
    const deliver = (event: unknown) => channel.onmessage?.({ data: JSON.stringify(event) });
    return { env, sent, fetches, track, channel, peer, open, deliver };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the realtime link", () => {
    it("opens with the minted secret, answers tool calls, and follows a session it showed", async () => {
        const toolBodies: Array<Record<string, unknown>> = [];
        const fake = fakeEnv((url, init) => {
            if (url === "/api/polar/voice/realtime") return Response.json({ value: "ek_fixture", expiresAt: 1 });
            if (url === REALTIME_CALLS_URL) return new Response("v=0 answer");
            if (url === "/api/polar/voice/realtime/tool") {
                const body = JSON.parse(String(init.body));
                toolBodies.push(body);
                return Response.json(
                    body.name === "open_session"
                        ? { output: '{"opened":"Billing"}', open: B, sent: [], explained: {} }
                        : { output: '{"sent":"x"}', open: null, sent: [], explained: { [B]: 7 } }
                );
            }
            return new Response("unexpected", { status: 500 });
        });
        const opened: string[] = [];
        const link = openRealtimeLink(
            { binding: { sessionId: A, onOpen: (id) => opened.push(id) }, lang: "en-US" },
            fake.env
        );
        expect(link.snapshot().phase).toBe("connecting");
        await vi.waitFor(() => expect(fake.peer.setRemoteDescription).toHaveBeenCalled());

        const mint = fake.fetches[0]!;
        expect(JSON.parse(String(mint.init.body))).toEqual({ sessionId: A, lang: "en-US" });
        const call = fake.fetches.find((entry) => entry.url === REALTIME_CALLS_URL)!;
        expect(call.init.headers).toMatchObject({ Authorization: "Bearer ek_fixture", "Content-Type": "application/sdp" });
        expect(call.init.body).toBe("v=0 offer");
        expect(fake.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
        expect(fake.peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "v=0 answer" });

        fake.open();
        expect(link.snapshot().phase).toBe("live");

        fake.deliver({ type: "response.output_audio_transcript.done", transcript: "Opening Billing." });
        expect(link.snapshot().caption).toBe("Opening Billing.");

        fake.deliver({
            type: "response.done",
            response: { output: [{ type: "function_call", name: "open_session", call_id: "c1", arguments: JSON.stringify({ session_id: B }) }] }
        });
        await vi.waitFor(() => expect(fake.sent).toContainEqual({ type: "response.create" }));
        expect(fake.sent[0]).toEqual({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: "c1", output: '{"opened":"Billing"}' }
        });
        expect(opened).toEqual([B]);
        expect(toolBodies[0]).toMatchObject({ sessionId: A, name: "open_session", tail: ["assistant: Opening Billing."] });

        // The next call defaults to the session now on screen, with what the last one explained.
        fake.deliver({
            type: "response.done",
            response: { output: [{ type: "function_call", name: "send_message", call_id: "c2", arguments: '{"text":"go"}' }] }
        });
        await vi.waitFor(() => expect(toolBodies).toHaveLength(2));
        expect(toolBodies[1]).toMatchObject({ sessionId: B, name: "send_message" });
        await vi.waitFor(() => expect(link.snapshot().busy).toBe(false));

        link.setMuted(true);
        expect(fake.track.enabled).toBe(false);
        expect(link.snapshot().muted).toBe(true);

        link.close();
        expect(fake.track.stop).toHaveBeenCalled();
        expect(fake.peer.close).toHaveBeenCalled();
        expect(link.snapshot().phase).toBe("closed");
    });

    it("answers a failed tool call as failed, never as done", async () => {
        const fake = fakeEnv((url) => {
            if (url === "/api/polar/voice/realtime") return Response.json({ value: "ek_fixture", expiresAt: 1 });
            if (url === REALTIME_CALLS_URL) return new Response("v=0 answer");
            return Response.json({ error: "failed" }, { status: 502 });
        });
        const link = openRealtimeLink({ binding: { sessionId: A, onOpen: () => undefined }, lang: null }, fake.env);
        await vi.waitFor(() => expect(fake.peer.setRemoteDescription).toHaveBeenCalled());
        fake.open();
        fake.deliver({
            type: "response.done",
            response: { output: [{ type: "function_call", name: "read_session", call_id: "c9", arguments: "{}" }] }
        });
        await vi.waitFor(() => expect(fake.sent).toContainEqual({ type: "response.create" }));
        const output = (fake.sent[0] as { item: { output: string } }).item.output;
        expect(JSON.parse(output).error).toContain("Do not claim it succeeded");
        link.close();
    });

    it("fails with no_key when the person holds no OpenAI key, without touching the microphone", async () => {
        const fake = fakeEnv(() => Response.json({ error: "no_key" }, { status: 409 }));
        const microphone = vi.spyOn(fake.env, "microphone");
        const link = openRealtimeLink({ binding: { sessionId: A, onOpen: () => undefined }, lang: null }, fake.env);
        await vi.waitFor(() => expect(link.snapshot().phase).toBe("failed"));
        expect(link.snapshot().error).toBe("no_key");
        expect(microphone).not.toHaveBeenCalled();
        await settle();
        expect(fake.peer.createDataChannel).not.toHaveBeenCalled();
    });

    it("fails with mic_denied when the microphone is refused", async () => {
        const fake = fakeEnv(() => Response.json({ value: "ek_fixture", expiresAt: 1 }));
        fake.env.microphone = async () => {
            throw new DOMException("denied", "NotAllowedError");
        };
        const link = openRealtimeLink({ binding: { sessionId: A, onOpen: () => undefined }, lang: null }, fake.env);
        await vi.waitFor(() => expect(link.snapshot().error).toBe("mic_denied"));
    });
});
