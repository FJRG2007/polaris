"use client";

/**
 * Speech translated: a recording chosen from the device, or a conversation
 * at the microphone - each side speaks its language and hears the other's
 * translated, turn by turn, as Google Translate's conversation mode does.
 *
 * The browser transcribes what it hears itself where it can (the Web Speech
 * API), so nothing leaves the device but the text; elsewhere, and for a file,
 * the recording goes to the server's transcription model.
 */

import type { Translate } from "./run";
import { postFile } from "./server-engine";
import { languageName } from "../model/languages";
import { ReadsNotice, type Reads } from "./reads";
import { useEffect, useRef, useState } from "react";
import { useTranslateLocale, useTranslateT } from "./i18n";
import { Button, CopyButton, Skeleton, cn } from "@polaris/ui";
import { FileAudio, Mic, Square, Trash2, Volume2 } from "lucide-react";
import { AUDIO_MAX_BYTES, AUDIO_MAX_SECONDS, sniffAudio } from "../model/media";
import { hostUi } from "@polaris/app-host/client";

const { useChooseFiles } = hostUi.filePicker;

interface Turn {
    id: number;
    /** "a" speaks the source language, "b" the target. */
    side: "a" | "b";
    source: string;
    target: string | null;
    error: string | null;
}

export interface Recognition {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult:
        | ((event: {
              results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
          }) => void)
        | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
}

export type RecognitionClass = new () => Recognition;

export function recognitionClass(): RecognitionClass | null {
    const scope = globalThis as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const api = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
    return typeof api === "function" ? (api as RecognitionClass) : null;
}

/** A language as the browser's speech APIs spell it. */
export function speechCode(code: string): string {
    if (code === "zh-Hans") return "zh-CN";
    if (code === "zh-Hant") return "zh-TW";
    return code;
}

/** How long a recording lasts, read by the browser; null when it cannot say. */
function durationOf(file: Blob): Promise<number | null> {
    return new Promise((resolve) => {
        const audio = document.createElement("audio");
        const url = URL.createObjectURL(file);
        const done = (value: number | null) => {
            URL.revokeObjectURL(url);
            resolve(value);
        };
        audio.preload = "metadata";
        audio.onloadedmetadata = () =>
            done(Number.isFinite(audio.duration) ? audio.duration : null);
        audio.onerror = () => done(null);
        audio.src = url;
    });
}

