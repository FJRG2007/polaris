"use client";

/**
 * The `/btw` panel: a side question's answer above the composer, dismissed
 * with Escape or the close button, never part of the chat
 * (`lib/polar/btw.ts`). The newest earlier side questions sit dimmed above
 * it, with a count of older ones; picking one shows its answer again.
 */

import * as btw from "@/lib/polar/btw";
import { Button, cn } from "@polaris/ui";
import type { ModelChoice } from "@/lib/polar/shared";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Copy, MessageCircleQuestion, Trash2, X } from "lucide-react";
import { MessageResponse } from "@/components/polar/elements/message";

const ERRORS = new Set([
    "failed",
    "no_key",
    "unknown_model",
    "unsupported_kind",
    "usage_limit",
    "rate_limited",
    "invalid"
]);

/** The exchange on screen. `shown` is what the panel says was asked when it
 *  is not the question itself (`/recap`'s, which is Polar's own words). */
type Earlier = btw.BtwExchange & { shown?: string };
type Current = { question: string; shown?: string; answer: string | null; error: string | null };

/** The side questions of one chat: kept on this screen only, as Claude Code
 *  keeps them in memory, and gone with the chat. */
export function useSideQuestions(threadId: string | null) {
    const [earlier, setEarlier] = useState<Earlier[]>([]);
    const [current, setCurrent] = useState<Current | null>(null);
    const [open, setOpen] = useState(false);
    const asking = useRef(0);
    useEffect(() => {
        asking.current++;
        setEarlier([]);
        setCurrent(null);
        setOpen(false);
    }, [threadId]);

    const ask = useCallback(
        async ({ shown, ...input }: { question: string; shown?: string; context: string; choice: ModelChoice }) => {
            const ticket = ++asking.current;
            const replay = btw.replayed(
                current?.answer
                    ? [...earlier, { question: current.question, shown: current.shown, answer: current.answer }]
                    : earlier
            );
            setEarlier(replay);
            setCurrent({ question: input.question, shown, answer: null, error: null });
            setOpen(true);
            const sent = replay.map(({ question, answer }) => ({ question, answer }));
            const body: btw.BtwRequest = { ...input, earlier: sent, threadId };
            const response = await fetch("/api/polar/btw", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            }).catch(() => null);
            const data = (await response?.json().catch(() => null)) as { answer?: string; error?: string } | null;
            if (ticket !== asking.current) return;
            if (response?.ok && data?.answer) {
                return setCurrent({ question: input.question, shown, answer: data.answer, error: null });
            }
            const code = data?.error && ERRORS.has(data.error) ? data.error : "failed";
            setCurrent({ question: input.question, shown, answer: null, error: code });
        },
        [current, earlier, threadId]
    );

    /** `/btw` with no question: the panel again, on the newest exchange. */
    const reopen = useCallback(() => {
        if (!current) return false;
        setOpen(true);
        return true;
    }, [current]);

    const clearEarlier = useCallback(() => setEarlier([]), []);
    const dismiss = useCallback(() => setOpen(false), []);
    return { earlier, current, open, ask, reopen, clearEarlier, dismiss };
}

export function PolarSideQuestion({
    earlier,
    current,
    onDismiss,
    onClearEarlier,
    onCopied
}: {
    earlier: readonly Earlier[];
    current: Current;
    onDismiss: () => void;
    onClearEarlier: () => void;
    onCopied: (ok: boolean) => void;
}) {
    const t = useTranslations("polar");
    const [shown, setShown] = useState<number | null>(null);
    useEffect(() => setShown(null), [current]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.defaultPrevented) onDismiss();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onDismiss]);
    const listed = earlier.slice(-btw.POLAR_BTW_EARLIER_SHOWN);
    const older = earlier.length - listed.length;
    const picked = shown === null ? null : listed[shown];
    const question = picked ? (picked.shown ?? picked.question) : (current.shown ?? current.question);
    const answer = picked ? picked.answer : current.answer;
    return (
        <section
            aria-label={t("btw.title")}
            className="mb-2 flex max-h-[45vh] min-w-0 flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
            <header className="flex min-w-0 items-center gap-2">
                <MessageCircleQuestion aria-hidden className="size-4 shrink-0 text-primary" />
                <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                    {t("btw.title")}
                </p>
                <div className="flex shrink-0 items-center gap-0.5">
                    {answer ? (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("btw.copy")}
                            title={t("btw.copy")}
                            onClick={() =>
                                void navigator.clipboard
                                    .writeText(answer)
                                    .then(() => onCopied(true))
                                    .catch(() => onCopied(false))
                            }
                        >
                            <Copy className="size-4 shrink-0" />
                        </Button>
                    ) : null}
                    {earlier.length > 0 ? (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("btw.clear")}
                            title={t("btw.clear")}
                            onClick={() => {
                                setShown(null);
                                onClearEarlier();
                            }}
                        >
                            <Trash2 className="size-4 shrink-0" />
                        </Button>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("btw.dismiss")}
                        title={t("btw.dismiss")}
                        onClick={onDismiss}
                    >
                        <X className="size-4 shrink-0" />
                    </Button>
                </div>
            </header>
            {listed.length > 0 ? (
                <ul className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground/70">
                    {older > 0 ? <li>{t("btw.older", { count: older })}</li> : null}
                    {listed.map((entry, index) => (
                        <li key={`${index}:${entry.question}`} className="min-w-0">
                            <button
                                type="button"
                                className={cn(
                                    "block w-full min-w-0 truncate text-left hover:text-foreground",
                                    shown === index && "text-foreground"
                                )}
                                title={entry.shown ?? entry.question}
                                onClick={() => setShown(shown === index ? null : index)}
                            >
                                {entry.shown ?? entry.question}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <p className="min-w-0 break-words font-medium" title={question}>
                {question}
            </p>
            <div className="min-h-0 min-w-0 overflow-y-auto">
                {answer ? (
                    <MessageResponse>{answer}</MessageResponse>
                ) : current.error && !picked ? (
                    <p role="alert" className="text-destructive">
                        {t(`btw.errors.${current.error}`)}
                    </p>
                ) : (
                    <Shimmer>{t("btw.working")}</Shimmer>
                )}
            </div>
            <p className="text-xs text-muted-foreground">{t("btw.note")}</p>
        </section>
    );
}
