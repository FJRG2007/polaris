"use client";

/**
 * Asking a question with answers under it.
 *
 * Two boxes to start with and a third appearing as soon as the second is
 * written, because a poll with two answers is the common one and a dialog that
 * opened onto ten empty fields would make the common case the tidy-up case.
 *
 * Everything is checked against the schema the server uses, as it is typed, so
 * nothing is refused after the press. An empty answer is not an error - it is a
 * box nobody has got to yet, and it is simply dropped - which is why the button
 * says what is still missing rather than the fields turning red under somebody's
 * hands.
 *
 * The two switches are the two decisions people actually make about a poll.
 * Whether more than one answer may be picked is the difference between a lunch
 * order and a "which of these can you make". Whether the tallies show while it
 * runs is the difference between a poll and a poll where the first four votes
 * decide the rest.
 */

import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { BarChart3, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";

/** What a poll opens with. Two, and a third arrives as soon as the second is
 *  written - see `boxes` below. */
const OPENING_ANSWERS = 2;

/** How long each offered duration is called, by its length in hours. */
const POLL_DURATION_KEYS: Readonly<Record<number, NamespaceKey<"chat">>> = {
    1: "poll.durations.h1",
    4: "poll.durations.h4",
    8: "poll.durations.h8",
    24: "poll.durations.d1",
    72: "poll.durations.d3",
    168: "poll.durations.w1",
    336: "poll.durations.w2",
    [core.POLL_NO_END]: "poll.durations.open"
};

/** What this dialog hands back, ready for the schema. */
export interface PollDraft {
    question: string;
    options: string[];
    multiple: boolean;
    hideResults: boolean;
    hours: number;
}

export function PollDialog({
    open,
    onOpenChange,
    onConfirm,
    busy = false,
    timed = true,
    error
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (draft: PollDraft) => void;
    busy?: boolean;
    /**
     * Whether the question has a clock of its own.
     *
     * Off inside a call, where the call is the clock: it closes when the room
     * does, and offering "open for three days" would be offering a poll that
     * outlives the only place it can be answered.
     */
    timed?: boolean;
    /** What the server said, when it refused one this dialog thought was fine. */
    error?: string;
}) {
    const t = useTranslations("chat");
    const [question, setQuestion] = useState("");
    const [answers, setAnswers] = useState<string[]>(() => Array(OPENING_ANSWERS).fill(""));
    const [multiple, setMultiple] = useState(false);
    const [hideResults, setHideResults] = useState(false);
    const [hours, setHours] = useState<number>(core.DEFAULT_POLL_HOURS);
    /** The box to put the caret in after one is added, so the row that just
     *  appeared is the row being typed into. */
    const wanted = useRef<number | null>(null);
    const boxRefs = useRef<(HTMLInputElement | null)[]>([]);

    // Emptied every time it opens rather than when it closes: a dialog that
    // cleared on the way out would blank the fields under somebody watching it
    // animate away, and one that kept them would offer last week's question.
    useEffect(() => {
        if (!open) return;
        setQuestion("");
        setAnswers(Array(OPENING_ANSWERS).fill(""));
        setMultiple(false);
        setHideResults(false);
        setHours(core.DEFAULT_POLL_HOURS);
    }, [open]);

    useEffect(() => {
        const index = wanted.current;
        if (index === null) return;
        wanted.current = null;
        boxRefs.current[index]?.focus();
    }, [answers.length]);

    /** What would actually be stored: blanks and repeats gone. The same function
     *  the server normalizes with, so what is counted here is what lands. */
    const kept = useMemo(() => core.normalizePollOptions(answers), [answers]);

    const asked = question.trim();
    const tooLongQuestion = [...asked].length > core.MAX_POLL_QUESTION;
    const tooLongAnswer = kept.some((text) => [...text].length > core.MAX_POLL_OPTION);

    /**
     * What is stopping it going, in the order somebody would fix it.
     *
     * One sentence under the button rather than a message per field: at this
     * size the whole form is on screen at once, and three simultaneous
     * complaints about boxes somebody has not reached yet reads as being told
     * off for not having finished typing.
     */
    const refusal = !asked
        ? t("errors.pollQuestionRequired")
        : tooLongQuestion
          ? t("poll.questionTooLong", { max: core.MAX_POLL_QUESTION })
          : kept.length < core.MIN_POLL_OPTIONS
            ? t("poll.needsTwo")
            : tooLongAnswer
              ? t("poll.answerTooLong", { max: core.MAX_POLL_OPTION })
              : null;

    const setAnswer = (index: number, value: string) => {
        setAnswers((current) => current.map((text, at) => (at === index ? value : text)));
    };

    const addAnswer = () => {
        if (answers.length >= core.MAX_POLL_OPTIONS) return;
        wanted.current = answers.length;
        setAnswers((current) => [...current, ""]);
    };

    const removeAnswer = (index: number) => {
        setAnswers((current) =>
            current.length <= OPENING_ANSWERS
                ? current.map((text, at) => (at === index ? "" : text))
                : current.filter((_, at) => at !== index)
        );
    };

    const send = () => {
        if (busy || refusal) return;
        onConfirm({ question: asked, options: kept, multiple, hideResults, hours });
    };

    const durations = [...core.POLL_DURATIONS, core.POLL_NO_END].map((value) => ({
        value: String(value),
        label: POLL_DURATION_KEYS[value] ? t(POLL_DURATION_KEYS[value]!) : t("poll.hours", { count: value })
    }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("poll.createAPoll")}</DialogTitle>
                    <DialogDescription>
                        {t("poll.itGoesIntoTheConversation")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("poll.question")} <span aria-hidden="true">*</span>
                        </span>
                        <Input
                            autoFocus
                            value={question}
                            disabled={busy}
                            maxLength={core.MAX_POLL_QUESTION}
                            placeholder={t("poll.whereAreWeGoingFor")}
                            onChange={(event) => setQuestion(event.target.value)}
                        />
                    </label>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm">
                            {t("poll.answers")} <span aria-hidden="true">*</span>
                        </span>
                        <ul className="flex flex-col gap-1.5">
                            {answers.map((text, index) => (
                                // eslint-disable-next-line react/no-array-index-key -- the row is its position
                                <li key={index} className="flex items-center gap-1">
                                    <Input
                                        value={text}
                                        disabled={busy}
                                        maxLength={core.MAX_POLL_OPTION}
                                        aria-label={t("poll.answerN", { n: index + 1 })}
                                        placeholder={t("poll.answerN", { n: index + 1 })}
                                        ref={(node) => {
                                            boxRefs.current[index] = node;
                                        }}
                                        onChange={(event) => setAnswer(index, event.target.value)}
                                        // Enter moves down the list rather than
                                        // sending: somebody halfway through
                                        // writing the answers has not finished
                                        // asking the question.
                                        onKeyDown={(event) => {
                                            if (event.key !== "Enter") return;
                                            event.preventDefault();
                                            if (index === answers.length - 1) addAnswer();
                                            else boxRefs.current[index + 1]?.focus();
                                        }}
                                    />
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        disabled={busy}
                                        title={t("poll.remove")}
                                        aria-label={t("poll.removeAnswerN", { n: index + 1 })}
                                        onClick={() => removeAnswer(index)}
                                    >
                                        <X />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                        {answers.length < core.MAX_POLL_OPTIONS && (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={addAnswer}
                                className="self-start"
                            >
                                <Plus />
                                {t("poll.addAnAnswer")}
                            </Button>
                        )}
                    </div>

                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            {t("poll.moreThanOneAnswer")}
                            <span className="block text-xs text-muted-foreground">
                                {t("poll.peopleCanPickAsMany")}
                            </span>
                        </span>
                        <Switch
                            checked={multiple}
                            disabled={busy}
                            onChange={setMultiple}
                            aria-label={t("poll.allowMoreThanOneAnswer")}
                        />
                    </label>

                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            {t("poll.hideTheResultsUntilIt")}
                            <span className="block text-xs text-muted-foreground">
                                {t("poll.nobodySeesTheCountsWhile")}
                            </span>
                        </span>
                        <Switch
                            checked={hideResults}
                            disabled={busy}
                            onChange={setHideResults}
                            aria-label={t("poll.hideTheResultsUntilThe")}
                        />
                    </label>

                    {timed && (
                        <label className="flex items-center justify-between gap-3 text-sm">
                            <span id="poll-length">{t("poll.openFor")}</span>
                            <Select
                                value={String(hours)}
                                disabled={busy}
                                options={durations}
                                aria-label={t("poll.howLongThePollStays")}
                                className="w-44"
                                onValueChange={(value) => setHours(Number(value))}
                            />
                        </label>
                    )}

                    {(error || refusal) && (
                        <p
                            className={error ? "text-xs text-danger" : "text-xs text-muted-foreground"}
                        >
                            {error ?? refusal}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                        {t("poll.cancel")}
                    </Button>
                    <Button
                        onClick={send}
                        disabled={busy}
                        aria-disabled={refusal !== null}
                        title={refusal ?? undefined}
                    >
                        <BarChart3 />
                        {busy ? t("poll.sending") : t("poll.createPoll")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
