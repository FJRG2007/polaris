/**
 * The browser end of a realtime voice call on a Code session: a WebRTC
 * connection to OpenAI's realtime model, opened with a one-minute secret the
 * server mints (`/api/polar/voice/realtime`) so the key never reaches the
 * page, as developers.openai.com/api/docs/guides/realtime-webrtc describes:
 * the microphone as a track, the model's voice as the remote one, and its
 * events on the `oai-events` data channel.
 *
 * The model's tool calls arrive in `response.done`; each is run by
 * `/api/polar/voice/realtime/tool` with the delegator's tools, its output sent
 * back as a `function_call_output` item, and the model asked to go on.
 *
 * The link is an object, not a component, so Polar Code can keep it above the
 * session view: showing another session rebinds it, and the call goes on.
 *
 * Client-only.
 */

import { measureVoice, type VoiceLevel } from "@/app/(app)/chat/voice-level";
import {
    VOICE_TAIL_LINE_MAX,
    VOICE_TAIL_MOST,
    type RealtimeGrant,
    type RealtimeToolAnswer
} from "@/lib/polar/voice-call";

export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimePhase = "connecting" | "live" | "failed" | "closed";
export type RealtimeError = "no_key" | "mic_denied" | "failed" | "rate_limited";

export interface RealtimeSnapshot {
    readonly phase: RealtimePhase;
    readonly muted: boolean;
    /** A tool call is running. */
    readonly busy: boolean;
    /** What the model said last. */
    readonly caption: string | null;
    readonly error: RealtimeError | null;
}

/** The session view the call is on now. */
export interface RealtimeBinding {
    readonly sessionId: string;
    /** A tool showed another session. */
    readonly onOpen: (sessionId: string) => void;
}

export interface RealtimeLink {
    snapshot(): RealtimeSnapshot;
    subscribe(listener: () => void): () => void;
    bind(binding: RealtimeBinding): void;
    setMuted(muted: boolean): void;
    /** 0 to 1: the model's voice while it speaks, else the microphone. */
    level(): number;
    close(): void;
}

/** What the link reaches the outside world through; a test hands fakes. */
export interface RealtimeEnv {
    fetch: typeof fetch;
    microphone: () => Promise<MediaStream>;
    peer: () => RTCPeerConnection;
    audio: () => HTMLAudioElement | null;
    meter: (track: MediaStreamTrack) => VoiceLevel | null;
}

function browserEnv(): RealtimeEnv {
    return {
        fetch: (...args) => fetch(...args),
        microphone: async () => {
            const { micConstraints } = await import("@/app/(app)/chat/mic-cleanup");
            return navigator.mediaDevices.getUserMedia({ audio: { ...micConstraints(), echoCancellation: true } });
        },
        peer: () => new RTCPeerConnection(),
        audio: () => {
            const element = document.createElement("audio");
            element.autoplay = true;
            return element;
        },
        meter: measureVoice
    };
}

