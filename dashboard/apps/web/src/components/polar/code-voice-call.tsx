"use client";

/**
 * A voice call on a Code session: Chat's own call (`VoiceCall` - the same
 * microphone, transcription, voices and barge-in), with each turn handed to the
 * voice delegator (`/api/polar/voice/delegate`) instead of a chat. The
 * delegator acts on the person's sessions and answers in a sentence or three,
 * which the call says; when it sent a session work, the session's reply is read
 * aloud once its turn ends, the way OpenCode's voice announces a session's
 * answer. Talking over it stops the voice and the turn of the call, never the
 * agent's work.
 */

import type { ChatStatus, UIMessage } from "ai";
import type { PolarCodeThread } from "@/lib/polar/code";
import { VoiceCall } from "@/components/polar/polar-voice";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseVoiceDelegation } from "@/lib/polar/voice-handoff";
import type { PolarVoiceKit } from "@/components/polar/polar-composer";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    SPEAK_TEXT_MAX,
    VOICE_TAIL_LINE_MAX,
    VOICE_TAIL_MOST,
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

export function CodeVoiceCall({
    sessionId,
    thread,
    kit,
    greeting,
    onOpen,
    onEnd
}: {
    sessionId: string;
    thread: PolarCodeThread | null | undefined;
    kit: PolarVoiceKit;
    /** What the call says first: the answer that moved it here. */
    greeting: string | null;
    /** The delegator showed another session; the call follows it there. */
    onOpen: (sessionId: string, say: string) => void;
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
    /** Work sent to the session on screen, waiting for its reply. */
    const waiting = useRef<string[]>([]);
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
                    for (const sent of answer.sent) {
                        if (sent.sessionId === sessionId) waiting.current.push(sent.at);
                    }
                    const say = answer.say || t("voice.code.done");
                    if (answer.open && answer.open !== sessionId) {
                        setStatus("ready");
                        onOpen(answer.open, say);
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

    // A session's reply, read aloud once its turn ends; its question, when it
    // stopped to ask one.
    useEffect(() => {
        if (!thread || waiting.current.length === 0) return;
        if (thread.permission) {
            waiting.current = [];
            setAnnounced(add("assistant", t("voice.code.needsYou")));
            return;
        }
        const since = waiting.current[0]!;
        const reply = landedReply(thread, since);
        if (!reply) return;
        waiting.current = waiting.current.filter((at) => at > reply.at);
        const text = replyLead(parseVoiceDelegation(reply.text) ?? reply.text);
        setAnnounced(add("assistant", text));
    }, [thread, add, t]);

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
            />
            {said ? (
                <p aria-live="polite" className="min-w-0 break-words px-1 text-center text-xs text-muted-foreground">
                    {textOf(said)}
                </p>
            ) : null}
        </div>
    );
}
