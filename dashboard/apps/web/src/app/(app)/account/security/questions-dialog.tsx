"use client";

/**
 * Recovery questions. Three of them, all of which must be answered correctly, so
 * a single guessable fact is never enough. They exist for one purpose: setting a
 * new password when the current one has been forgotten, on an instance with no
 * outbound mail to send a reset link through.
 *
 * Answers are compared case- and spacing-insensitively server-side, and stored
 * hashed - the dialog never sees an existing answer, only the questions.
 */

import { useState, type FormEvent } from "react";
import { SECURITY_QUESTION_COUNT, SECURITY_QUESTION_SUGGESTIONS, securityQuestionsSchema } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";
import { clearSecurityQuestionsAction, setSecurityQuestionsAction } from "./actions";
import { Feedback } from "./setting-card";

const CUSTOM = "__custom__";

const SUGGESTION_OPTIONS = [
    ...SECURITY_QUESTION_SUGGESTIONS.map((question) => ({ value: question, label: question })),
    { value: CUSTOM, label: "Write my own question" }
];

interface Entry {
    question: string;
    custom: boolean;
    answer: string;
}

function initialEntries(existing: string[]): Entry[] {
    return Array.from({ length: SECURITY_QUESTION_COUNT }, (_, index) => {
        const question = existing[index] ?? SECURITY_QUESTION_SUGGESTIONS[index] ?? "";
        return {
            question,
            custom: question !== "" && !SECURITY_QUESTION_SUGGESTIONS.includes(question),
            answer: ""
        };
    });
}

export function SecurityQuestionsDialog({
    open,
    onOpenChange,
    existing
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    existing: string[];
}) {
    const [entries, setEntries] = useState<Entry[]>(() => initialEntries(existing));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function update(index: number, patch: Partial<Entry>) {
        setEntries((prev) => prev.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        const answers = entries.map((entry) => ({ question: entry.question, answer: entry.answer }));
        const parsed = securityQuestionsSchema.safeParse({ answers });
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the form.");
            return;
        }
        const unique = new Set(answers.map((entry) => entry.question.trim().toLowerCase()));
        if (unique.size !== answers.length) {
            setError("Use a different question for each answer.");
            return;
        }
        setBusy(true);
        setError(null);
        const result = await setSecurityQuestionsAction(password, { answers });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setEntries(initialEntries(existing));
                    setError(null);
                }
            }}
        >
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Security questions</DialogTitle>
                    <DialogDescription>
                        All {SECURITY_QUESTION_COUNT} must be answered correctly to set a new password without the
                        old one.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-4">
                    {entries.map((entry, index) => (
                        <div key={index} className="flex flex-col gap-2">
                            <Select
                                value={entry.custom ? CUSTOM : entry.question}
                                options={SUGGESTION_OPTIONS}
                                aria-label={`Question ${index + 1}`}
                                onValueChange={(value) =>
                                    update(index, {
                                        custom: value === CUSTOM,
                                        question: value === CUSTOM ? "" : value
                                    })
                                }
                            />
                            {entry.custom ? (
                                <Input
                                    value={entry.question}
                                    placeholder="Your question"
                                    autoComplete="off"
                                    onChange={(event) => update(index, { question: event.target.value })}
                                />
                            ) : null}
                            <Input
                                value={entry.answer}
                                placeholder="Answer"
                                autoComplete="off"
                                required
                                onChange={(event) => update(index, { answer: event.target.value })}
                            />
                        </div>
                    ))}
                    <label className="flex flex-col gap-1 text-sm">
                        Account password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Saving..." : "Save questions"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ClearQuestionsDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const result = await clearSecurityQuestionsAction(
            String(new FormData(event.currentTarget).get("password") ?? "")
        );
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Remove security questions</DialogTitle>
                    <DialogDescription>
                        Without them, a forgotten password can only be recovered with an authenticator code.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Account password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="danger" disabled={busy}>
                            {busy ? "Removing..." : "Remove"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
