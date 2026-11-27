/**
 * The browser end of a live voice call on Google's Gemini Live: a WebSocket
 * to `BidiGenerateContentConstrained`, opened with the ephemeral token the
 * server minted (`/api/polar/voice/live`), so the key never reaches the page.
 * Message shapes follow the Live API reference
 * (aistudio.google.com/api-reference/live) and Google's own WebSocket example
 * (github.com/google-gemini/gemini-live-api-examples).
 *
 * Unlike WebRTC the page carries the audio itself: an AudioWorklet takes the
 * microphone, which goes out as 16 kHz PCM (`pcm.ts`), and another plays the
 * model's 24 kHz answer from a queue the page empties the moment the server
 * says `interrupted`, which is what talking over it does.
 *
 * It answers to the same `RealtimeLink` as the OpenAI call, so the call view
 * does not know which provider it is on.
 *
 * Client-only.
 */

import type { GeminiLiveSetup, LiveGrant } from "@/lib/polar/live-voice";
import { LIVE_INPUT_MIME, microphoneChunk, voiceChunk } from "@/lib/polar/pcm";
import {
    FAILED_OUTPUT,
    type RealtimeChannel,
    type RealtimeError,
    type RealtimeLink,
    type RealtimeSnapshot
} from "@/lib/polar/realtime-link";

export const GEMINI_LIVE_SOCKET =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/** How many times a call reconnects on its resumption handle in a row. */
const RECONNECTS_MOST = 5;

/** The audio side of a call: the microphone in, the model's voice out. */
export interface LiveAudio {
    /** Each microphone block, as base64 16 kHz PCM. */
    onChunk(listener: (data: string) => void): void;
    /** Queues a block of the model's voice (base64 24 kHz PCM). */
    play(data: string): void;
    /** Drops whatever is queued: the model was talked over. */
    clear(): void;
    setMuted(muted: boolean): void;
    /** 0 to 1. */
    level(): number;
    stop(): void;
}

/** A socket as much as the link uses of one. */
export interface LiveSocket {
    readonly readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    send(data: string): void;
    close(): void;
}

export interface GeminiEnv {
    socket(url: string): LiveSocket;
    /** Opens the microphone and the player; throws when the microphone is refused. */
    audio(): Promise<LiveAudio>;
}

const WORKLET = `
class Capture extends AudioWorkletProcessor {
    constructor() { super(); this.block = new Float32Array(2048); this.filled = 0; }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) {
            for (let i = 0; i < channel.length; i++) {
                this.block[this.filled++] = channel[i];
                if (this.filled === this.block.length) { this.port.postMessage(this.block.slice()); this.filled = 0; }
            }
        }
        return true;
    }
}
class Player extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = [];
        this.at = 0;
        this.port.onmessage = (event) => {
            if (event.data === "clear") { this.queue = []; this.at = 0; } else this.queue.push(event.data);
        };
    }
    process(_inputs, outputs) {
        const out = outputs[0][0];
        let i = 0;
        while (i < out.length && this.queue.length > 0) {
            const head = this.queue[0];
            const take = Math.min(out.length - i, head.length - this.at);
            out.set(head.subarray(this.at, this.at + take), i);
            i += take;
            this.at += take;
            if (this.at >= head.length) { this.queue.shift(); this.at = 0; }
        }
        for (; i < out.length; i++) out[i] = 0;
        return true;
    }
}
registerProcessor("polar-live-capture", Capture);
registerProcessor("polar-live-player", Player);
`;

