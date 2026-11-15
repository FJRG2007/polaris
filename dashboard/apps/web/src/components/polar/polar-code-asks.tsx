"use client";

/**
 * What a Code session's agent keeps for the person, above the reply box: its
 * todo list, a question it asks with options, and a plan it asks to have
 * approved. Laid out after Claude Code on the web and slopus/happy (MIT): one
 * question at a time with numbered options answered by 1-9, "N selected" for a
 * multi-select, "Something else" as free text, Skip, and "1 of N".
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import { runAction } from "@/lib/run-action";
import { sendAction } from "@/lib/poll-fetch";
import { Button, cn, Textarea } from "@polaris/ui";
import { useEffect, useState, useTransition } from "react";
import { MessageResponse } from "@/components/polar/elements/message";
import type { AskAnswer, AskQuestion, SessionAsk, SessionTodo } from "@/lib/agents/session-asks";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleDot, ListChecks, MessageCircleQuestion, NotebookPen } from "lucide-react";

const CARD = "flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3";

/** The agent's todo list, folded to its progress line until opened. */
export function CodeTodos({ todos }: { todos: readonly SessionTodo[] }) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(true);
    if (todos.length === 0) return null;
    const done = todos.filter((todo) => todo.status === "completed").length;
    return (
        <section aria-label={t("code.todos.title")} className={CARD}>
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-label={open ? t("code.todos.hide") : t("code.todos.show")}
                className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium"
            >
                <ListChecks className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate">{t("code.todos.title")}</span>
                <span className="ml-auto min-w-0 max-w-full shrink-0 truncate text-xs font-normal text-muted-foreground" title={t("code.todos.done", { done, total: todos.length })}>
                    {t("code.todos.done", { done, total: todos.length })}
                </span>
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
            </button>
            {open ? (
                <ol className="flex max-h-48 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain text-sm">
                    {todos.map((todo, index) => (
                        <li key={index} className="flex min-w-0 items-start gap-2">
                            <TodoMark status={todo.status} label={t(`code.todos.status.${todo.status}`)} />
                            <span
                                className={cn(
                                    "min-w-0 break-words",
                                    todo.status === "completed" && "text-muted-foreground line-through",
                                    todo.status === "in_progress" && "font-medium"
                                )}
                            >
                                {todo.text}
                            </span>
                        </li>
                    ))}
                </ol>
            ) : null}
        </section>
    );
}

function TodoMark({ status, label }: { status: SessionTodo["status"]; label: string }) {
    const Icon = status === "completed" ? Check : status === "in_progress" ? CircleDot : Circle;
    return (
        <Icon
            role="img"
            aria-label={label}
            className={cn("mt-0.5 size-4 shrink-0", status === "pending" ? "text-muted-foreground" : "text-primary")}
        />
    );
}

/** Post an answer to the agent's pending question or plan. */
function useAnswer(requestId: string, onAnswered: () => void) {
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const send = (choice: "allow" | "deny", answer: AskAnswer) => {
        setError(null);
        startTransition(() => {
            void runAction(
                () =>
                    sendAction<{ status?: string; error?: string }>("/api/agents/sessions/permission", {
                        requestId,
                        choice,
                        answer
                    }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                onAnswered();
            });
        });
    };
    return { error, busy, send };
}

/** One question's state: the labels picked and what was typed under "Something else". */
interface Picked {
    readonly labels: readonly string[];
    readonly other: string | null;
}

/** The answer a question's picks make: labels, then the free text, joined. */
export function answerText(picked: Picked): string {
    const parts = [...picked.labels];
    if (picked.other !== null && picked.other.trim()) parts.push(picked.other.trim());
    return parts.join(", ");
}

