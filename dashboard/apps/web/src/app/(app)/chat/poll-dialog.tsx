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
    error
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (draft: PollDraft) => void;
    busy?: boolean;
    /** What the server said, when it refused one this dialog thought was fine. */
    error?: string;
}) {
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
        ? "Ask something first"
        : tooLongQuestion
          ? `The question can be up to ${core.MAX_POLL_QUESTION} characters`
          : kept.length < core.MIN_POLL_OPTIONS
            ? "A poll needs at least two answers"
            : tooLongAnswer
              ? `An answer can be up to ${core.MAX_POLL_OPTION} characters`
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
        label: core.POLL_DURATION_LABELS[value] ?? `${value} hours`
    }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Create a poll</DialogTitle>
                    <DialogDescription>
                        It goes into the conversation as a message. Everybody here can answer, and
                        you can close it whenever you have what you needed.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            Question <span aria-hidden="true">*</span>
                        </span>
                        <Input
                            autoFocus
                            value={question}
                            disabled={busy}
                            maxLength={core.MAX_POLL_QUESTION}
                            placeholder="Where are we going for lunch?"
                            onChange={(event) => setQuestion(event.target.value)}
                        />
                    </label>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm">
                            Answers <span aria-hidden="true">*</span>
                        </span>
                        <ul className="flex flex-col gap-1.5">
                            {answers.map((text, index) => (
                                // eslint-disable-next-line react/no-array-index-key -- the row is its position
                                <li key={index} className="flex items-center gap-1">
                                    <Input
                                        value={text}
                                        disabled={busy}
                                        maxLength={core.MAX_POLL_OPTION}
                                        aria-label={`Answer ${index + 1}`}
                                        placeholder={`Answer ${index + 1}`}
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
                                        title="Remove"
                                        aria-label={`Remove answer ${index + 1}`}
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
                                Add an answer
                            </Button>
                        )}
                    </div>

                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            More than one answer
                            <span className="block text-xs text-muted-foreground">
                                People can pick as many as apply.
                            </span>
                        </span>
                        <Switch
                            checked={multiple}
                            disabled={busy}
                            onChange={setMultiple}
                            aria-label="Allow more than one answer"
                        />
                    </label>

                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            Hide the results until it closes
                            <span className="block text-xs text-muted-foreground">
                                Nobody sees the counts while it runs, so early votes do not sway
                                the rest.
                            </span>
                        </span>
                        <Switch
                            checked={hideResults}
                            disabled={busy}
                            onChange={setHideResults}
                            aria-label="Hide the results until the poll closes"
                        />
                    </label>

                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span id="poll-length">Open for</span>
                        <Select
                            value={String(hours)}
                            disabled={busy}
                            options={durations}
                            aria-label="How long the poll stays open"
                            className="w-44"
                            onValueChange={(value) => setHours(Number(value))}
                        />
                    </label>

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
                        Cancel
                    </Button>
                    <Button
                        onClick={send}
                        disabled={busy}
                        aria-disabled={refusal !== null}
                        title={refusal ?? undefined}
                    >
                        <BarChart3 />
                        {busy ? "Sending..." : "Create poll"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
