"use client";

/**
 * Polar's two voice buttons: dictation, which turns what you say into text in
 * the composer for you to read before sending, and voice mode, a call in the
 * same thread where Polar listens, answers and reads the answer back.
 *
 * Both reuse Chat's microphone: the same recorder, the same constraints a call
 * opens the device with, the same level meter and gate. What is new is where
 * the recording goes - to `/api/polar/transcribe`, never into storage.
 */

import type { Payer } from "@/lib/polar/shared";
import type { ChatStatus, UIMessage } from "ai";
import { isWebTool, webStepOf } from "@/lib/polar/web-sources";
import { micConstraints } from "@/app/(app)/chat/mic-cleanup";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ToolState } from "@/components/polar/elements/tool";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { PromptInputButton } from "@/components/polar/elements/prompt-input";
import { AudioLines, Check, ChevronDown, Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react";
import { affectedBy, Confirmation } from "@/components/polar/elements/confirmation";
import { measureVoice, speaking, type VoiceLevel } from "@/app/(app)/chat/voice-level";
import type { TranscriptionOption } from "@/lib/polar/transcription";
import { setMicDevice, useMicrophones } from "@/app/(app)/chat/mic-device";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@polaris/ui";
import {
    canRecord,
    recordingType,
    spokenLength,
    useVoiceRecording
} from "@/app/(app)/chat/voice-recorder";
import {
    callReducer,
    INITIAL_CALL,
    micOpen,
    readySentences,
    VOICE_MAX_SECONDS,
    type CallError
} from "@/lib/polar/voice-call";

/** Why a transcription did not come back, as a code the screen has words for. */
export type TranscribeError =
    "transcribe_failed" | "rate_limited" | "too_large" | "no_voice_provider" | "usage_limit";

const TRANSCRIBE_ERRORS: readonly TranscribeError[] = [
    "rate_limited",
    "too_large",
    "no_voice_provider",
    "usage_limit"
];

/** Send a recording to be read; the text, or why not. */
export async function transcribeAudio(
    audio: Blob,
    durationMs: number,
    payer: Payer | null = null,
    signal?: AbortSignal,
    /** The model picked in the mic menu; absent, the server's stored pick. */
    model?: string | null
): Promise<{ text: string } | { error: TranscribeError }> {
    const capped = Math.min(Math.max(0, Math.round(durationMs)), VOICE_MAX_SECONDS * 1000);
    const query = new URLSearchParams({ durationMs: String(capped) });
    if (payer) query.set("payer", payer);
    if (model) query.set("model", model);
    try {
        const response = await fetch(`/api/polar/transcribe?${query}`, {
            method: "POST",
            headers: { "Content-Type": audio.type || "audio/webm" },
            body: audio,
            signal
        });
        const data = (await response.json().catch(() => null)) as {
            text?: unknown;
            error?: unknown;
        } | null;
        if (response.ok && typeof data?.text === "string") return { text: data.text };
        const code = data?.error;
        return {
            error: TRANSCRIBE_ERRORS.find((known) => known === code) ?? "transcribe_failed"
        };
    } catch {
        return { error: "transcribe_failed" };
    }
}

/** What a voice button says when it is pressed but cannot work. */
export type VoiceNotice =
    | "unavailable"
    | "micDenied"
    | "cannotRecord"
    | "modelNotSaved"
    | Exclude<TranscribeError, "no_voice_provider">;

/**
 * The microphone in the composer. Unavailable stays visible and focusable, and
 * pressing it says what to connect rather than doing nothing.
 */
export function DictationButton({
    available,
    disabled,
    payer = null,
    transcribers = [],
    transcriber = null,
    onTranscriber,
    onText,
    onNotice
}: {
    available: boolean;
    disabled?: boolean;
    /** Who pays, as picked for the chat. */
    payer?: Payer | null;
    /** The models a key is held for, and the one in use. */
    transcribers?: readonly TranscriptionOption[];
    transcriber?: string | null;
    onTranscriber?: (id: string) => void;
    onText: (text: string) => void;
    onNotice: (notice: VoiceNotice | null) => void;
}) {
    const t = useTranslations("polar");
    const [transcribing, setTranscribing] = useState(false);
    const recorder = useVoiceRecording((file, sound) => {
        setTranscribing(true);
        void transcribeAudio(file, sound.durationMs, payer, undefined, transcriber).then(
            (result) => {
                setTranscribing(false);
                if ("text" in result) {
                    if (result.text) onText(result.text);
                } else {
                    onNotice(result.error === "no_voice_provider" ? "unavailable" : result.error);
                }
            }
        );
    });
    const notice = useRef(onNotice);
    notice.current = onNotice;
    useEffect(() => {
        if (recorder.error) notice.current("micDenied");
    }, [recorder.error]);

    if (recorder.recording) {
        return (
            <span className="inline-flex min-w-0 items-center gap-1">
                <PromptInputButton label={t("voice.dictateCancel")} onClick={recorder.cancel}>
                    <X />
                </PromptInputButton>
                <span
                    className={cn(
                        "whitespace-nowrap text-xs tabular-nums",
                        recorder.silent ? "text-warning-ink" : "text-muted-foreground"
                    )}
                    title={recorder.silent ? t("voice.silent") : undefined}
                >
                    {t("voice.recording", { time: spokenLength(recorder.seconds) })}
                </span>
                <PromptInputButton
                    label={t("voice.dictateStop")}
                    variant="secondary"
                    onClick={recorder.stop}
                >
                    <Check />
                </PromptInputButton>
            </span>
        );
    }
    if (transcribing) {
        return (
            <PromptInputButton label={t("voice.transcribing")} aria-busy disabled>
                <Loader2 className="motion-safe:animate-spin" />
            </PromptInputButton>
        );
    }
    const usable = available && !disabled;
    const button = (
        <PromptInputButton
            label={available ? t("voice.dictate") : t("voice.unavailable")}
            aria-disabled={!usable || undefined}
            disabled={disabled}
            className={cn(!available && "opacity-50", available && "rounded-r-none")}
            onClick={() => {
                if (!available) return onNotice("unavailable");
                if (!canRecord()) return onNotice("cannotRecord");
                onNotice(null);
                recorder.start();
            }}
        >
            <Mic />
        </PromptInputButton>
    );
    if (!available) return button;
    return (
        <span className="inline-flex items-center">
            {button}
            <DictationMenu
                disabled={disabled}
                transcribers={transcribers}
                transcriber={transcriber}
                onTranscriber={onTranscriber}
            />
        </span>
    );
}

/**
 * The caret beside the microphone: which input to record from (shared with
 * Chat's calls and voice messages, per browser) and which model hears it.
 * The device names only exist once the browser has been allowed a microphone,
 * so until then the list offers to ask.
 */
export function DictationMenu({
    disabled,
    transcribers,
    transcriber,
    onTranscriber
}: {
    disabled?: boolean;
    transcribers: readonly TranscriptionOption[];
    transcriber: string | null;
    onTranscriber?: (id: string) => void;
}) {
    const t = useTranslations("polar");
    const { devices, chosenId, choose, refresh } = useMicrophones();
    const [denied, setDenied] = useState(false);
    const unnamed = devices.length === 0 || devices.some((device) => !device.named);
    const chosen = devices.some((device) => device.id === chosenId) ? chosenId : null;
    const groups: Array<{ provider: string; name: string; options: TranscriptionOption[] }> = [];
    for (const option of transcribers) {
        const group = groups.find((entry) => entry.provider === option.provider);
        if (group) group.options.push(option);
        else
            groups.push({
                provider: option.provider,
                name: option.providerName,
                options: [option]
            });
    }
    const current = transcribers.find((option) => option.id === transcriber);

    const allow = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            for (const track of stream.getTracks()) track.stop();
            setDenied(false);
        } catch {
            setDenied(true);
        }
        await refresh();
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={t("voice.menu.open")}
                    title={t("voice.menu.open")}
                    className="w-5 rounded-l-none"
                >
                    <ChevronDown className="size-3" />
                </Button>
            </DropdownMenuTrigger>
            {/* Upward: the composer sits at the bottom of the panel. */}
            <DropdownMenuContent align="start" side="top" className="w-64">
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Mic />
                        <span className="min-w-0 flex-1 truncate">
                            {t("voice.menu.microphone")}
                        </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64">
                        <DropdownMenuItem onSelect={() => setMicDevice(null)}>
                            <Check
                                className={cn(
                                    "size-3.5",
                                    chosen === null ? "opacity-100" : "opacity-0"
                                )}
                            />
                            <span className="min-w-0 truncate">
                                {t("voice.menu.systemDefault")}
                            </span>
                        </DropdownMenuItem>
                        {devices.map((device) => (
                            <DropdownMenuItem key={device.id} onSelect={() => choose(device.id)}>
                                <Check
                                    className={cn(
                                        "size-3.5",
                                        device.id === chosen ? "opacity-100" : "opacity-0"
                                    )}
                                />
                                <span className="min-w-0 truncate" title={device.label}>
                                    {device.label}
                                </span>
                            </DropdownMenuItem>
                        ))}
                        {unnamed && (
                            <DropdownMenuItem
                                onSelect={(event) => {
                                    event.preventDefault();
                                    void allow();
                                }}
                            >
                                <span className="min-w-0 whitespace-normal text-muted-foreground">
                                    {denied ? t("voice.menu.denied") : t("voice.menu.allow")}
                                </span>
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <AudioLines />
                        <span className="min-w-0 flex-1 truncate">{t("voice.menu.model")}</span>
                        {current && (
                            <span
                                className="min-w-0 max-w-28 truncate text-xs text-muted-foreground"
                                title={current.label}
                            >
                                {current.label}
                            </span>
                        )}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto overscroll-contain">
                        {groups.map((group) => (
                            <div key={group.provider} role="group" aria-label={group.name}>
                                <DropdownMenuLabel>{group.name}</DropdownMenuLabel>
                                {group.options.map((option) => (
                                    <DropdownMenuItem
                                        key={option.id}
                                        onSelect={() => onTranscriber?.(option.id)}
                                    >
                                        <Check
                                            className={cn(
                                                "size-3.5",
                                                option.id === transcriber
                                                    ? "opacity-100"
                                                    : "opacity-0"
                                            )}
                                        />
                                        <span className="min-w-0 truncate" title={option.label}>
                                            {option.label}
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                            </div>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The button that starts voice mode. */
export function VoiceModeButton({
    available,
    disabled,
    onOpen,
    onNotice
}: {
    available: boolean;
    disabled?: boolean;
    onOpen: () => void;
    onNotice: (notice: VoiceNotice | null) => void;
}) {
    const t = useTranslations("polar");
    return (
        <PromptInputButton
            label={available ? t("voice.call") : t("voice.unavailable")}
            aria-disabled={!available || undefined}
            disabled={disabled}
            className={cn(!available && "opacity-50")}
            onClick={() => {
                if (!available) return onNotice("unavailable");
                if (!canRecord()) return onNotice("cannotRecord");
                onNotice(null);
                onOpen();
            }}
        >
            <AudioLines />
        </PromptInputButton>
    );
}

/** Level (0-100) at which the gate opens while Polar is quiet. */
const OPEN_AT = 18;
/** While Polar talks the bar is higher, so its own voice leaking past echo
 *  cancellation does not count as you talking over it. */
const OPEN_AT_WHILE_SPEAKING = 30;
/** How long a sound has to last to be speech rather than a cough or a click. */
const MIN_SPEECH_MS = 250;
/** How long a pause has to last before what you said is sent. */
const END_AFTER_MS = 1500;
/** How often the microphone is read. */
const TICK_MS = 50;

/** The text of a message as it would be read: its text parts, in order. */
function replyText(message: UIMessage | undefined): string {
    if (!message || message.role !== "assistant") return "";
    return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n\n");
}

type ApprovalPart = {
    type: string;
    state: ToolState;
    toolName?: string;
    input?: unknown;
    approval?: { id: string; approved?: boolean; reason?: string };
};

function waitingParts(message: UIMessage | undefined): Array<{ part: ApprovalPart; name: string }> {
    if (!message || message.role !== "assistant") return [];
    const found: Array<{ part: ApprovalPart; name: string }> = [];
    for (const raw of message.parts) {
        if (!raw.type.startsWith("tool-") && raw.type !== "dynamic-tool") continue;
        const part = raw as unknown as ApprovalPart;
        if (part.state !== "approval-requested" || !part.approval) continue;
        found.push({
            part,
            name: raw.type === "dynamic-tool" ? (part.toolName ?? "tool") : raw.type.slice(5)
        });
    }
    return found;
}

export interface VoiceCallProps {
    messages: UIMessage[];
    status: ChatStatus;
    /** Whether answers can be spoken; without it the call still shows them. */
    speech: boolean;
    /** Who pays, as picked for the chat. */
    payer?: Payer | null;
    /** The model picked in the mic menu, `provider/model`. */
    transcriber?: string | null;
    tools: Record<string, { title: string; destructive: boolean }>;
    /** Send what was said as the next message of this thread. */
    onSend: (text: string) => void;
    /** Stop the turn Polar is on, because it was talked over. */
    onStop: () => void;
    onApprove: (id: string, approved: boolean) => void;
    onEnd: () => void;
}

/** Voice mode: an overlay over the thread, keyboard reachable, Escape ends it. */
export function VoiceCall(props: VoiceCallProps) {
    const t = useTranslations("polar");
    const [state, dispatch] = useReducer(callReducer, INITIAL_CALL);
    const live = useRef(state);
    live.current = state;
    const latest = useRef(props);
    latest.current = props;

    /** Where this call's replies start in the thread, set at each send. */
    const baseline = useRef<number | null>(null);
    const spokenUpTo = useRef(0);
    /** Sentences fetched ahead, in the order they are to be said. */
    const queue = useRef<Array<Promise<Blob | CallError>>>([]);
    const playing = useRef(false);
    const audio = useRef<HTMLAudioElement | null>(null);
    /** Ends the sentence being played, which pausing alone never does. */
    const played = useRef<(() => void) | null>(null);
    /** Bumped to cancel everything that is being said or fetched. */
    const generation = useRef(0);
    const fetches = useRef(new Set<AbortController>());
    const recorder = useRef<{ media: MediaRecorder; keep: boolean; began: number } | null>(null);
    const stream = useRef<MediaStream | null>(null);

    const silence = useCallback(() => {
        generation.current += 1;
        queue.current = [];
        for (const controller of fetches.current) controller.abort();
        fetches.current.clear();
        audio.current?.pause();
        audio.current = null;
        played.current?.();
        played.current = null;
        playing.current = false;
    }, []);

    const finishIfDone = useCallback(() => {
        const { status, messages } = latest.current;
        const phase = live.current.phase;
        if (phase !== "thinking" && phase !== "speaking") return;
        if (
            baseline.current === null ||
            messages.length <= baseline.current ||
            messages.at(-1)?.role !== "assistant"
        ) {
            if (status === "error") dispatch({ type: "reply-done" });
            return;
        }
        const done = status === "ready" || status === "error";
        if (done && !playing.current && queue.current.length === 0) {
            dispatch({ type: "reply-done" });
        }
    }, []);

    const pump = useCallback(async () => {
        if (playing.current) return;
        playing.current = true;
        const mine = generation.current;
        while (queue.current.length > 0 && mine === generation.current) {
            const blob = await queue.current.shift()!;
            if (mine !== generation.current) return;
            if (typeof blob === "string") {
                dispatch({ type: "failed", error: blob });
                continue;
            }
            dispatch({ type: "speaking" });
            const url = URL.createObjectURL(blob);
            const player = new Audio(url);
            audio.current = player;
            let stop: (() => void) | null = null;
            await new Promise<void>((resolve) => {
                stop = resolve;
                played.current = resolve;
                player.onended = () => resolve();
                player.onerror = () => resolve();
                player.play().catch(() => resolve());
            });
            if (played.current === stop) played.current = null;
            URL.revokeObjectURL(url);
        }
        if (mine !== generation.current) return;
        playing.current = false;
        audio.current = null;
        finishIfDone();
    }, [finishIfDone]);

    const say = useCallback(
        (sentence: string) => {
            const controller = new AbortController();
            fetches.current.add(controller);
            const pending: Promise<Blob | CallError> = fetch("/api/polar/speak", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: sentence, payer: latest.current.payer ?? null }),
                signal: controller.signal
            })
                .then((response): Promise<Blob | CallError> | CallError =>
                    response.ok
                        ? response.blob()
                        : response.status === 409
                          ? "no_speech_provider"
                          : "speak_failed"
                )
                .catch((): CallError => "speak_failed")
                .finally(() => fetches.current.delete(controller));
            queue.current.push(pending);
            void pump();
        },
        [pump]
    );

    // The answer as it streams: captions, approvals, and each finished sentence.
    useEffect(() => {
        const phase = live.current.phase;
        if (baseline.current === null) return;
        if (phase !== "thinking" && phase !== "speaking" && phase !== "approval") return;
        const last = props.messages.at(-1);
        if (props.messages.length > baseline.current && last?.role === "assistant") {
            const text = replyText(last);
            dispatch({ type: "reply", text });
            if (waitingParts(last).length > 0) {
                dispatch({ type: "approval" });
                return;
            }
            const done = props.status === "ready" || props.status === "error";
            const { sentences, upTo } = readySentences(text, spokenUpTo.current, done);
            spokenUpTo.current = upTo;
            if (props.speech) for (const sentence of sentences) say(sentence);
        }
        finishIfDone();
    }, [props.messages, props.status, props.speech, say, finishIfDone]);

    // Talked over: stop the voice, the fetches and the turn.
    useEffect(() => {
        if (state.interruptions === 0) return;
        silence();
        baseline.current = null;
        latest.current.onStop();
    }, [state.interruptions, silence]);

    const dropRecording = useCallback(() => {
        const current = recorder.current;
        recorder.current = null;
        if (!current) return;
        current.keep = false;
        if (current.media.state === "recording") current.media.stop();
    }, []);

    useEffect(() => {
        if (state.discarded > 0) dropRecording();
    }, [state.discarded, dropRecording]);

    // The microphone, open for as long as the call is.
    useEffect(() => {
        let cancelled = false;
        let meter: VoiceLevel | null = null;
        let ticker: ReturnType<typeof setInterval> | null = null;
        const type = recordingType();

        const startRecording = (source: MediaStream) => {
            if (!type) return;
            const media = new MediaRecorder(source, { mimeType: type });
            const chunks: Blob[] = [];
            const entry = { media, keep: true, began: Date.now() };
            recorder.current = entry;
            media.ondataavailable = (event) => {
                if (event.data.size > 0) chunks.push(event.data);
            };
            media.onstop = () => {
                if (!entry.keep || cancelled || chunks.length === 0) return;
                const blob = new Blob(chunks, { type });
                void transcribeAudio(
                    blob,
                    Date.now() - entry.began,
                    latest.current.payer ?? null,
                    undefined,
                    latest.current.transcriber ?? null
                ).then((result) => {
                    if (cancelled || live.current.ended) return;
                    if ("error" in result) {
                        const error: CallError =
                            result.error === "no_voice_provider"
                                ? "no_voice_provider"
                                : "transcribe_failed";
                        dispatch({ type: "failed", error });
                        return;
                    }
                    dispatch({ type: "transcribed", text: result.text });
                    if (!result.text.trim()) return;
                    baseline.current = latest.current.messages.length;
                    spokenUpTo.current = 0;
                    latest.current.onSend(result.text.trim());
                });
            };
            media.start();
        };

        void navigator.mediaDevices
            .getUserMedia({ audio: { ...micConstraints(), echoCancellation: true } })
            .then((opened) => {
                if (cancelled) {
                    for (const track of opened.getTracks()) track.stop();
                    return;
                }
                stream.current = opened;
                const track = opened.getAudioTracks()[0];
                meter = track ? measureVoice(track) : null;
                if (!meter) {
                    dispatch({ type: "failed", error: "mic_denied" });
                    return;
                }
                let gate = false;
                let voicedMs = 0;
                let lastVoice = 0;
                ticker = setInterval(() => {
                    const now = Date.now();
                    const current = live.current;
                    if (!micOpen(current)) {
                        gate = false;
                        voicedMs = 0;
                        if (recorder.current && current.phase !== "transcribing") dropRecording();
                        return;
                    }
                    const level = meter?.read() ?? 0;
                    const threshold =
                        current.phase === "speaking" ? OPEN_AT_WHILE_SPEAKING : OPEN_AT;
                    gate = speaking(level, threshold, gate);
                    if (gate) {
                        lastVoice = now;
                        voicedMs += TICK_MS;
                        if (!recorder.current) startRecording(opened);
                        if (voicedMs >= MIN_SPEECH_MS && current.phase !== "hearing") {
                            dispatch({ type: "speech-start" });
                        }
                        return;
                    }
                    if (!recorder.current) return;
                    const long = now - recorder.current.began >= VOICE_MAX_SECONDS * 1000;
                    if (current.phase === "hearing" && (now - lastVoice > END_AFTER_MS || long)) {
                        const entry = recorder.current;
                        recorder.current = null;
                        voicedMs = 0;
                        dispatch({ type: "speech-end" });
                        if (entry.media.state === "recording") entry.media.stop();
                    } else if (current.phase !== "hearing" && now - lastVoice > 400) {
                        // A noise too short to be speech.
                        voicedMs = 0;
                        dropRecording();
                    }
                }, TICK_MS);
            })
            .catch(() => {
                if (!cancelled) dispatch({ type: "failed", error: "mic_denied" });
            });

        return () => {
            cancelled = true;
            if (ticker) clearInterval(ticker);
            meter?.stop();
            dropRecording();
            for (const track of stream.current?.getTracks() ?? []) track.stop();
            stream.current = null;
            silence();
        };
    }, [dropRecording, silence]);

    const end = () => {
        dispatch({ type: "end" });
        props.onEnd();
    };
    const waiting = state.phase === "approval" ? waitingParts(props.messages.at(-1)) : [];
    const webAction = (name: string, input: unknown) => {
        const step = webStepOf(name, input);
        return step?.kind === "read" ? t("web.reading", { site: step.detail }) : null;
    };
    const lively = state.phase === "hearing" || state.phase === "speaking";
    const errorText =
        state.error === "mic_denied"
            ? t("voice.micDenied")
            : state.error
              ? t(`voice.errors.${state.error}`)
              : null;

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : end())}>
            <DialogContent
                className="flex max-w-md flex-col items-center gap-4 text-center"
                onKeyDown={(event) => {
                    if (
                        event.key.toLowerCase() === "m" &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.altKey &&
                        !(event.target instanceof HTMLTextAreaElement) &&
                        !(event.target instanceof HTMLInputElement)
                    ) {
                        event.preventDefault();
                        dispatch({ type: state.muted ? "unmute" : "mute" });
                    }
                }}
            >
                <DialogTitle>{t("voice.callTitle")}</DialogTitle>
                <DialogDescription className="sr-only">
                    {t("voice.callDescription")}
                </DialogDescription>
                <div
                    aria-hidden
                    className={cn(
                        "mt-2 flex size-24 items-center justify-center rounded-full transition-colors duration-fast",
                        state.muted ? "bg-muted" : "bg-primary/15",
                        lively && !state.muted && "motion-safe:animate-pulse"
                    )}
                >
                    {state.muted ? (
                        <MicOff className="size-8 text-muted-foreground" />
                    ) : state.phase === "transcribing" || state.phase === "thinking" ? (
                        <Loader2 className="size-8 text-primary motion-safe:animate-spin" />
                    ) : (
                        <AudioLines className="size-8 text-primary" />
                    )}
                </div>
                <p aria-live="polite" className="text-sm font-medium text-foreground">
                    {state.muted ? t("voice.muted") : t(`voice.phase.${state.phase}`)}
                </p>
                {errorText ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {errorText}
                    </p>
                ) : null}
                <section
                    aria-label={t("voice.captions")}
                    className="max-h-48 w-full min-w-0 space-y-2 overflow-y-auto overscroll-contain text-left text-sm"
                >
                    {state.heard ? (
                        <p className="break-words">
                            <span className="font-medium text-foreground">{t("voice.you")}: </span>
                            <span className="text-muted-foreground">{state.heard}</span>
                        </p>
                    ) : null}
                    {state.reply ? (
                        <p className="whitespace-pre-wrap break-words">
                            <span className="font-medium text-foreground">
                                {t("voice.polar")}:{" "}
                            </span>
                            <span className="text-muted-foreground">{state.reply}</span>
                        </p>
                    ) : null}
                </section>
                {waiting.map(({ part, name }) => (
                    <Confirmation
                        key={part.approval!.id}
                        state={part.state}
                        approval={part.approval}
                        action={props.tools[name]?.title ?? webAction(name, part.input) ?? name}
                        affects={affectedBy(part.input)}
                        destructive={props.tools[name]?.destructive ?? !isWebTool(name)}
                        input={part.input}
                        className="text-left"
                        onApprove={() => {
                            dispatch({ type: "approved" });
                            props.onApprove(part.approval!.id, true);
                        }}
                        onReject={() => {
                            dispatch({ type: "approved" });
                            props.onApprove(part.approval!.id, false);
                        }}
                    />
                ))}
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        aria-pressed={state.muted}
                        onClick={() => dispatch({ type: state.muted ? "unmute" : "mute" })}
                    >
                        {state.muted ? <Mic /> : <MicOff />}
                        {state.muted ? t("voice.unmute") : t("voice.mute")}
                    </Button>
                    {state.phase === "speaking" || state.phase === "thinking" ? (
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                silence();
                                baseline.current = null;
                                props.onStop();
                                dispatch({ type: "reply-done" });
                            }}
                        >
                            {t("voice.interrupt")}
                        </Button>
                    ) : null}
                    <Button type="button" variant="hangUp" onClick={end}>
                        <PhoneOff />
                        {t("voice.end")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
