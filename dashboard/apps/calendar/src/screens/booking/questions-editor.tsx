"use client";

/**
 * The questions a booking page asks besides name and email: a short answer, a
 * long one, or one choice among options, each required or not.
 */

import { newQuestion } from "./model";
import { useCalendarT } from "../i18n";
import { Plus, Trash2, X } from "lucide-react";
import { Button, Checkbox, Input, Select } from "@polaris/ui";
import type { BookingQuestion, QuestionKind } from "../../lib/scheduling-schemas";

const MAX_QUESTIONS = 10;

export function QuestionsEditor({
    value,
    onChange,
    error
}: {
    value: readonly BookingQuestion[];
    onChange: (questions: BookingQuestion[]) => void;
    error: string | null;
}) {
    const t = useCalendarT();
    const kinds: { value: QuestionKind; label: string }[] = [
        { value: "short", label: t("bookingPage.kindShort") },
        { value: "long", label: t("bookingPage.kindLong") },
        { value: "choice", label: t("bookingPage.kindChoice") }
    ];
    const update = (index: number, patch: Partial<BookingQuestion>) =>
        onChange(value.map((question, at) => (at === index ? { ...question, ...patch } : question)));

    return (
        <div className="flex flex-col gap-2">
            {value.length === 0 ? <p className="text-foreground-subtle">{t("bookingPage.noQuestions")}</p> : null}
            {value.map((question, index) => (
                <div key={question.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={question.label}
                            onChange={(event) => update(index, { label: event.target.value })}
                            placeholder={t("bookingPage.questionPlaceholder")}
                            aria-label={t("bookingPage.questionLabel")}
                            className="min-w-0 flex-1 basis-48"
                        />
                        <Select
                            value={question.kind}
                            onValueChange={(kind) => update(index, { kind: kind as QuestionKind, options: kind === "choice" && question.options.length === 0 ? ["", ""] : question.options })}
                            options={kinds}
                            aria-label={t("bookingPage.questionKind")}
                            className="w-40"
                        />
                        <label className="flex items-center gap-2 text-muted-foreground">
                            <Checkbox checked={question.required} onChange={(event) => update(index, { required: event.target.checked })} />
                            {t("bookingPage.required")}
                        </label>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => onChange(value.filter((_, at) => at !== index))}
                            aria-label={t("bookingPage.removeQuestion")}
                            title={t("bookingPage.removeQuestion")}
                        >
                            <Trash2 />
                        </Button>
                    </div>
                    {question.kind === "choice" ? (
                        <div className="flex flex-col gap-1.5 pl-0 sm:pl-4">
                            {question.options.map((option, at) => (
                                <div key={at} className="flex items-center gap-1.5">
                                    <Input
                                        value={option}
                                        onChange={(event) => update(index, { options: question.options.map((entry, place) => (place === at ? event.target.value : entry)) })}
                                        placeholder={t("bookingPage.optionPlaceholder", { n: at + 1 })}
                                        aria-label={t("bookingPage.optionPlaceholder", { n: at + 1 })}
                                        className="min-w-0 flex-1"
                                    />
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        onClick={() => update(index, { options: question.options.filter((_, place) => place !== at) })}
                                        aria-label={t("bookingPage.removeOption")}
                                        title={t("bookingPage.removeOption")}
                                    >
                                        <X />
                                    </Button>
                                </div>
                            ))}
                            <div>
                                <Button size="xs" variant="ghost" disabled={question.options.length >= 20} onClick={() => update(index, { options: [...question.options, ""] })}>
                                    <Plus />
                                    {t("bookingPage.addOption")}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </div>
            ))}
            <div>
                <Button size="sm" variant="outline" disabled={value.length >= MAX_QUESTIONS} onClick={() => onChange([...value, newQuestion()])}>
                    <Plus />
                    {t("bookingPage.addQuestion")}
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
