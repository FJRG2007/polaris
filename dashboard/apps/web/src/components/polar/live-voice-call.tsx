"use client";

/**
 * Live voice in a Polar chat: the person talks with a speech-to-speech model
 * over a direct connection (`realtime-link.ts`), as in ChatGPT's voice mode -
 * it answers as soon as you stop, stops the moment you talk over it, and
 * what both of you said shows as it is said.
 *
 * Each exchange is saved into the thread as a question and its reply
 * (`/api/polar/voice/live/turn`). A request that needs Polar's tools goes
 * through `ask_polar`: it is sent as the next message of the thread, so it
 * runs with every tool and approval a typed one has, and the voice reads the
 * answer back.
 *
 * Before the browser asks for the microphone the page says why; a refusal
 * stays on screen with a way to try again.
 */

import { Button } from "@polaris/ui";
import type { ChatStatus, UIMessage } from "ai";
import { readySentences } from "@/lib/polar/voice-call";
import { AudioLines, Mic, MicOff, PhoneOff } from "lucide-react";
import { VoiceOrb, type OrbState } from "@/components/polar/voice-orb";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { openRealtimeLink, type RealtimeCall, type RealtimeLink, type RealtimeSnapshot } from "@/lib/polar/realtime-link";
import {
    ASK_POLAR_ANSWER_MAX,
    ASK_POLAR_TOOL,
    askPolarArgsSchema,
    EMPTY_LEDGER,
    ledgerStep,
    type LiveEvent
} from "@/lib/polar/live-voice";

export interface LiveVoiceCallProps {
    threadId: string;
    /** A new chat is temporary: one the call starts stays that way. */
    temporary: boolean;
    messages: UIMessage[];
    status: ChatStatus;
    /** Send a request as the next message of the thread. */
    onSend: (text: string) => void;
    /** An exchange saved: shown in the thread without waiting for a reload. */
    onSaved: (messages: UIMessage[]) => void;
    /** Go on by transcription instead. */
    onTranscribed: () => void;
    onEnd: () => void;
}

type Permission = "checking" | "ask" | "granted";

/** How the microphone stands before anything is opened. "prompt" (and a
 *  browser that cannot say) means the page explains before the browser asks. */
async function microphonePermission(): Promise<"granted" | "prompt" | "denied"> {
    try {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        return status.state;
    } catch {
        return "prompt";
    }
}

/** What a finished reply in the thread says out loud, for the voice to read. */
export function spokenAnswer(message: UIMessage | undefined): string | null {
    if (!message || message.role !== "assistant") return null;
    const text = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n\n");
    const said = readySentences(text, 0, true).sentences.join(" ").trim();
    return said ? said.slice(0, ASK_POLAR_ANSWER_MAX) : null;
}

/** The tool a reply waits on approval for, or null. */
function waitingApproval(message: UIMessage | undefined): string | null {
    for (const part of message?.parts ?? []) {
        if ("state" in part && part.state === "approval-requested") return part.type.replace(/^tool-/, "");
    }
    return null;
}

const newId = () => crypto.randomUUID();

/** Longest wait for Polar's answer to an `ask_polar` request. */
const ASK_TIMEOUT_MS = 180_000;

