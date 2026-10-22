"use client";

/**
 * "Ask several": one question sent to 2-4 models at once, the answers side by
 * side, and "Continue with this one" to carry on with the best.
 *
 * Each model answers in a chat of its own, an ordinary Polar thread posted to
 * `/api/polar/chat` like any other, so it keeps answering when the comparison
 * is closed (`lib/polar/runs.ts`) and stays in the sidebar afterwards. Each
 * column is its own `useChat` on that thread: one failing leaves the others
 * alone. Polaris's tools stay off for the comparison, so nothing is done once
 * per model; memory and reading a page still ask for an approval, which is
 * answered by continuing with that chat.
 *
 * Wide screens get resizable columns; a phone gets one column at a time
 * behind tabs, all of them still following their answers.
 */

import { z } from "zod";
import { useChat } from "@ai-sdk/react";
import { Columns3, Plus, Square, X } from "lucide-react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PolarFailureNotice } from "@/components/polar/polar-failure";
import { MessageAction, MessageResponse } from "@/components/polar/elements/message";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import { sendableMessages } from "@/lib/polar/compaction";
import * as polarRuns from "@/components/polar/polar-runs";
import * as polarFailure from "@/lib/polar/provider-failure";
import { learnPath, pathThrough, type VersionTree } from "@/lib/polar/versions";
import { isAutomatic, modelChoiceSchema, type ModelChoice } from "@/lib/polar/shared";

/** Fewest and most models one question goes to. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;
/** The narrowest a column may be dragged, in percent of the row. */
const COLUMN_MIN = 15;
/** How far an arrow key moves a column edge, in percent. */
const KEY_STEP = 5;
/** Where the open comparison is kept for a reload of this tab. */
const COMPARE_KEY = "polar.compare";

const comparisonSchema = z.object({
    question: z.string().min(1).max(100_000),
    columns: z
        .array(
            z.object({
                threadId: z.string().uuid(),
                choice: modelChoiceSchema,
                /** Its question was posted: opened again, it reads the thread. */
                sent: z.boolean()
            })
        )
        .min(1)
        .max(COMPARE_MAX)
});
export type PolarComparison = z.infer<typeof comparisonSchema>;
export type ComparisonColumn = PolarComparison["columns"][number];
/** A new comparison, none, or a change worked out from the current one. */
export type ComparisonUpdate =
    | PolarComparison
    | null
    | ((current: PolarComparison | null) => PolarComparison | null);

/** Whether two choices name the same model; Automatic is one model here. */
export function sameModel(a: ModelChoice, b: ModelChoice): boolean {
    return a.provider === b.provider && a.model === b.model;
}

/** Whether any model is picked twice. */
export function hasRepeats(choices: readonly ModelChoice[]): boolean {
    return choices.some((choice, index) =>
        choices.slice(0, index).some((other) => sameModel(other, choice))
    );
}

/** Every model the person may use, as choices, in the selector's order. */
function offeredChoices(
    providers: readonly ModelSelectorProvider[],
    intelligence: ModelChoice["intelligence"]
): ModelChoice[] {
    return providers.flatMap((entry) =>
        entry.models.map((model) => ({
            kind: "language" as const,
            provider: model.provider,
            model: model.model,
            intelligence,
            payer: null
        }))
    );
}

/**
 * The models a comparison starts with: the one already chosen, then the next
 * models not picked yet, up to `count`. Fewer when fewer exist. Pure.
 */
export function seedChoices(
    current: ModelChoice | null,
    providers: readonly ModelSelectorProvider[],
    count = COMPARE_MIN
): ModelChoice[] {
    const picked: ModelChoice[] = current ? [current] : [];
    for (const option of offeredChoices(providers, current?.intelligence ?? "balanced")) {
        if (picked.length >= count) break;
        if (!picked.some((one) => sameModel(one, option))) picked.push(option);
    }
    return picked.slice(0, count);
}

/** The next model not picked yet, for "Add a model"; null when none is left. */
export function nextChoice(
    picked: readonly ModelChoice[],
    providers: readonly ModelSelectorProvider[]
): ModelChoice | null {
    const options = offeredChoices(providers, picked[0]?.intelligence ?? "balanced");
    return options.find((option) => !picked.some((one) => sameModel(one, option))) ?? null;
}

