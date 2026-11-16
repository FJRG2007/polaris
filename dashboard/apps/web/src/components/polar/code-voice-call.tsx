"use client";

/**
 * A voice call on a Code session: Chat's own call (`VoiceCall` - the same
 * microphone, transcription, voices and barge-in), with each turn handed to the
 * voice delegator (`/api/polar/voice/delegate`) instead of a chat. The
 * delegator acts on the person's sessions and answers in a sentence or three,
 * which the call says; when it sent a session work, the session's reply is read
 * aloud once its turn ends, the way OpenCode's voice announces a session's
 * answer - a session not on screen is named first ("From <title>"). What is to
 * be said waits its turn: one thing at a time, and only into a quiet call.
 * Talking over it stops the voice and the turn of the call, never the agent's
 * work.
 */

import type { ChatStatus, UIMessage } from "ai";
import type { PolarCodeThread } from "@/lib/polar/code";
import { VoiceCall } from "@/components/polar/polar-voice";
import { useCallback, useEffect, useRef, useState } from "react";
import { readPoll } from "@/lib/poll-fetch";
import { parseVoiceDelegation } from "@/lib/polar/voice-handoff";
import type { PolarVoiceKit } from "@/components/polar/polar-composer";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    SPEAK_TEXT_MAX,
    VOICE_TAIL_LINE_MAX,
    VOICE_TAIL_MOST,
    speaksAnything,
    type VoiceDelegateAnswer
} from "@/lib/polar/voice-call";

/** A line of the call as `VoiceCall` reads it. */
function line(id: string, role: "user" | "assistant", text: string): UIMessage {
    return { id, role, parts: [{ type: "text", text }] };
}

