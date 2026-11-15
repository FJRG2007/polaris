"use client";

/**
 * Polar's own questions (`lib/polar/ask.ts`): the card above the composer
 * while one waits, drawn with the Code side's `AskCard`, and the folded
 * "Asked a question" line it leaves in the transcript.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { AskCard } from "@/components/polar/polar-code-asks";
import type { AskQuestion } from "@/lib/agents/session-asks";
import { ChevronDown, MessageCircleQuestion } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { askOutputOf, askQuestionsOf, type PolarAskOutput } from "@/lib/polar/ask";

/** The question waiting on the person, above the composer. */
export function PolarAskBar({
    questions,
    busy,
    onAnswer
}: {
    questions: readonly AskQuestion[];
    busy: boolean;
    onAnswer: (output: PolarAskOutput) => void;
}) {
    const t = useTranslations("polar");
    return (
        <AskCard
            title={t("ask.title")}
            questions={questions}
            busy={busy}
            error={null}
            onAnswer={(answers) => onAnswer({ status: "answered", answers })}
            onSkip={() => onAnswer({ status: "skipped" })}
        />
    );
}

/** The call as it stays in the transcript: one line, opened to the answers. */
export function AskChip({ input, output, waiting }: { input: unknown; output: unknown; waiting: boolean }) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const questions = askQuestionsOf(input);
    if (!questions) return null;
    const answer = askOutputOf(output);
    const replyTo = (question: string) =>
        !answer
            ? t(waiting ? "ask.waiting" : "ask.unanswered")
            : answer.status === "answered"
              ? answer.answers[question] || t("ask.skipped")
              : t(answer.status === "skipped" ? "ask.skipped" : "ask.unanswered");
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="flex w-fit min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-card-hover"
            >
                <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                    {questions.length > 1 ? t("ask.chipMany", { count: questions.length }) : t("ask.chip")}
                </span>
                <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
            </button>
            {open ? (
                <dl className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border px-3 py-2 text-sm">
                    {questions.map((question) => (
                        <div key={question.question} className="flex min-w-0 flex-col">
                            <dt className="break-words text-muted-foreground">{question.question}</dt>
                            <dd className="break-words">{replyTo(question.question)}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
        </div>
    );
}