function rms(samples: Float32Array): number {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

async function browserAudio(): Promise<LiveAudio> {
    const { micConstraints } = await import("@/app/(app)/chat/mic-cleanup");
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...micConstraints(), echoCancellation: true, channelCount: 1 }
    });
    const context = new AudioContext();
    const stopAll = () => {
        for (const track of stream.getTracks()) track.stop();
        void context.close().catch(() => undefined);
    };
    try {
        const module = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        try {
            await context.audioWorklet.addModule(module);
        } finally {
            URL.revokeObjectURL(module);
        }
        await context.resume().catch(() => undefined);
        const capture = new AudioWorkletNode(context, "polar-live-capture", { numberOfOutputs: 0 });
        context.createMediaStreamSource(stream).connect(capture);
        const player = new AudioWorkletNode(context, "polar-live-player", {
            numberOfInputs: 0,
            outputChannelCount: [1]
        });
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        player.connect(analyser);
        analyser.connect(context.destination);
        const frame = new Float32Array(analyser.fftSize);
        let muted = false;
        let micLevel = 0;
        let listener: ((data: string) => void) | null = null;
        capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
            if (muted) return;
            micLevel = rms(event.data);
            listener?.(microphoneChunk(event.data, context.sampleRate));
        };
        return {
            onChunk: (next) => {
                listener = next;
            },
            play: (data) => {
                const samples = voiceChunk(data, context.sampleRate);
                if (samples.length) player.port.postMessage(samples, [samples.buffer as ArrayBuffer]);
            },
            clear: () => player.port.postMessage("clear"),
            setMuted: (next) => {
                muted = next;
                if (next) micLevel = 0;
                for (const track of stream.getAudioTracks()) track.enabled = !next;
            },
            level: () => {
                analyser.getFloatTimeDomainData(frame);
                return Math.min(1, Math.max(rms(frame), micLevel) * 4);
            },
            stop: () => {
                capture.port.onmessage = null;
                stopAll();
            }
        };
    } catch (error) {
        stopAll();
        throw error;
    }
}