/** Pressing a number picks that option, unless the person is typing. */
function useNumberKeys(count: number, onPick: (index: number) => void, enabled: boolean) {
    useEffect(() => {
        if (!enabled) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
            const index = Number.parseInt(event.key, 10) - 1;
            if (Number.isInteger(index) && index >= 0 && index < count) {
                event.preventDefault();
                onPick(index);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [count, onPick, enabled]);
}

/** A question the agent asked, with its options. */
export function CodeAsk({
    requestId,
    questions,
    onAnswered
}: {
    requestId: string;
    questions: readonly AskQuestion[];
    onAnswered: () => void;
}) {
    const t = useTranslations("polar");
    const { error, busy, send } = useAnswer(requestId, onAnswered);
    return (
        <AskCard
            title={t("code.ask.title")}
            questions={questions}
            busy={busy}
            error={error}
            onAnswer={(answers) => send("allow", { answers })}
            onSkip={() => send("deny", {})}
        />
    );
}

/**
 * Questions with options, one at a time: shared by a Code session's agent and
 * Polar's own `polar_ask`. Answers go out keyed by each question's text.
 */
export function AskCard({
    title,
    questions,
    busy,
    error,
    onAnswer,
    onSkip
}: {
    title: string;
    questions: readonly AskQuestion[];
    busy: boolean;
    error: string | null;
    onAnswer: (answers: Record<string, string>) => void;
    onSkip: () => void;
}) {
    const t = useTranslations("polar");
    const [index, setIndex] = useState(0);
    const [picked, setPicked] = useState<Picked[]>(() => questions.map(() => ({ labels: [], other: null })));
    const question = questions[index]!;
    const mine = picked[index]!;
    const last = index === questions.length - 1;
    const answered = (entry: Picked) => answerText(entry) !== "";

    const update = (next: Picked) => setPicked((all) => all.map((entry, at) => (at === index ? next : entry)));
    const submit = (all: readonly Picked[]) =>
        onAnswer(Object.fromEntries(questions.map((entry, at) => [entry.question, answerText(all[at]!)])));
    const pick = (option: number) => {
        const label = question.options[option]!.label;
        if (question.multiSelect) {
            const labels = mine.labels.includes(label)
                ? mine.labels.filter((value) => value !== label)
                : [...mine.labels, label];
            return update({ ...mine, labels });
        }
        const next = picked.map((entry, at) => (at === index ? { labels: [label], other: null } : entry));
        setPicked(next);
        // A single choice is the answer: on to the next question, or sent.
        if (last) submit(next);
        else setIndex(index + 1);
    };
    useNumberKeys(question.options.length, pick, !busy);

    return (
        <section aria-label={title} className={CARD}>
            <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <MessageCircleQuestion className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 truncate">{question.header || title}</span>
                {questions.length > 1 ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
                        <button
                            type="button"
                            onClick={() => setIndex(index - 1)}
                            disabled={index === 0}
                            aria-label={t("code.ask.previous")}
                            className="rounded p-0.5 hover:bg-card-hover disabled:opacity-40"
                        >
                            <ChevronLeft className="size-4" aria-hidden />
                        </button>
                        {t("code.ask.pager", { index: index + 1, total: questions.length })}
                        <button
                            type="button"
                            onClick={() => setIndex(index + 1)}
                            disabled={last}
                            aria-label={t("code.ask.next")}
                            className="rounded p-0.5 hover:bg-card-hover disabled:opacity-40"
                        >
                            <ChevronRight className="size-4" aria-hidden />
                        </button>
                    </span>
                ) : null}
            </div>
            <p className="min-w-0 break-words text-sm">{question.question}</p>
            <div role={question.multiSelect ? "group" : "radiogroup"} className="flex min-w-0 flex-col gap-1">
                {question.options.map((option, at) => {
                    const on = mine.labels.includes(option.label);
                    return (
                        <button
                            key={option.label}
                            type="button"
                            role={question.multiSelect ? "checkbox" : "radio"}
                            aria-checked={on}
                            onClick={() => pick(at)}
                            disabled={busy}
                            className={cn(
                                "flex min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors hover:bg-card-hover disabled:opacity-60",
                                on ? "border-primary" : "border-border"
                            )}
                        >
                            <kbd className="mt-0.5 shrink-0 rounded border border-border px-1 text-[0.65rem] text-muted-foreground">
                                {at + 1}
                            </kbd>
                            <span className="flex min-w-0 flex-col">
                                <span className="break-words">{option.label}</span>
                                {option.description ? (
                                    <span className="break-words text-xs text-muted-foreground">
                                        {option.description}
                                    </span>
                                ) : null}
                            </span>
                            {on ? <Check className="ml-auto mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : null}
                        </button>
                    );
                })}
                {mine.other === null ? (
                    <button
                        type="button"
                        onClick={() => update({ labels: question.multiSelect ? mine.labels : [], other: "" })}
                        disabled={busy}
                        className="rounded-md border border-dashed border-border px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-card-hover"
                    >
                        {t("code.ask.other")}
                    </button>
                ) : (
                    <Textarea
                        autoFocus
                        value={mine.other}
                        onChange={(event) => update({ ...mine, other: event.target.value.slice(0, 2000) })}
                        placeholder={t("code.ask.otherPlaceholder")}
                        aria-label={t("code.ask.other")}
                        rows={2}
                        className="min-w-0 text-sm"
                    />
                )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {question.multiSelect || mine.other !== null || questions.length > 1 ? (
                    <Button
                        type="button"
                        size="sm"
                        disabled={busy || (last ? !picked.every(answered) : !answered(mine))}
                        onClick={() => (last ? submit(picked) : setIndex(index + 1))}
                    >
                        {last ? t("code.ask.submit") : t("code.ask.continue")}
                    </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onSkip}>
                    {t("code.ask.skip")}
                </Button>
                {question.multiSelect && mine.labels.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                        {t("code.ask.selected", { count: mine.labels.length })}
                    </span>
                ) : null}
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </section>
    );
}

/** The plan the agent asks to have approved before it changes anything. */
export function CodePlan({
    requestId,
    plan,
    onAnswered
}: {
    requestId: string;
    plan: string;
    onAnswered: () => void;
}) {
    const t = useTranslations("polar");
    const { error, busy, send } = useAnswer(requestId, onAnswered);
    const [feedback, setFeedback] = useState<string | null>(null);
    return (
        <section aria-label={t("code.plan.title")} className={CARD}>
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <NotebookPen className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 truncate">{t("code.plan.title")}</span>
            </p>
            <div className="max-h-72 min-w-0 overflow-y-auto overscroll-contain rounded-md border border-border px-3 py-2 text-sm">
                <MessageResponse>{plan}</MessageResponse>
            </div>
            {feedback !== null ? (
                <Textarea
                    autoFocus
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value.slice(0, 2000))}
                    placeholder={t("code.plan.feedbackPlaceholder")}
                    aria-label={t("code.plan.feedbackLabel")}
                    rows={3}
                    className="min-w-0 text-sm"
                />
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                {feedback === null ? (
                    <>
                        <Button type="button" size="sm" disabled={busy} onClick={() => send("allow", {})}>
                            {t("code.plan.approve")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setFeedback("")}>
                            {t("code.plan.keepPlanning")}
                        </Button>
                    </>
                ) : (
                    <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => send("deny", feedback.trim() ? { feedback: feedback.trim() } : {})}
                    >
                        {t("code.plan.send")}
                    </Button>
                )}
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </section>
    );
}

/** The card for a pending ask, by its kind. */
export function CodeAskCard({
    requestId,
    ask,
    onAnswered
}: {
    requestId: string;
    ask: SessionAsk;
    onAnswered: () => void;
}) {
    return ask.kind === "plan" ? (
        <CodePlan requestId={requestId} plan={ask.plan} onAnswered={onAnswered} />
    ) : (
        <CodeAsk requestId={requestId} questions={ask.questions} onAnswered={onAnswered} />
    );
}