export function AudioMode({
    translate,
    reads,
    manager,
    from,
    to,
    file
}: {
    translate: Translate;
    reads: Reads;
    manager: boolean;
    /** The language bar's source, or null for "detect". */
    from: string | null;
    to: string;
    /** A file handed over by the box (dropped, pasted or chosen), opened on arrival. */
    file?: File | null;
}) {
    const t = useTranslateT();
    const locale = useTranslateLocale();
    const [chooseFiles, chooser] = useChooseFiles();
    const counter = useRef(0);
    const recognition = useRef<Recognition | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [listening, setListening] = useState<"a" | "b" | null>(null);
    const [interim, setInterim] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [native, setNative] = useState(false);
    const [canRecord, setCanRecord] = useState(false);
    const [speaking, setSpeaking] = useState<number | null>(null);

    useEffect(() => {
        setNative(recognitionClass() !== null);
        setCanRecord(
            typeof navigator.mediaDevices?.getUserMedia === "function" &&
                typeof MediaRecorder !== "undefined"
        );
        return () => {
            recognition.current?.stop();
            recorder.current?.stop();
            window.speechSynthesis?.cancel();
        };
    }, []);

    const add = async (side: "a" | "b", source: string) => {
        if (!source.trim()) return;
        const id = ++counter.current;
        setTurns((now) => [...now, { id, side, source, target: null, error: null }]);
        const pair = side === "a" ? { from, to } : { from: to, to: from ?? locale.split("-")[0]! };
        try {
            const answer = await translate([source], undefined, pair);
            setTurns((now) =>
                now.map((turn) =>
                    turn.id === id ? { ...turn, target: answer.texts[0] ?? "" } : turn
                )
            );
        } catch (caught) {
            setTurns((now) =>
                now.map((turn) =>
                    turn.id === id ? { ...turn, error: (caught as Error).message } : turn
                )
            );
        }
    };

    const transcribe = async (file: Blob, seconds: number | null): Promise<string> => {
        const durationMs = Math.min(AUDIO_MAX_SECONDS * 1000, Math.round((seconds ?? 0) * 1000));
        const answer = await postFile<{ text: string }>(
            `/api/translate/transcribe?durationMs=${durationMs}`,
            file,
            t("errors.transcribeFailed")
        );
        return answer.text;
    };

    const openFile = async (file: File) => {
        setError(null);
        if (file.size > AUDIO_MAX_BYTES) return setError(t("errors.fileTooLarge"));
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        const type = sniffAudio(head);
        if (!type) return setError(t("errors.audioType"));
        const seconds = await durationOf(file);
        if (seconds !== null && seconds > AUDIO_MAX_SECONDS)
            return setError(t("errors.audioTooLong"));
        setBusy(true);
        try {
            // The declared type is the one read from the bytes, not the file's name.
            await add("a", await transcribe(new Blob([file], { type }), seconds));
        } catch (caught) {
            setError((caught as Error).message);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (file) void openFile(file);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file handed over
    }, [file]);

    const listenNatively = (side: "a" | "b") => {
        const Api = recognitionClass()!;
        const language = side === "a" ? from : to;
        if (!language) return setError(t("audio.pickSource"));
        const heard = new Api();
        heard.lang = speechCode(language);
        heard.interimResults = true;
        heard.continuous = false;
        heard.onresult = (event) => {
            let final = "";
            let partial = "";
            for (const result of Array.from(event.results)) {
                const text = result[0]?.transcript ?? "";
                if (result.isFinal) final += text;
                else partial += text;
            }
            setInterim(partial);
            if (final) void add(side, final);
        };
        heard.onerror = (event) => {
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                setError(t("audio.micDenied"));
            }
        };
        heard.onend = () => {
            setListening(null);
            setInterim("");
        };
        recognition.current = heard;
        setError(null);
        setListening(side);
        heard.start();
    };

    const record = async (side: "a" | "b") => {
        let media: MediaStream;
        try {
            media = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            return setError(t("audio.micDenied"));
        }
        const chunks: Blob[] = [];
        const started = Date.now();
        const made = new MediaRecorder(media);
        const stopAt = window.setTimeout(
            () => made.state === "recording" && made.stop(),
            AUDIO_MAX_SECONDS * 1000
        );
        made.ondataavailable = (event) => chunks.push(event.data);
        made.onstop = async () => {
            window.clearTimeout(stopAt);
            media.getTracks().forEach((track) => track.stop());
            setListening(null);
            const blob = new Blob(chunks, { type: made.mimeType.split(";")[0] || "audio/webm" });
            if (blob.size === 0) return;
            setBusy(true);
            try {
                await add(side, await transcribe(blob, (Date.now() - started) / 1000));
            } catch (caught) {
                setError((caught as Error).message);
            } finally {
                setBusy(false);
            }
        };
        recorder.current = made;
        setError(null);
        setListening(side);
        made.start();
    };

    const talk = (side: "a" | "b") => {
        if (listening) {
            recognition.current?.stop();
            if (recorder.current?.state === "recording") recorder.current.stop();
            return;
        }
        if (native) listenNatively(side);
        else void record(side);
    };

    const speak = (turn: Turn) => {
        const synth = window.speechSynthesis;
        if (!synth || !turn.target) return;
        synth.cancel();
        if (speaking === turn.id) return setSpeaking(null);
        const utterance = new SpeechSynthesisUtterance(turn.target);
        const language = turn.side === "a" ? to : from;
        if (language) utterance.lang = speechCode(language);
        utterance.onend = () => setSpeaking(null);
        utterance.onerror = () => setSpeaking(null);
        synth.speak(utterance);
        setSpeaking(turn.id);
    };

    const canTalk = native || (canRecord && reads.audio);
    const sideName = (side: "a" | "b") => {
        const code = side === "a" ? from : to;
        return code ? languageName(code, locale) : t("lang.auto");
    };

    const pick = () =>
        void chooseFiles({ accept: "audio/*", onFailed: setError }).then(([file]) => {
            if (file) void openFile(file);
        });

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {chooser}
            {!reads.audio && !native ? <ReadsNotice kind="audio" manager={manager} /> : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {(["a", "b"] as const).map((side) => (
                    <Button
                        key={side}
                        size="sm"
                        variant={listening === side ? "primary" : "outline"}
                        onClick={() => talk(side)}
                        disabled={
                            !canTalk ||
                            busy ||
                            (listening !== null && listening !== side) ||
                            (native && side === "a" && !from)
                        }
                        className="min-w-0"
                    >
                        {listening === side ? (
                            <Square className="size-4 shrink-0" aria-hidden />
                        ) : (
                            <Mic className="size-4 shrink-0" aria-hidden />
                        )}
                        <span className="truncate">
                            {listening === side
                                ? t("audio.stop")
                                : t("audio.talk", { language: sideName(side) })}
                        </span>
                    </Button>
                ))}
                {reads.audio ? (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={pick}
                        disabled={busy || listening !== null}
                    >
                        <FileAudio className="size-4 shrink-0" aria-hidden />
                        {t("audio.choose")}
                    </Button>
                ) : null}
                {turns.length > 0 ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto"
                        onClick={() => setTurns([])}
                        aria-label={t("audio.clear")}
                        title={t("audio.clear")}
                    >
                        <Trash2 className="size-4 shrink-0" aria-hidden />
                    </Button>
                ) : null}
            </div>
            <p className="text-xs text-muted-foreground" role="status">
                {error ? (
                    <span className="text-destructive">{error}</span>
                ) : listening ? (
                    interim || t("audio.listening")
                ) : busy ? (
                    t("audio.transcribing")
                ) : native && !from ? (
                    t("audio.pickSource")
                ) : !canTalk && !reads.audio ? null : !canTalk ? (
                    t("audio.micUnsupported")
                ) : reads.audio ? (
                    t("audio.hint")
                ) : null}
            </p>
            {turns.length === 0 && !busy ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    {t("audio.empty")}
                </p>
            ) : (
                <ul className="flex min-w-0 flex-col gap-2">
                    {turns.map((turn) => (
                        <li
                            key={turn.id}
                            className={cn(
                                "flex min-w-0 flex-col gap-1 rounded-lg border border-border px-3 py-2 sm:max-w-[85%]",
                                turn.side === "a" ? "self-start bg-card" : "self-end bg-muted/40"
                            )}
                        >
                            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                {turn.source}
                            </p>
                            {turn.error ? (
                                <p className="text-sm text-destructive">{turn.error}</p>
                            ) : turn.target === null ? (
                                <Skeleton className="h-4 w-40 max-w-full" />
                            ) : (
                                <div className="flex min-w-0 items-start gap-1">
                                    <p className="min-w-0 flex-1 text-base [overflow-wrap:anywhere]">
                                        {turn.target}
                                    </p>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => speak(turn)}
                                        aria-label={
                                            speaking === turn.id
                                                ? t("actions.stop")
                                                : t("audio.listen")
                                        }
                                        title={
                                            speaking === turn.id
                                                ? t("actions.stop")
                                                : t("audio.listen")
                                        }
                                    >
                                        {speaking === turn.id ? (
                                            <Square className="size-4 shrink-0" aria-hidden />
                                        ) : (
                                            <Volume2 className="size-4 shrink-0" aria-hidden />
                                        )}
                                    </Button>
                                    <CopyButton value={turn.target} label={t("actions.copy")} />
                                </div>
                            )}
                        </li>
                    ))}
                    {busy ? <Skeleton className="h-14 w-full" /> : null}
                </ul>
            )}
        </div>
    );
}