export function LiveVoiceCall(props: LiveVoiceCallProps) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const latest = useRef(props);
    latest.current = props;
    const [permission, setPermission] = useState<Permission>("checking");
    const [link, setLink] = useState<RealtimeLink | null>(null);
    const current = useRef<RealtimeLink | null>(null);
    const [notSaved, setNotSaved] = useState(false);
    const ledger = useRef(EMPTY_LEDGER);
    /** The `ask_polar` call waiting on the thread's reply. */
    const asked = useRef<{ from: number; sent: boolean; resolve: (output: string) => void } | null>(null);

    const save = useCallback((user: string, assistant: string) => {
        const { threadId, temporary, messages } = latest.current;
        const question: UIMessage = { id: newId(), role: "user", parts: [{ type: "text", text: user }] };
        const reply: UIMessage = { id: newId(), role: "assistant", parts: [{ type: "text", text: assistant }] };
        latest.current.onSaved([question, reply]);
        void fetch("/api/polar/voice/live/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId,
                temporary,
                parentId: messages.at(-1)?.id ?? null,
                user: { id: question.id, text: user },
                assistant: { id: reply.id, text: assistant }
            })
        })
            .then((response) => {
                if (!response.ok) setNotSaved(true);
            })
            .catch(() => setNotSaved(true));
    }, []);

    const onLive = useCallback(
        (event: LiveEvent) => {
            const step = ledgerStep(ledger.current, event);
            ledger.current = step.ledger;
            if (step.exchange) save(step.exchange.user, step.exchange.assistant);
        },
        [save]
    );

    const runTool = useCallback(async (call: RealtimeCall, signal: AbortSignal): Promise<string> => {
        if (call.name !== ASK_POLAR_TOOL) return JSON.stringify({ error: "There is no tool by that name." });
        let args: unknown;
        try {
            args = JSON.parse(call.arguments || "{}");
        } catch {
            args = null;
        }
        const parsed = askPolarArgsSchema.safeParse(args);
        if (!parsed.success) return JSON.stringify({ error: "The request was empty. Nothing was asked." });
        return new Promise<string>((resolve) => {
            const done = (output: string) => {
                clearTimeout(timer);
                if (asked.current?.resolve === done) asked.current = null;
                resolve(output);
            };
            // A turn that never starts (no model picked) or never ends is let go.
            const timer = setTimeout(() => done(JSON.stringify({ error: "Polar did not answer in time." })), ASK_TIMEOUT_MS);
            asked.current = { from: latest.current.messages.length, sent: false, resolve: done };
            signal.addEventListener("abort", () => done(JSON.stringify({ error: "The call ended." })), { once: true });
            latest.current.onSend(parsed.data.request);
        });
    }, []);

    // The thread's reply to an `ask_polar` request, once it has finished.
    useEffect(() => {
        const waiting = asked.current;
        if (!waiting) return;
        if (props.status === "submitted" || props.status === "streaming") {
            waiting.sent = true;
            return;
        }
        if (!waiting.sent) return;
        const last = props.messages.at(-1);
        const approval = props.messages.length > waiting.from ? waitingApproval(last) : null;
        if (approval) {
            waiting.resolve(JSON.stringify({ waiting: `Polar needs the person to approve "${approval}" on screen.` }));
            return;
        }
        const answer = props.messages.length > waiting.from ? spokenAnswer(last) : null;
        waiting.resolve(
            answer
                ? JSON.stringify({ answer })
                : JSON.stringify({ error: "Polar could not answer. Do not claim it did." })
        );
    }, [props.status, props.messages]);

    const open = useCallback(() => {
        setPermission("granted");
        current.current?.close();
        ledger.current = EMPTY_LEDGER;
        const next = openRealtimeLink({
            binding: { sessionId: latest.current.threadId, onOpen: () => undefined },
            lang: locale,
            channel: {
                mint: { url: "/api/polar/voice/live", body: { threadId: latest.current.threadId, lang: locale } },
                runTool,
                onLive
            }
        });
        current.current = next;
        setLink(next);
    }, [locale, runTool, onLive]);

    useEffect(() => {
        let cancelled = false;
        void microphonePermission().then((state) => {
            if (cancelled) return;
            if (state === "granted") open();
            else setPermission("ask");
        });
        return () => {
            cancelled = true;
        };
    }, [open]);

    // The link ends with the call.
    useEffect(() => () => current.current?.close(), []);

    if (!link || permission !== "granted") {
        return (
            <LiveShell>
                <VoiceOrb state="muted" level={() => 0} className="size-20 sm:size-24" />
                {permission === "ask" ? (
                    <p className="max-w-full break-words text-center text-sm text-foreground">{t("voice.live.askMic")}</p>
                ) : null}
                <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                    {permission === "ask" ? (
                        <Button type="button" variant="primary" onClick={open}>
                            <Mic />
                            {t("voice.live.allowMic")}
                        </Button>
                    ) : null}
                    <EndButton label={t("voice.end")} onEnd={props.onEnd} />
                </div>
            </LiveShell>
        );
    }
    return (
        <LiveCallView
            link={link}
            notSaved={notSaved}
            onRetry={open}
            onTranscribed={props.onTranscribed}
            onEnd={props.onEnd}
        />
    );
}

