"use client";

/**
 * What an answer's row offers beyond copy and reply, the way ChatGPT's does:
 *
 * - `AnswerMarks` - good and bad, a bad one asking what was wrong.
 * - `useReadAloud` - the answer said out loud, one sentence after another,
 *   through the same speech route a voice call uses. One answer at a time.
 * - `RegenerateMenu` - answer again as it was, with more detail, more concise,
 *   or on another model for this turn only.
 */

import { useState, useSyncExternalStore } from "react";
import { Bot, Check, ListMinus, ListPlus, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Textarea,
    cn
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MessageAction } from "@/components/polar/elements/message";
import type { ModelSelectorProvider } from "@/components/polar/elements/model-selector";
import {
    POLAR_BAD_REASONS,
    POLAR_FEEDBACK_NOTE_MAX,
    type PolarBadReason,
    type PolarMark,
    type PolarRating
} from "@/lib/polar/answer-feedback";
import type { PolarRefine } from "@/lib/polar/prompt";
import { readySentences } from "@/lib/polar/voice-call";

// ---------------------------------------------------------------------------
// Good and bad

export type MarkChange = {
    rating: PolarRating | null;
    reasons?: PolarBadReason[];
    note?: string | null;
};

/** Good and bad under an answer. Pressing the chosen one again takes it back;
 *  bad asks what was wrong, which can be skipped. */
export function AnswerMarks({
    mark,
    onMark
}: {
    mark: PolarMark | null;
    onMark: (change: MarkChange) => Promise<boolean>;
}) {
    const t = useTranslations("polar");
    const [asking, setAsking] = useState(false);
    const rating = mark?.rating ?? null;
    return (
        <>
            {rating !== "bad" ? (
                <MessageAction
                    label={t("actions.good")}
                    aria-pressed={rating === "good"}
                    className={cn(rating === "good" && "text-foreground")}
                    onClick={() => void onMark({ rating: rating === "good" ? null : "good" })}
                >
                    <ThumbsUp className={cn(rating === "good" && "fill-current")} />
                </MessageAction>
            ) : null}
            {rating !== "good" ? (
                <MessageAction
                    label={t("actions.bad")}
                    aria-pressed={rating === "bad"}
                    className={cn(rating === "bad" && "text-foreground")}
                    onClick={() => {
                        if (rating === "bad") return void onMark({ rating: null });
                        void onMark({ rating: "bad" }).then((saved) => saved && setAsking(true));
                    }}
                >
                    <ThumbsDown className={cn(rating === "bad" && "fill-current")} />
                </MessageAction>
            ) : null}
            {asking ? (
                <BadAnswerDialog
                    initial={mark}
                    onClose={() => setAsking(false)}
                    onSend={(reasons, note) => onMark({ rating: "bad", reasons, note })}
                />
            ) : null}
        </>
    );
}

