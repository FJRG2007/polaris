/**
 * Opens a live voice call in a Polar chat on whichever provider the server
 * minted for (`/api/polar/voice/live` answers a `LiveGrant`): OpenAI over
 * WebRTC (`realtime-link.ts`) or Gemini Live over a WebSocket
 * (`gemini-live-link.ts`). The call view holds one `RealtimeLink` either way;
 * until the grant is in, this one stands for it.
 *
 * Client-only.
 */

import type { LiveGrant } from "@/lib/polar/live-voice";
import { openGeminiLink } from "@/lib/polar/gemini-live-link";
import {
    mintError,
    openRealtimeLink,
    type RealtimeChannel,
    type RealtimeLink,
    type RealtimeSnapshot
} from "@/lib/polar/realtime-link";

export interface LiveLinkEnv {
    fetch: typeof fetch;
    openai: (grant: Extract<LiveGrant, { provider: "openai" }>, channel: RealtimeChannel) => RealtimeLink;
    google: (grant: Extract<LiveGrant, { provider: "google-ai" }>, channel: RealtimeChannel) => RealtimeLink;
}

const browserEnv = (lang: string | null, threadId: string): LiveLinkEnv => ({
    fetch: (...args) => fetch(...args),
    openai: (grant, channel) =>
        openRealtimeLink({
            binding: { sessionId: threadId, onOpen: () => undefined },
            lang,
            channel: { ...channel, grant: { value: grant.value, expiresAt: grant.expiresAt } }
        }),
    google: (grant, channel) => openGeminiLink({ grant, channel })
});

/** Reads the route's answer; anything else is no grant. */
export function readGrant(value: unknown): LiveGrant | null {
    if (!value || typeof value !== "object") return null;
    const grant = value as Record<string, unknown>;
    if (typeof grant.expiresAt !== "number") return null;
    if (grant.provider === "google-ai") {
        const setup = grant.setup as Record<string, unknown> | null;
        return typeof grant.token === "string" && setup && typeof setup.model === "string"
            ? (grant as unknown as LiveGrant)
            : null;
    }
    // An answer without a provider predates Gemini: it is OpenAI's.
    if (grant.provider !== undefined && grant.provider !== "openai") return null;
    return typeof grant.value === "string" ? { provider: "openai", value: grant.value, expiresAt: grant.expiresAt } : null;
}

export function openLiveLink(
    start: { threadId: string; lang: string | null; channel: RealtimeChannel },
    env: LiveLinkEnv = browserEnv(start.lang, start.threadId)
): RealtimeLink {
    let state: RealtimeSnapshot = { phase: "connecting", muted: false, busy: false, caption: null, heard: null, error: null };
    const listeners = new Set<() => void>();
    const pending = new AbortController();
    let inner: RealtimeLink | null = null;
    let closed = false;
    const notify = () => {
        for (const listener of listeners) listener();
    };
    const set = (next: Partial<RealtimeSnapshot>) => {
        state = { ...state, ...next };
        notify();
    };

    const connect = async () => {
        const opened = await env.fetch(start.channel.mint.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(start.channel.mint.body),
            signal: pending.signal
        });
        if (!opened.ok) {
            const { error } = (await opened.json().catch(() => ({}))) as { error?: string };
            return set({ phase: "failed", error: mintError(error) });
        }
        const grant = readGrant(await opened.json().catch(() => null));
        if (closed) return;
        if (!grant) return set({ phase: "failed", error: "failed" });
        const link = grant.provider === "google-ai" ? env.google(grant, start.channel) : env.openai(grant, start.channel);
        inner = link;
        // Muted while it was opening: it opens muted.
        if (state.muted) link.setMuted(true);
        link.subscribe(() => {
            state = link.snapshot();
            notify();
        });
        state = link.snapshot();
        notify();
    };

    void connect().catch(() => {
        if (!closed) set({ phase: "failed", error: "failed" });
    });

    return {
        snapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        bind: (binding) => inner?.bind(binding),
        setMuted: (muted) => {
            if (inner) inner.setMuted(muted);
            else set({ muted });
        },
        level: () => inner?.level() ?? 0,
        close: () => {
            if (closed) return;
            closed = true;
            pending.abort();
            inner?.close();
            state = { ...state, phase: "closed", busy: false };
            notify();
            listeners.clear();
        }
    };
}