function browserEnv(): GeminiEnv {
    return {
        socket: (url) => new WebSocket(url) as unknown as LiveSocket,
        audio: browserAudio
    };
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function frameText(data: unknown): Promise<string | null> {
    if (typeof data === "string") return data;
    // The server sends JSON, in binary frames as often as text ones.
    if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return null;
}

/** A tool's output (a JSON string) as the object `functionResponses` takes. */
export function toolResponseBody(output: string): Record<string, unknown> {
    try {
        const parsed = record(JSON.parse(output));
        if (parsed) return parsed;
    } catch {
        // Not JSON: handed over as it is.
    }
    return { output };
}

export function openGeminiLink(
    start: { grant: Extract<LiveGrant, { provider: "google-ai" }>; channel: RealtimeChannel },
    env: GeminiEnv = browserEnv()
): RealtimeLink {
    let state: RealtimeSnapshot = { phase: "connecting", muted: false, busy: false, caption: null, heard: null, error: null };
    const { channel } = start;
    const listeners = new Set<() => void>();
    const pending = new AbortController();
    let closed = false;
    let audio: LiveAudio | null = null;
    let socket: LiveSocket | null = null;
    let ready = false;
    let handle: string | null = null;
    let reconnects = 0;
    /** What you are saying, as it is transcribed. */
    let hearing = "";
    /** What the reply under way has said so far. */
    let saying = "";
    /** The next reply reads tool output: it answers a delegated request. */
    let afterTool = false;
    const cancelled = new Set<string>();
    let running: Promise<void> = Promise.resolve();

    const set = (next: Partial<RealtimeSnapshot>) => {
        state = { ...state, ...next };
        for (const listener of listeners) listener();
    };
    const teardown = () => {
        pending.abort();
        audio?.stop();
        audio = null;
        const open = socket;
        socket = null;
        if (open) {
            open.onclose = null;
            open.onmessage = null;
            open.close();
        }
    };
    const fail = (error: RealtimeError) => {
        if (closed) return;
        teardown();
        set({ phase: "failed", busy: false, error });
    };
    const send = (message: unknown) => {
        if (socket?.readyState === 1) socket.send(JSON.stringify(message));
    };

    const flushHeard = () => {
        const text = hearing.trim();
        hearing = "";
        if (text) channel.onLive?.({ type: "heard", text });
    };
    const endTurn = () => {
        flushHeard();
        channel.onLive?.({ type: "said", text: saying.trim(), via: afterTool ? "reading" : "direct" });
        saying = "";
        afterTool = false;
    };

    const respond = (calls: Array<{ id: string; name: string; args: unknown }>) => {
        running = running.then(async () => {
            if (closed) return;
            set({ busy: true });
            const responses: Array<Record<string, unknown>> = [];
            for (const call of calls) {
                let output: string;
                try {
                    output = await channel.runTool(
                        { name: call.name, callId: call.id, arguments: JSON.stringify(call.args ?? {}) },
                        pending.signal
                    );
                } catch {
                    output = FAILED_OUTPUT;
                }
                if (closed) return;
                if (!cancelled.has(call.id)) responses.push({ id: call.id, name: call.name, response: toolResponseBody(output) });
            }
            afterTool = responses.length > 0;
            if (responses.length) send({ toolResponse: { functionResponses: responses } });
            set({ busy: false });
        });
    };

    const handleMessage = (message: Record<string, unknown>) => {
        if ("setupComplete" in message) {
            ready = true;
            reconnects = 0;
            set({ phase: "live" });
            return;
        }
        const resumption = record(message.sessionResumptionUpdate);
        if (resumption?.resumable && typeof resumption.newHandle === "string" && resumption.newHandle) {
            handle = resumption.newHandle;
        }
        const content = record(message.serverContent);
        if (content) {
            const input = record(content.inputTranscription);
            if (typeof input?.text === "string" && input.text) {
                hearing += input.text;
                set({ heard: hearing.trim() || state.heard });
            }
            const output = record(content.outputTranscription);
            if (typeof output?.text === "string" && output.text) {
                saying += output.text;
                set({ caption: saying.trim() });
            }
            const parts = record(content.modelTurn)?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    const inline = record(record(part)?.inlineData);
                    const mime = typeof inline?.mimeType === "string" ? inline.mimeType : "";
                    if (typeof inline?.data === "string" && mime.startsWith("audio/pcm")) audio?.play(inline.data);
                }
            }
            if (content.interrupted === true) {
                audio?.clear();
                endTurn();
            }
            if (content.turnComplete === true) endTurn();
        }
        const toolCall = record(message.toolCall);
        if (toolCall && Array.isArray(toolCall.functionCalls)) {
            const calls: Array<{ id: string; name: string; args: unknown }> = [];
            for (const item of toolCall.functionCalls) {
                const entry = record(item);
                if (typeof entry?.id !== "string" || typeof entry.name !== "string") continue;
                calls.push({ id: entry.id, name: entry.name, args: entry.args });
            }
            if (calls.length) {
                flushHeard();
                channel.onLive?.({ type: "said", text: saying.trim(), via: "call" });
                saying = "";
                respond(calls);
            }
        }
        const cancellation = record(message.toolCallCancellation);
        if (cancellation && Array.isArray(cancellation.ids)) {
            for (const id of cancellation.ids) if (typeof id === "string") cancelled.add(id);
        }
    };

    const connectSocket = () => {
        ready = false;
        const url = `${GEMINI_LIVE_SOCKET}?access_token=${encodeURIComponent(start.grant.token)}`;
        const next = env.socket(url);
        socket = next;
        const setup: GeminiLiveSetup = handle
            ? { ...start.grant.setup, sessionResumption: { handle } }
            : start.grant.setup;
        next.onopen = () => {
            if (socket === next) next.send(JSON.stringify({ setup }));
        };
        next.onmessage = (event) => {
            void frameText(event.data).then((text) => {
                if (!text || socket !== next || closed) return;
                let message: Record<string, unknown> | null;
                try {
                    message = record(JSON.parse(text));
                } catch {
                    return;
                }
                if (message) handleMessage(message);
            });
        };
        next.onerror = () => undefined;
        next.onclose = () => {
            if (closed || socket !== next) return;
            socket = null;
            // A connection lasts about ten minutes: go on where it was.
            if (handle && reconnects < RECONNECTS_MOST && state.phase === "live") {
                reconnects += 1;
                connectSocket();
                return;
            }
            fail("failed");
        };
    };

    const connect = async () => {
        try {
            audio = await env.audio();
        } catch {
            return fail("mic_denied");
        }
        if (closed) return teardown();
        audio.setMuted(state.muted);
        audio.onChunk((data) => {
            if (ready && !state.muted) send({ realtimeInput: { audio: { data, mimeType: LIVE_INPUT_MIME } } });
        });
        connectSocket();
    };

    void connect().catch(() => fail("failed"));

    return {
        snapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        bind: () => undefined,
        setMuted: (muted) => {
            audio?.setMuted(muted);
            // What was said so far is a whole turn: the server need not wait for more.
            if (muted && ready) send({ realtimeInput: { audioStreamEnd: true } });
            set({ muted });
        },
        level: () => (state.muted && !saying ? 0 : (audio?.level() ?? 0)),
        close: () => {
            if (closed) return;
            closed = true;
            teardown();
            set({ phase: "closed", busy: false });
            listeners.clear();
        }
    };
}