function BadAnswerDialog({
    initial,
    onClose,
    onSend
}: {
    initial: PolarMark | null;
    onClose: () => void;
    onSend: (reasons: PolarBadReason[], note: string | null) => Promise<boolean>;
}) {
    const t = useTranslations("polar");
    const [reasons, setReasons] = useState<PolarBadReason[]>(initial?.reasons ?? []);
    const [note, setNote] = useState(initial?.note ?? "");
    const [sending, setSending] = useState(false);
    const nothing = reasons.length === 0 && note.trim() === "";
    const toggle = (reason: PolarBadReason) =>
        setReasons((current) =>
            current.includes(reason)
                ? current.filter((entry) => entry !== reason)
                : [...current, reason]
        );
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("feedback.title")}</DialogTitle>
                    <DialogDescription>{t("feedback.intro")}</DialogDescription>
                </DialogHeader>
                <div
                    className="flex flex-wrap gap-1.5"
                    role="group"
                    aria-label={t("feedback.title")}
                >
                    {POLAR_BAD_REASONS.map((reason) => {
                        const on = reasons.includes(reason);
                        return (
                            <Button
                                key={reason}
                                type="button"
                                size="sm"
                                variant={on ? "secondary" : "outline"}
                                aria-pressed={on}
                                onClick={() => toggle(reason)}
                                className="max-w-full"
                            >
                                {on ? <Check className="size-3.5 shrink-0" /> : null}
                                <span className="min-w-0 truncate">
                                    {t(`feedback.reasons.${reason}`)}
                                </span>
                            </Button>
                        );
                    })}
                </div>
                <Textarea
                    value={note}
                    rows={3}
                    maxLength={POLAR_FEEDBACK_NOTE_MAX}
                    aria-label={t("feedback.note")}
                    placeholder={t("feedback.notePlaceholder")}
                    onChange={(event) => setNote(event.target.value)}
                />
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t("feedback.skip")}
                    </Button>
                    <Button
                        type="button"
                        disabled={nothing || sending}
                        aria-disabled={nothing || sending}
                        onClick={() => {
                            setSending(true);
                            void onSend(reasons, note.trim() || null).then((saved) => {
                                setSending(false);
                                if (saved) onClose();
                            });
                        }}
                    >
                        {t("feedback.send")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Read aloud

/** Most sentences one answer is read for: a very long answer stops there. */
const READ_MOST = 200;

type Reading = { id: string | null; loading: boolean };

let reading: Reading = { id: null, loading: false };
let stopCurrent: (() => void) | null = null;
const listeners = new Set<() => void>();

function setReading(next: Reading) {
    reading = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

/** Why reading stopped early, as the voice call names it. */
export type ReadError = "no_speech_provider" | "speak_failed" | "rate_limited";

function fetchSentence(text: string, payer: string | null, signal: AbortSignal) {
    return fetch("/api/polar/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, payer }),
        signal
    }).then(async (response): Promise<Blob | ReadError> => {
        if (response.ok) return response.blob();
        if (response.status === 409) return "no_speech_provider";
        if (response.status === 429) return "rate_limited";
        return "speak_failed";
    });
}

/** Stops whatever answer is being read. */
export function stopReading() {
    stopCurrent?.();
}

/**
 * Reads `text` out loud as answer `id`, stopping any other first. The next
 * sentence is fetched while the current one plays, so there is no gap.
 */
export function readAloud(
    id: string,
    text: string,
    payer: string | null,
    onError: (error: ReadError) => void
) {
    stopCurrent?.();
    const sentences = readySentences(text, 0, true).sentences.slice(0, READ_MOST);
    if (sentences.length === 0) return;
    const controller = new AbortController();
    let player: HTMLAudioElement | null = null;
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        controller.abort();
        player?.pause();
        player = null;
        if (stopCurrent === stop) stopCurrent = null;
        if (reading.id === id) setReading({ id: null, loading: false });
    };
    stopCurrent = stop;
    setReading({ id, loading: true });
    void (async () => {
        let next: Promise<Blob | ReadError> | null = fetchSentence(
            sentences[0]!,
            payer,
            controller.signal
        ).catch(() => "speak_failed" as const);
        for (let index = 0; index < sentences.length && next && !stopped; index++) {
            const blob = await next;
            if (stopped) return;
            next =
                index + 1 < sentences.length
                    ? fetchSentence(sentences[index + 1]!, payer, controller.signal).catch(
                          () => "speak_failed" as const
                      )
                    : null;
            if (typeof blob === "string") {
                onError(blob);
                break;
            }
            setReading({ id, loading: false });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            player = audio;
            await new Promise<void>((resolve) => {
                audio.onended = () => resolve();
                audio.onerror = () => resolve();
                audio.onpause = () => resolve();
                audio.play().catch(() => resolve());
            });
            URL.revokeObjectURL(url);
        }
        stop();
    })();
}

/** Whether answer `id` is being read, and still waiting for its first sound. */
export function useReading(id: string): { active: boolean; loading: boolean } {
    const current = useSyncExternalStore(
        subscribe,
        () => reading,
        () => reading
    );
    return { active: current.id === id, loading: current.id === id && current.loading };
}

// ---------------------------------------------------------------------------
// Answer again

export type RegenerateOptions = {
    refine?: PolarRefine;
    model?: { provider: string; model: string };
};

/** Answer again, and how. The models are the ones the composer offers. */
export function RegenerateMenu({
    providers,
    currentModel,
    onRegenerate
}: {
    providers: ModelSelectorProvider[];
    currentModel: string | null;
    onRegenerate: (options: RegenerateOptions) => void;
}) {
    const t = useTranslations("polar");
    const models = providers.flatMap((provider) =>
        provider.models.map((model) => ({ ...model, providerName: provider.name }))
    );
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <MessageAction label={t("actions.regenerate")}>
                    <RotateCcw />
                </MessageAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuItem onSelect={() => onRegenerate({})}>
                    <RotateCcw />
                    {t("actions.tryAgain")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRegenerate({ refine: "longer" })}>
                    <ListPlus />
                    {t("actions.longer")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRegenerate({ refine: "shorter" })}>
                    <ListMinus />
                    {t("actions.shorter")}
                </DropdownMenuItem>
                {models.length > 1 ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Bot />
                                {t("actions.otherModel")}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-80 max-w-72 overflow-y-auto">
                                {providers.map((provider) =>
                                    provider.models.length > 0 ? (
                                        <div key={provider.provider}>
                                            <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
                                                {provider.name}
                                            </DropdownMenuLabel>
                                            {provider.models.map((model) => (
                                                <DropdownMenuItem
                                                    key={`${model.provider}:${model.model}`}
                                                    title={model.name}
                                                    onSelect={() =>
                                                        onRegenerate({
                                                            model: {
                                                                provider: model.provider,
                                                                model: model.model
                                                            }
                                                        })
                                                    }
                                                >
                                                    <span className="min-w-0 flex-1 truncate">
                                                        {model.name}
                                                    </span>
                                                    {model.name === currentModel ? (
                                                        <Check className="shrink-0" />
                                                    ) : null}
                                                </DropdownMenuItem>
                                            ))}
                                        </div>
                                    ) : null
                                )}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