/** A function call the model asked for, from a `response.done` event. */
export interface RealtimeCall {
    readonly name: string;
    readonly callId: string;
    readonly arguments: string;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The function calls of a `response.done` event, in order; anything malformed skipped. */
export function functionCalls(event: unknown): RealtimeCall[] {
    const output = record(record(event)?.response)?.output;
    if (!Array.isArray(output)) return [];
    const calls: RealtimeCall[] = [];
    for (const item of output) {
        const entry = record(item);
        if (entry?.type !== "function_call") continue;
        const { name, call_id, arguments: args } = entry;
        if (typeof name !== "string" || typeof call_id !== "string") continue;
        calls.push({ name, callId: call_id, arguments: typeof args === "string" ? args : "" });
    }
    return calls;
}

const FAILED_OUTPUT = JSON.stringify({ error: "Tool request failed. Do not claim it succeeded." });

export function openRealtimeLink(
    start: { binding: RealtimeBinding; lang: string | null },
    env: RealtimeEnv = browserEnv()
): RealtimeLink {
    let state: RealtimeSnapshot = { phase: "connecting", muted: false, busy: false, caption: null, error: null };
    let binding = start.binding;
    const listeners = new Set<() => void>();
    const tail: string[] = [];
    let explained: Record<string, number> = {};
    let closed = false;
    let microphone: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let channel: RTCDataChannel | null = null;
    let audio: HTMLAudioElement | null = null;
    let micLevel: VoiceLevel | null = null;
    let voiceLevel: VoiceLevel | null = null;
    const pending = new AbortController();
    /** Tool calls run one batch after another, in the order they came. */
    let running: Promise<void> = Promise.resolve();

    const set = (next: Partial<RealtimeSnapshot>) => {
        state = { ...state, ...next };
        for (const listener of listeners) listener();
    };
    const teardown = () => {
        pending.abort();
        micLevel?.stop();
        voiceLevel?.stop();
        for (const track of microphone?.getTracks() ?? []) track.stop();
        channel?.close();
        peer?.close();
        if (audio) audio.srcObject = null;
        microphone = null;
        peer = null;
        channel = null;
    };
    const fail = (error: RealtimeError) => {
        if (closed) return;
        teardown();
        set({ phase: "failed", busy: false, error });
    };
    const remember = (line: string) => {
        tail.push(line.slice(0, VOICE_TAIL_LINE_MAX));
        tail.splice(0, Math.max(0, tail.length - VOICE_TAIL_MOST));
    };
    const send = (event: unknown) => {
        if (channel?.readyState === "open") channel.send(JSON.stringify(event));
    };

    const runTool = async (call: RealtimeCall): Promise<string> => {
        try {
            const response = await env.fetch("/api/polar/voice/realtime/tool", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId: binding.sessionId,
                    name: call.name,
                    arguments: call.arguments,
                    tail,
                    explained
                }),
                signal: pending.signal
            });
            if (!response.ok) return FAILED_OUTPUT;
            const answer = (await response.json()) as RealtimeToolAnswer;
            explained = answer.explained;
            if (answer.open && answer.open !== binding.sessionId) {
                // Later calls default to the session now on screen.
                const onOpen = binding.onOpen;
                binding = { ...binding, sessionId: answer.open };
                onOpen(answer.open);
            }
            return answer.output;
        } catch {
            return FAILED_OUTPUT;
        }
    };

    const respond = (calls: RealtimeCall[]) => {
        running = running.then(async () => {
            if (closed) return;
            set({ busy: true });
            for (const call of calls) {
                const output = await runTool(call);
                if (closed) return;
                send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.callId, output } });
            }
            send({ type: "response.create" });
            set({ busy: false });
        });
    };

    const heard = (data: unknown) => {
        if (typeof data !== "string") return;
        let event: Record<string, unknown> | null;
        try {
            event = record(JSON.parse(data));
        } catch {
            return;
        }
        if (!event) return;
        if (event.type === "response.output_audio_transcript.done") {
            const said = typeof event.transcript === "string" ? event.transcript.trim() : "";
            if (said) {
                remember(`assistant: ${said}`);
                set({ caption: said });
            }
        } else if (event.type === "response.done") {
            const calls = functionCalls(event);
            if (calls.length > 0) respond(calls);
        }
    };

    const connect = async () => {
        const opened = await env.fetch("/api/polar/voice/realtime", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: binding.sessionId, lang: start.lang }),
            signal: pending.signal
        });
        if (!opened.ok) {
            const { error } = (await opened.json().catch(() => ({}))) as { error?: string };
            return fail(error === "no_key" ? "no_key" : error === "rate_limited" ? "rate_limited" : "failed");
        }
        const grant = (await opened.json()) as RealtimeGrant;
        if (closed) return;
        try {
            microphone = await env.microphone();
        } catch {
            return fail("mic_denied");
        }
        // Ended while the browser asked: the microphone it opened is let go.
        if (closed) return teardown();
        const track = microphone.getAudioTracks()[0];
        if (!track) return fail("mic_denied");
        track.enabled = !state.muted;
        micLevel = env.meter(track);

        peer = env.peer();
        audio = env.audio();
        peer.ontrack = (event) => {
            if (audio) audio.srcObject = event.streams[0] ?? null;
            voiceLevel?.stop();
            voiceLevel = env.meter(event.track);
        };
        peer.onconnectionstatechange = () => {
            if (peer?.connectionState === "failed") fail("failed");
        };
        peer.addTrack(track, microphone);
        channel = peer.createDataChannel("oai-events");
        channel.onopen = () => {
            if (!closed) set({ phase: "live" });
        };
        channel.onmessage = (event) => heard(event.data);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const answer = await env.fetch(REALTIME_CALLS_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${grant.value}`, "Content-Type": "application/sdp" },
            body: offer.sdp ?? "",
            signal: pending.signal
        });
        if (!answer.ok) return fail("failed");
        const sdp = await answer.text();
        if (closed || !peer) return;
        await peer.setRemoteDescription({ type: "answer", sdp });
    };

    void connect().catch(() => fail("failed"));

    return {
        snapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        bind: (next) => {
            binding = next;
        },
        setMuted: (muted) => {
            for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !muted;
            set({ muted });
        },
        level: () => {
            const voice = voiceLevel?.read() ?? 0;
            const mic = state.muted ? 0 : (micLevel?.read() ?? 0);
            return Math.min(1, Math.max(voice, mic) / 100);
        },
        close: () => {
            if (closed) return;
            closed = true;
            teardown();
            set({ phase: "closed", busy: false });
            listeners.clear();
        }
    };
}