function LiveShell({ children }: { children: ReactNode }) {
    const t = useTranslations("polar");
    return (
        <section
            aria-label={t("voice.callTitle")}
            data-voice-call=""
            data-live-voice=""
            className="mb-2 flex w-full min-w-0 flex-col items-center gap-3 rounded-xl border border-border bg-card px-3 py-4 shadow-sm"
        >
            {children}
        </section>
    );
}

function EndButton({ label, onEnd }: { label: string; onEnd: () => void }) {
    return (
        <Button type="button" variant="hangUp" size="icon" aria-label={label} title={label} onClick={onEnd}>
            <PhoneOff />
        </Button>
    );
}

/** The orb a live call shows for its state. */
export function liveOrb(state: RealtimeSnapshot): OrbState {
    if (state.muted) return "muted";
    if (state.phase === "failed") return "error";
    if (state.phase === "connecting" || state.busy) return "thinking";
    return "listening";
}

function LiveCallView({
    link,
    notSaved,
    onRetry,
    onTranscribed,
    onEnd
}: {
    link: RealtimeLink;
    notSaved: boolean;
    onRetry: () => void;
    onTranscribed: () => void;
    onEnd: () => void;
}) {
    const t = useTranslations("polar");
    const state = useSyncExternalStore(link.subscribe, link.snapshot, link.snapshot);
    const first = useRef<HTMLButtonElement>(null);
    useEffect(() => first.current?.focus(), []);
    const status = state.muted
        ? t("voice.muted")
        : state.phase === "connecting"
          ? t("voice.live.connecting")
          : state.busy
            ? t("voice.live.working")
            : state.phase === "live"
              ? t("voice.live.listening")
              : null;
    const errorText =
        state.error === "no_key"
            ? t("voice.live.noKey")
            : state.error === "mic_denied"
              ? t("voice.micDenied")
              : state.error === "rate_limited"
                ? t("voice.errors.rate_limited")
                : state.error
                  ? t("voice.live.failed")
                  : null;
    return (
        <LiveShell>
            <VoiceOrb state={liveOrb(state)} level={link.level} className="size-20 sm:size-24" />
            <div className="flex w-full min-w-0 flex-col items-center gap-1 text-center">
                {status ? (
                    <p aria-live="polite" className="text-sm font-medium text-foreground">
                        {status}
                    </p>
                ) : null}
                {errorText ? (
                    <p role="alert" className="max-w-full break-words text-xs text-danger-ink">
                        {errorText}
                    </p>
                ) : (
                    <p className="max-w-full truncate text-xs text-muted-foreground" title={t("voice.live.description")}>
                        {t("voice.live.description")}
                    </p>
                )}
                {notSaved ? <p className="max-w-full break-words text-xs text-danger-ink">{t("voice.live.notSaved")}</p> : null}
            </div>
            {state.heard || state.caption ? (
                <div aria-live="polite" className="flex w-full min-w-0 flex-col gap-1 text-start text-xs">
                    {state.heard ? (
                        <p className="min-w-0 break-words text-muted-foreground">
                            <span className="font-medium text-foreground">{t("voice.live.you")}: </span>
                            {state.heard}
                        </p>
                    ) : null}
                    {state.caption ? (
                        <p className="min-w-0 break-words text-muted-foreground">
                            <span className="font-medium text-foreground">{t("voice.live.polar")}: </span>
                            {state.caption}
                        </p>
                    ) : null}
                </div>
            ) : null}
            <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                {state.phase === "failed" ? (
                    <Button ref={first} type="button" variant="secondary" onClick={onRetry}>
                        {t("voice.live.retry")}
                    </Button>
                ) : (
                    <Button
                        ref={first}
                        type="button"
                        variant="secondary"
                        size="icon"
                        aria-pressed={state.muted}
                        aria-label={state.muted ? t("voice.unmute") : t("voice.mute")}
                        title={state.muted ? t("voice.unmute") : t("voice.mute")}
                        onClick={() => link.setMuted(!state.muted)}
                    >
                        {state.muted ? <MicOff /> : <Mic />}
                    </Button>
                )}
                <Button type="button" variant="secondary" className="min-w-0 max-w-full" onClick={onTranscribed}>
                    <AudioLines />
                    <span className="truncate">{t("voice.live.useTranscribed")}</span>
                </Button>
                <EndButton label={t("voice.end")} onEnd={onEnd} />
            </div>
        </LiveShell>
    );
}