/**
 * How many more answers may start now, from `GET /api/polar/runs`; null when
 * the answer says nothing usable, and the chat route's own refusal decides.
 */
export function roomFrom(body: unknown): { room: number; max: number } | null {
    if (!body || typeof body !== "object") return null;
    const max = (body as { max?: unknown }).max;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return null;
    const running = Object.values(polarRuns.marksFrom(body)).filter(
        (run) => run.state === "running"
    ).length;
    return { room: Math.max(0, max - running), max };
}

/** Column widths after one edge moved by `delta` percent, each kept above the minimum. Pure. */
export function resized(
    widths: readonly number[],
    edge: number,
    delta: number,
    min = COLUMN_MIN
): number[] {
    const left = widths[edge];
    const right = widths[edge + 1];
    if (left === undefined || right === undefined) return [...widths];
    const moved = Math.max(min - left, Math.min(right - min, delta));
    const next = [...widths];
    next[edge] = left + moved;
    next[edge + 1] = right - moved;
    return next;
}

function equalWidths(count: number): number[] {
    return Array.from({ length: count }, () => 100 / count);
}

function readStoredComparison(): PolarComparison | null {
    try {
        const raw = window.sessionStorage.getItem(COMPARE_KEY);
        const parsed = comparisonSchema.safeParse(raw ? JSON.parse(raw) : null);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function storeComparison(comparison: PolarComparison | null): void {
    try {
        if (comparison) window.sessionStorage.setItem(COMPARE_KEY, JSON.stringify(comparison));
        else window.sessionStorage.removeItem(COMPARE_KEY);
    } catch {
        // Not kept: a reload simply opens a new chat.
    }
}

/**
 * The open comparison, kept for a reload of this tab. Only the view that can
 * start one (`kept`) reads or writes the stored one; any other stays out of it.
 */
export function useComparison(kept: boolean): [
    PolarComparison | null,
    (next: ComparisonUpdate) => void
] {
    const [comparison, setComparison] = useState<PolarComparison | null>(null);
    useEffect(() => {
        if (kept) setComparison(readStoredComparison());
    }, [kept]);
    const set = (next: ComparisonUpdate) =>
        setComparison((current) => {
            const value = typeof next === "function" ? next(current) : next;
            if (kept) storeComparison(value);
            return value;
        });
    return [comparison, set];
}

function modelName(
    choice: ModelChoice,
    providers: readonly ModelSelectorProvider[],
    t: ReturnType<typeof useTranslations>
): string {
    if (isAutomatic(choice)) return t("picker.automatic");
    const model = providers
        .find((entry) => entry.provider === choice.provider)
        ?.models.find((entry) => entry.model === choice.model);
    return model?.name ?? choice.model;
}

/**
 * The composer's "Ask several models" button and the dialog that picks them.
 * Offered while a new chat has nothing in it and the person has two models
 * or more to choose from.
 */
export function AskSeveral({
    providers,
    choice,
    question,
    hasFiles,
    onStart
}: {
    providers: ModelSelectorProvider[];
    choice: ModelChoice | null;
    question: string;
    hasFiles: boolean;
    onStart: (choices: ModelChoice[]) => void;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const [choices, setChoices] = useState<ModelChoice[]>([]);
    const [checking, setChecking] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [picking, setPicking] = useState<number | null>(null);
    const modelCount = providers.reduce((sum, entry) => sum + entry.models.length, 0);
    if (modelCount < COMPARE_MIN) return null;

    const reason = !question.trim()
        ? t("compare.needText")
        : hasFiles
          ? t("compare.noFiles")
          : hasRepeats(choices)
            ? t("compare.sameModel")
            : null;
    const more = choices.length < COMPARE_MAX ? nextChoice(choices, providers) : null;

    const start = async () => {
        if (reason || checking) return;
        setChecking(true);
        setNotice(null);
        const response = await fetch("/api/polar/runs").catch(() => null);
        const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
        setChecking(false);
        const room = roomFrom(body);
        if (room && room.room < choices.length) {
            setNotice(t("compare.noRoom", { room: room.room, max: room.max }));
            return;
        }
        setOpen(false);
        onStart(choices);
    };

    return (
        <>
            <MessageAction
                label={t("compare.open")}
                disabled={!choice}
                onClick={() => {
                    setChoices(seedChoices(choice, providers));
                    setNotice(null);
                    setOpen(true);
                }}
            >
                <Columns3 />
            </MessageAction>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="flex max-h-[min(36rem,90dvh)] max-w-md flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>{t("compare.title")}</DialogTitle>
                        <DialogDescription>{t("compare.intro")}</DialogDescription>
                    </DialogHeader>
                    <ol className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                        {choices.map((one, index) => (
                            <li
                                key={index}
                                className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2 py-1"
                            >
                                <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">
                                    {index + 1}
                                </span>
                                <span className="flex min-w-0 flex-1">
                                    <ModelSelector
                                        providers={providers}
                                        choice={one}
                                        onChoice={(next) =>
                                            setChoices((current) =>
                                                current.map((old, at) => (at === index ? next : old))
                                            )
                                        }
                                        open={picking === index}
                                        onOpenChange={(next) => setPicking(next ? index : null)}
                                    />
                                </span>
                                {choices.length > COMPARE_MIN ? (
                                    <MessageAction
                                        label={t("compare.remove")}
                                        onClick={() =>
                                            setChoices((current) =>
                                                current.filter((_, at) => at !== index)
                                            )
                                        }
                                    >
                                        <X />
                                    </MessageAction>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                    {more ? (
                        <Button
                            type="button"
                            variant="ghost"
                            className="self-start"
                            onClick={() => setChoices((current) => [...current, more])}
                        >
                            <Plus className="size-4" />
                            {t("compare.add")}
                        </Button>
                    ) : null}
                    {reason || notice ? (
                        <p role="status" className="text-sm text-muted-foreground">
                            {notice ?? reason}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                            {t("compare.cancel")}
                        </Button>
                        <Button
                            type="button"
                            disabled={!!reason || checking}
                            title={reason ?? undefined}
                            onClick={() => void start()}
                        >
                            {t("compare.send")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** What every column's turn is sent with besides its own model. */
export interface CompareSettings {
    /** Web search as the person left it. */
    web: boolean;
    /** Every Polaris tool, all switched off for the comparison. */
    toolNames: string[];
}

/** The comparison: the question on top, one column per model below it. */
export function PolarCompare({
    comparison,
    onChange,
    providers,
    isAdmin,
    settings,
    onContinue,
    onClose,
    onSettled
}: {
    comparison: PolarComparison;
    onChange: (next: ComparisonUpdate) => void;
    providers: ModelSelectorProvider[];
    isAdmin: boolean;
    settings: CompareSettings;
    /** Opens that chat as the one being talked to; the comparison closes. */
    onContinue: (threadId: string) => void;
    onClose: () => void;
    /** A column's answer ended: the sidebar and its title catch up. */
    onSettled: (threadId: string, answered: boolean) => void;
}) {
    const t = useTranslations("polar");
    const count = comparison.columns.length;
    const [widths, setWidths] = useState(() => equalWidths(count));
    const [active, setActive] = useState(0);
    const row = useRef<HTMLDivElement>(null);
    const drag = useRef<{ edge: number; x: number; from: number[] } | null>(null);
    useEffect(() => {
        setWidths(equalWidths(count));
        setActive((current) => Math.min(current, count - 1));
    }, [count]);

    const markSent = (threadId: string) =>
        // From the current one: every column marks itself in the same moment.
        onChange((current) =>
            current
                ? {
                      ...current,
                      columns: current.columns.map((column) =>
                          column.threadId === threadId ? { ...column, sent: true } : column
                      )
                  }
                : current
        );

    const startDrag = (edge: number, event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { edge, x: event.clientX, from: widths };
    };
    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const held = drag.current;
        const width = row.current?.getBoundingClientRect().width ?? 0;
        if (!held || width <= 0) return;
        setWidths(resized(held.from, held.edge, ((event.clientX - held.x) / width) * 100));
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-2">
                <p
                    className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-foreground"
                    title={comparison.question}
                >
                    {comparison.question}
                </p>
                <MessageAction label={t("compare.close")} onClick={onClose}>
                    <X />
                </MessageAction>
            </div>
            <div
                role="tablist"
                aria-label={t("compare.answers")}
                className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1 md:hidden"
            >
                {comparison.columns.map((column, index) => (
                    <button
                        key={column.threadId}
                        type="button"
                        role="tab"
                        id={`polar-compare-tab-${index}`}
                        aria-selected={index === active}
                        aria-controls={`polar-compare-column-${index}`}
                        onClick={() => setActive(index)}
                        className={cn(
                            "min-h-11 max-w-[12rem] shrink-0 truncate rounded-md px-3 text-xs",
                            index === active
                                ? "bg-muted text-foreground"
                                : "text-muted-foreground hover:bg-card-hover"
                        )}
                    >
                        {modelName(column.choice, providers, t)}
                    </button>
                ))}
            </div>
            <div ref={row} className="flex min-h-0 flex-1">
                {comparison.columns.map((column, index) => (
                    <div key={column.threadId} className="contents">
                        {index > 0 ? (
                            <div
                                role="separator"
                                tabIndex={0}
                                aria-orientation="vertical"
                                aria-label={t("compare.resize")}
                                aria-valuemin={COLUMN_MIN}
                                aria-valuemax={100 - COLUMN_MIN}
                                aria-valuenow={Math.round(widths[index - 1] ?? 0)}
                                onPointerDown={(event) => startDrag(index - 1, event)}
                                onPointerMove={moveDrag}
                                onPointerUp={() => (drag.current = null)}
                                onPointerCancel={() => (drag.current = null)}
                                onKeyDown={(event) => {
                                    const step =
                                        event.key === "ArrowLeft"
                                            ? -KEY_STEP
                                            : event.key === "ArrowRight"
                                              ? KEY_STEP
                                              : 0;
                                    if (!step) return;
                                    event.preventDefault();
                                    setWidths((current) => resized(current, index - 1, step));
                                }}
                                className="relative hidden w-1 shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary focus-visible:bg-primary focus-visible:outline-none md:block"
                            />
                        ) : null}
                        <section
                            role="tabpanel"
                            id={`polar-compare-column-${index}`}
                            aria-labelledby={`polar-compare-tab-${index}`}
                            style={{ flexBasis: `${widths[index] ?? 100 / count}%` }}
                            className={cn(
                                "min-w-0 flex-1 flex-col md:flex md:grow-0",
                                index === active ? "flex" : "hidden"
                            )}
                        >
                            <ComparisonColumnView
                                column={column}
                                question={comparison.question}
                                name={modelName(column.choice, providers, t)}
                                providers={providers}
                                isAdmin={isAdmin}
                                settings={settings}
                                onSent={() => markSent(column.threadId)}
                                onContinue={() => onContinue(column.threadId)}
                                onSettled={(answered) => onSettled(column.threadId, answered)}
                            />
                        </section>
                    </div>
                ))}
            </div>
        </div>
    );
}

type StoredMessage = UIMessage & { parentId: string | null };

/**
 * A thread's newest path, as the chat shows it; "missing" when the server has
 * no such thread, null when it cannot be read.
 */
async function storedPath(threadId: string): Promise<UIMessage[] | "missing" | null> {
    const response = await fetch(`/api/polar/threads/${threadId}`).catch(() => null);
    if (response?.status === 404) return "missing";
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as {
        thread?: { messages?: StoredMessage[] };
    } | null;
    const messages = body?.thread?.messages;
    if (!Array.isArray(messages)) return null;
    const tree: VersionTree = new Map();
    learnPath(tree, messages, new Map(messages.map((message) => [message.id, message.parentId])));
    const root = messages.filter((message) => message.parentId === null).at(-1);
    return root ? pathThrough(tree, [], 0, root.id) : [];
}

interface ColumnProps {
    column: ComparisonColumn;
    question: string;
    name: string;
    providers: ModelSelectorProvider[];
    isAdmin: boolean;
    settings: CompareSettings;
    onSent: () => void;
    onContinue: () => void;
    onSettled: (answered: boolean) => void;
}

/**
 * One model's column. Posted already (a reload, or the comparison opened
 * again), it opens the thread as stored and picks up an answer still running.
 */
function ComparisonColumnView(props: ColumnProps) {
    // Decided once: marking the question sent must not reopen the column.
    const [restored, setRestored] = useState(props.column.sent);
    const [opening, setOpening] = useState<UIMessage[] | null>(restored ? null : []);
    useEffect(() => {
        if (!restored) return;
        let gone = false;
        void storedPath(props.column.threadId).then((messages) => {
            if (gone) return;
            // Never reached the server: it is asked again.
            if (messages === "missing") setRestored(false);
            setOpening(messages === "missing" ? [] : (messages ?? []));
        });
        return () => {
            gone = true;
        };
    }, [restored, props.column.threadId]);
    if (opening === null)
        return (
            <div className="flex flex-col gap-2 p-4" aria-hidden>
                <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-4 w-full animate-pulse rounded bg-muted" />
                <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
            </div>
        );
    return <ColumnChat {...props} opening={opening} resume={restored} />;
}

function textOf(message: UIMessage): string {
    return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
}

function ColumnChat({
    column,
    question,
    name,
    providers,
    isAdmin,
    settings,
    onSent,
    onContinue,
    onSettled,
    opening,
    resume
}: ColumnProps & { opening: UIMessage[]; resume: boolean }) {
    const t = useTranslations("polar");
    const live = useRef(settings);
    live.current = settings;
    const transport = useMemo(
        () =>
            new DefaultChatTransport({
                api: "/api/polar/chat",
                prepareSendMessagesRequest: ({ messages }) => ({
                    body: {
                        threadId: column.threadId,
                        messages: sendableMessages(messages),
                        choice: column.choice,
                        remember: true,
                        context: null,
                        projectId: null,
                        temporary: false,
                        web: live.current.web,
                        off: live.current.toolNames,
                        connectors: false,
                        refine: null,
                        parentId:
                            messages.length > 1 ? (messages[messages.length - 2]?.id ?? null) : null
                    }
                })
            }),
        [column.threadId, column.choice]
    );
    const chat = useChat({ id: column.threadId, messages: opening, transport, resume });
    const busy = chat.status === "submitted" || chat.status === "streaming";
    const answers = chat.messages.filter((message) => message.role === "assistant");
    const answered = answers.some((message) => textOf(message) !== "");

    // A new column asks its question once, as soon as it is on screen.
    const asked = useRef(resume);
    useEffect(() => {
        if (asked.current) return;
        asked.current = true;
        void chat.sendMessage({ text: question });
    }, []);

    // Marked sent once the server took the turn, so a reload before that asks again.
    const accepted = useRef(resume);
    useEffect(() => {
        if (accepted.current) return;
        const answering =
            chat.status === "streaming" ||
            chat.messages.some((message) => message.role === "assistant");
        if (!answering) return;
        accepted.current = true;
        onSent();
    }, [chat.status, chat.messages]);

    const wasBusy = useRef(busy);
    useEffect(() => {
        if (wasBusy.current && !busy) onSettled(answered);
        wasBusy.current = busy;
    }, [busy]);
    const last = chat.messages.at(-1);
    const failure = last?.role === "assistant" ? polarFailure.messageFailure(last) : null;
    const looseError = chat.error && !failure ? chat.error : null;
    const waiting = last?.parts.some(
        (part) => "state" in part && part.state === "approval-requested"
    );

    return (
        <>
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={name}>
                    {name}
                </span>
                {busy ? (
                    <MessageAction
                        label={t("actions.stop")}
                        onClick={() =>
                            void Promise.all([chat.stop(), polarRuns.stopPolarAnswer(column.threadId)])
                        }
                    >
                        <Square />
                    </MessageAction>
                ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
                <div className="flex min-w-0 flex-col gap-3" aria-live="polite" aria-busy={busy}>
                    {answers.map((message) => {
                        const text = textOf(message);
                        return text ? <MessageResponse key={message.id}>{text}</MessageResponse> : null;
                    })}
                    {busy && !answered ? (
                        <Shimmer className="text-sm">{t("compare.answering")}</Shimmer>
                    ) : null}
                    {!busy && (failure || looseError) ? (
                        <PolarFailureNotice
                            failure={failure}
                            isAdmin={isAdmin}
                            providers={providers}
                            failedModel={column.choice.model}
                            onRetry={() => void chat.regenerate()}
                        />
                    ) : null}
                    {waiting ? (
                        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                            {t("compare.approval")}
                        </p>
                    ) : null}
                </div>
            </div>
            <div className="flex shrink-0 justify-end border-t border-border px-3 py-2">
                <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={onContinue}
                >
                    {t("compare.continue")}
                </Button>
            </div>
        </>
    );
}