function textOf(message: UIMessage): string {
    return message.parts.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

/** The call so far, as the delegator reads it: newest lines, each cut short. */
export function callTail(messages: readonly UIMessage[]): string[] {
    return messages
        .slice(-VOICE_TAIL_MOST)
        .map((message) => `${message.role}: ${textOf(message)}`.slice(0, VOICE_TAIL_LINE_MAX));
}

/** What of a session's reply is read aloud: its opening paragraph, which the
 *  voice handoff asks it to write for that. */
export function replyLead(text: string): string {
    const first = text.trim().split(/\n\s*\n/)[0] ?? "";
    return first.slice(0, SPEAK_TEXT_MAX * 2);
}

/** The reply a session wrote after `since`, once its turn has ended; null while
 *  it works or when it wrote nothing. */
export function landedReply(
    thread: Pick<PolarCodeThread, "entries" | "session">,
    since: string
): { at: string; text: string } | null {
    if (thread.session.state === "working" || thread.session.state === "starting") return null;
    const after = thread.entries.filter(
        (entry) => entry.type === "message" && entry.role === "assistant" && entry.at > since
    );
    const last = after.at(-1);
    return last && last.text.trim() ? { at: last.at, text: last.text } : null;
}

/** Work the call sent a session, whose reply it is waiting to read aloud. */
export interface VoiceWatch {
    readonly sessionId: string;
    /** When it was sent: the reply is what the session wrote after. */
    readonly since: string;
}

/** How long a reply is waited for before the call lets it go. */
const WATCH_MS = 30 * 60_000;
/** How often a session not on screen is read for its reply. */
const WATCH_POLL_MS = 4000;
/** Sessions not on screen read at once; the oldest beyond this are let go. */
const WATCH_MOST = 4;
/** How much of a session's title is said before its reply. */
const TITLE_SAID = 60;

/** What a watched session has for the call: its reply, its question, that it
 *  ended without one, or nothing yet. */
export type WatchNews =
    | { readonly kind: "reply"; readonly at: string; readonly text: string }
    | { readonly kind: "asks" }
    | { readonly kind: "gone" }
    | null;

export function watchNews(
    thread: Pick<PolarCodeThread, "entries" | "session" | "permission">,
    since: string
): WatchNews {
    if (thread.permission) return { kind: "asks" };
    const reply = landedReply(thread, since);
    if (reply) return { kind: "reply", ...reply };
    return thread.session.live ? null : { kind: "gone" };
}

/** The watches a session's news settles: a reply answers everything sent
 *  before it, a question or an end everything sent to it. */
export function settle(
    watches: readonly VoiceWatch[],
    sessionId: string,
    news: Exclude<WatchNews, null>
): VoiceWatch[] {
    return watches.filter(
        (watch) => watch.sessionId !== sessionId || (news.kind === "reply" && watch.since > news.at)
    );
}

/** A session's title as said before its reply. */
export function saidTitle(title: string): string {
    const clean = title.replace(/\s+/g, " ").trim();
    return clean.length > TITLE_SAID ? `${clean.slice(0, TITLE_SAID - 3).trimEnd()}...` : clean;
}

export function CodeVoiceCall({
    sessionId,
    thread,
    kit,
    greeting,
    watching = [],
    onOpen,
    onEnd
}: {
    sessionId: string;
    thread: PolarCodeThread | null | undefined;
    kit: PolarVoiceKit;
    /** What the call says first: the answer that moved it here. */
    greeting: string | null;
    /** Replies the call was waiting for when it moved here. */
    watching?: readonly VoiceWatch[];
    /** The delegator showed another session; the call follows it there, still
     *  waiting for what it was waiting for. */
    onOpen: (sessionId: string, say: string, watching: readonly VoiceWatch[]) => void;
    onEnd: () => void;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const [messages, setMessages] = useState<UIMessage[]>(() =>
        greeting ? [line("greeting", "assistant", greeting)] : []
    );
    const [status, setStatus] = useState<ChatStatus>("ready");
    const [announced, setAnnounced] = useState<string | null>(greeting ? "greeting" : null);
    const explained = useRef<Record<string, number>>({});
    /** Work sent to sessions, waiting for their replies. */
    const waiting = useRef<VoiceWatch[]>([...watching]);
    const [watched, setWatched] = useState(() => watching.length);
    /** Things to say, in the order they came, each said once the call is quiet. */
    const [due, setDue] = useState<string[]>([]);
    const [quiet, setQuiet] = useState(false);
    /** Handed to the call and not yet taken up: nothing else is handed over. */
    const handing = useRef(false);
    const gaveUp = useRef(Date.now() + WATCH_MS);
    const turn = useRef<AbortController | null>(null);
    const counter = useRef(0);
    const latest = useRef(messages);
    latest.current = messages;

    const add = useCallback((role: "user" | "assistant", text: string) => {
        counter.current += 1;
        const message = line(`call-${counter.current}`, role, text);
        setMessages((list) => [...list, message]);
        return message.id;
    }, []);

    const send = useCallback(
        (text: string) => {
            const tail = callTail(latest.current);
            add("user", text);
            setStatus("submitted");
            const controller = new AbortController();
            turn.current?.abort();
            turn.current = controller;
            void fetch("/api/polar/voice/delegate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text,
                    sessionId,
                    tail,
                    explained: explained.current,
                    payer: kit.payer,
                    lang: locale
                }),
                signal: controller.signal
            })
                .then(async (response) => {
                    if (!response.ok) {
                        const { error } = (await response.json().catch(() => ({}))) as { error?: string };
                        throw new Error(error ?? "failed");
                    }
                    return (await response.json()) as VoiceDelegateAnswer;
                })
                .then((answer) => {
                    if (controller.signal.aborted) return;
                    explained.current = answer.explained;
                    if (answer.sent.length > 0) {
                        waiting.current.push(...answer.sent.map(({ sessionId: id, at }) => ({ sessionId: id, since: at })));
                        gaveUp.current = Date.now() + WATCH_MS;
                        setWatched(waiting.current.length);
                    }
                    const say = answer.say || t("voice.code.done");
                    if (answer.open && answer.open !== sessionId) {
                        setStatus("ready");
                        onOpen(answer.open, say, waiting.current);
                        return;
                    }
                    add("assistant", say);
                    setStatus("ready");
                })
                .catch((error: unknown) => {
                    if (controller.signal.aborted) return;
                    const code = error instanceof Error ? error.message : "failed";
                    add(
                        "assistant",
                        code === "no_model"
                            ? t("voice.code.noModel")
                            : code === "limit"
                              ? t("voice.errors.usage_limit")
                              : t("voice.code.failed")
                    );
                    setStatus("ready");
                })
                .finally(() => {
                    if (turn.current === controller) turn.current = null;
                });
        },
        [add, kit.payer, locale, onOpen, sessionId, t]
    );

    /** A session's news, queued to be said; the watches it settles let go. */
    const heard = useCallback(
        (id: string, title: string | null, news: WatchNews) => {
            if (!news) return;
            waiting.current = settle(waiting.current, id, news);
            setWatched(waiting.current.length);
            if (news.kind === "gone") return;
            const named = title ? saidTitle(title) : null;
            const lead = news.kind === "reply" ? replyLead(parseVoiceDelegation(news.text) ?? news.text) : "";
            // A reply with nothing to say out loud (only code, say) is let go:
            // the call never waits on a line it cannot speak.
            if (news.kind === "reply" && !speaksAnything(lead)) return;
            const text =
                news.kind === "asks"
                    ? named
                        ? t("voice.code.needsYouFrom", { title: named })
                        : t("voice.code.needsYou")
                    : named
                      ? t("voice.code.from", { title: named, text: lead })
                      : lead;
            setDue((list) => [...list, text]);
        },
        [t]
    );

    // The session on screen, read as its thread is.
    useEffect(() => {
        if (!thread) return;
        const since = waiting.current.find((watch) => watch.sessionId === sessionId)?.since;
        if (since) heard(sessionId, null, watchNews(thread, since));
    }, [thread, sessionId, heard]);

    // Sessions not on screen, read here while their replies are awaited.
    const others = watched > 0;
    useEffect(() => {
        if (!others) return;
        const controller = new AbortController();
        const timer = setInterval(() => {
            if (Date.now() > gaveUp.current) {
                waiting.current = waiting.current.filter((watch) => watch.sessionId === sessionId);
                setWatched(waiting.current.length);
                return;
            }
            const ids: string[] = [];
            for (const watch of waiting.current) {
                if (watch.sessionId !== sessionId && !ids.includes(watch.sessionId)) ids.push(watch.sessionId);
            }
            // The most recent few; older ones are let go rather than read forever.
            const dropped = ids.slice(0, Math.max(0, ids.length - WATCH_MOST));
            if (dropped.length > 0) {
                waiting.current = waiting.current.filter((watch) => !dropped.includes(watch.sessionId));
                setWatched(waiting.current.length);
            }
            for (const id of ids.slice(-WATCH_MOST)) {
                readPoll<PolarCodeThread | null>("/api/polar/code/thread", { sessionId: id }, controller.signal)
                    .then((other) => {
                        if (!waiting.current.some((watch) => watch.sessionId === id)) return;
                        const since = waiting.current.find((watch) => watch.sessionId === id)!.since;
                        // Gone, or no longer the person's to read: nothing will come.
                        if (!other) return heard(id, null, { kind: "gone" });
                        heard(id, other.session.title, watchNews(other, since));
                    })
                    // A read that failed is tried again on the next tick.
                    .catch(() => undefined);
            }
        }, WATCH_POLL_MS);
        return () => {
            clearInterval(timer);
            controller.abort();
        };
    }, [others, sessionId, heard]);

    // One thing at a time, into a quiet call that is not waiting on a turn.
    useEffect(() => {
        if (!quiet) handing.current = false;
        if (!quiet || handing.current || status !== "ready" || due.length === 0) return;
        setDue((list) => list.slice(1));
        // Nothing speakable is never handed over: the call would not leave its
        // quiet for it, and the queue behind it would wait forever.
        if (!speaksAnything(due[0]!)) return;
        handing.current = true;
        setAnnounced(add("assistant", due[0]!));
    }, [quiet, status, due, add]);

    useEffect(() => () => turn.current?.abort(), []);

    const said = [...messages].reverse().find((message) => message.role === "assistant");
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <VoiceCall
                messages={messages}
                status={status}
                speech={kit.voice.speech}
                payer={kit.payer}
                transcriber={kit.voice.transcriber}
                transcribers={kit.voice.transcribers}
                onTranscriber={kit.onTranscriber}
                tools={{}}
                onSend={send}
                onStop={() => {
                    turn.current?.abort();
                    turn.current = null;
                    setStatus("ready");
                }}
                onApprove={() => undefined}
                onEnd={onEnd}
                announced={announced}
                onQuiet={setQuiet}
            />
            {said ? (
                <p aria-live="polite" className="min-w-0 break-words px-1 text-center text-xs text-muted-foreground">
                    {textOf(said)}
                </p>
            ) : null}
        </div>
    );
}
