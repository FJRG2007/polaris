"use client";

/**
 * Subagents on the chat screen (`lib/polar/subagents`): a card in the
 * transcript for each `polar_task` call, following its steps live; a bar over
 * the composer while any of the chat's subagents works, opening the list of
 * all of them; and a transcript dialog to read one, stop it, message it while
 * it works, or continue it once it has ended.
 *
 * A foreground run's steps arrive in the answer's own stream; the list and a
 * background run are read from `/api/polar/threads/[id]/subagents`, again
 * every few seconds only while something is running.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Loader2, Square, Workflow } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Textarea,
    cn,
    useToast
} from "@polaris/ui";
import * as shared from "@/lib/polar/subagents/shared";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** How often a running subagent is read again. */
const POLL_MS = 2_500;

type Translate = ReturnType<typeof useTranslations<"polar">>;

function durationOf(t: Translate, startedAt: number, endedAt: number | null, now: number): string {
    const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return min > 0 ? t("subagents.duration", { min, sec }) : t("subagents.seconds", { sec });
}

/** Ticks once a second while `on`, for a running duration. */
function useNow(on: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!on) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [on]);
    return now;
}

/** A chat's subagents, read again while any of them is running. */
export function useThreadSubagents(threadId: string | null, wake = 0) {
    const [list, setList] = useState<shared.SubagentView[] | null>(null);
    const [failed, setFailed] = useState(false);
    const load = useCallback(async () => {
        if (!threadId) return;
        try {
            const response = await fetch(`/api/polar/threads/${threadId}/subagents`, {
                cache: "no-store"
            });
            if (!response.ok) throw new Error(String(response.status));
            const body = (await response.json()) as { subagents?: shared.SubagentView[] };
            setList(body.subagents ?? []);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, [threadId]);
    useEffect(() => {
        setList(null);
        void load();
    }, [load, wake]);
    const running = (list ?? []).some((entry) => entry.status === "running");
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [running, load]);
    return { list, failed, reload: load };
}

function StatusMark({ status }: { status: shared.SubagentStatus }) {
    if (status === "running")
        return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden />;
    return (
        <span
            aria-hidden
            className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                status === "done" ? "bg-success" : status === "stopped" ? "bg-foreground-muted" : "bg-danger"
            )}
        />
    );
}

/**
 * The card a `polar_task` call draws in the transcript. Its output streams in
 * while the run works; a background run is followed from the list instead.
 */
export function SubagentCard({
    output,
    streaming,
    live,
    onOpen
}: {
    output: shared.TaskOutput | null;
    streaming: boolean;
    /** The newest read of this run from the list, for a background one. */
    live: shared.SubagentView | null;
    onOpen: (id: string) => void;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const status: shared.SubagentStatus = live?.status ?? output?.status ?? "running";
    const steps = live?.steps ?? output?.steps ?? [];
    const now = useNow(status === "running");
    if (output?.refusal) {
        const known = output.refusal in REFUSAL_KEYS;
        return (
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground-muted">
                {t(`subagents.refusals.${known ? (output.refusal as "invalid") : "invalid"}`)}
            </div>
        );
    }
    if (!output) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground-muted">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                <span className="min-w-0 truncate">{t("subagents.label")}</span>
            </div>
        );
    }
    const name = output.name;
    const model = live?.model || output.model;
    return (
        <div className="rounded-lg border border-border bg-card text-sm">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
            >
                <ChevronRight
                    aria-hidden
                    className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
                />
                <StatusMark status={streaming && status === "running" ? "running" : status} />
                <Bot className="h-3.5 w-3.5 shrink-0 text-foreground-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={live?.description ?? name}>
                    <span className="font-medium">{name}</span>
                    {live?.description ? (
                        <span className="text-foreground-muted"> - {live.description}</span>
                    ) : null}
                </span>
                {output.background ? (
                    <span
                        className="hidden min-w-0 max-w-[30%] truncate text-xs text-foreground-muted sm:inline"
                        title={t("subagents.background")}
                    >
                        {t("subagents.background")}
                    </span>
                ) : null}
                <span className="shrink-0 text-xs text-foreground-muted">
                    {t(`subagents.status.${status}`)} · {durationOf(t, output.startedAt, live?.endedAt ?? output.endedAt, now)}
                </span>
            </button>
            {open ? (
                <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-muted">
                        {model ? <span className="min-w-0 truncate" title={model}>{model}</span> : null}
                        <span>{t("subagents.steps", { count: steps.length })}</span>
                    </div>
                    {steps.length > 0 ? (
                        <ol className="flex max-h-48 flex-col gap-1 overflow-auto overscroll-contain text-xs">
                            {steps.map((step, index) => (
                                <li key={`${step.at}-${index}`} className="flex min-w-0 items-center gap-2">
                                    <StatusMark
                                        status={
                                            step.state === "running"
                                                ? "running"
                                                : step.state === "done"
                                                  ? "done"
                                                  : "failed"
                                        }
                                    />
                                    <span className="min-w-0 truncate font-mono" title={step.tool}>{step.tool}</span>
                                </li>
                            ))}
                        </ol>
                    ) : null}
                    {status === "failed" && !output.summary ? (
                        <p className="text-xs text-foreground-muted">{t("subagents.failure")}</p>
                    ) : null}
                    {output.id ? (
                        <div>
                            <Button size="sm" variant="outline" onClick={() => onOpen(output.id)}>
                                {t("subagents.open")}
                            </Button>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

const REFUSAL_KEYS = {
    invalid: true,
    per_turn: true,
    too_many: true,
    unknown_type: true,
    no_model: true,
    not_resumable: true
};

async function post(id: string, body: shared.SubagentAction): Promise<boolean> {
    try {
        const response = await fetch(`/api/polar/subagents/${id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        });
        return response.ok;
    } catch {
        return false;
    }
}

/** One subagent's whole transcript, with its stop, steer and continue. */
export function SubagentDialog({
    id,
    onClose,
    onContinue,
    onChanged
}: {
    id: string | null;
    onClose: () => void;
    /** Sends the chat a message asking Polar to continue this subagent. */
    onContinue?: (text: string) => void;
    onChanged?: () => void;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const [detail, setDetail] = useState<shared.SubagentDetail | null>(null);
    const [failed, setFailed] = useState(false);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const end = useRef<HTMLDivElement>(null);
    const load = useCallback(async () => {
        if (!id) return;
        try {
            const response = await fetch(`/api/polar/subagents/${id}`, { cache: "no-store" });
            if (!response.ok) throw new Error(String(response.status));
            const body = (await response.json()) as { subagent: shared.SubagentDetail };
            setDetail(body.subagent);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, [id]);
    useEffect(() => {
        setDetail(null);
        setDraft("");
        void load();
    }, [load]);
    const running = detail?.status === "running";
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [running, load]);
    useEffect(() => end.current?.scrollIntoView({ block: "end" }), [detail?.lines.length]);
    const now = useNow(running);

    const stop = async () => {
        if (!id) return;
        setBusy(true);
        const ok = await post(id, { action: "stop" });
        setBusy(false);
        if (!ok) toast.show({ title: t("subagents.stopFailed") });
        void load();
        onChanged?.();
    };
    const send = async () => {
        const text = draft.trim().slice(0, shared.STEER_MAX);
        if (!id || !text) return;
        if (!running) {
            onContinue?.(t("subagents.continuePrompt", { id, text }));
            setDraft("");
            onClose();
            return;
        }
        setBusy(true);
        const ok = await post(id, { action: "steer", text });
        setBusy(false);
        if (ok) {
            setDraft("");
            toast.show({ title: t("subagents.steerSent") });
        } else toast.show({ title: t("subagents.steerFailed") });
        void load();
    };

    return (
        <Dialog open={id !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-3"
            >
                <DialogHeader>
                    <DialogTitle className="min-w-0 truncate pr-6">
                        {detail
                            ? t("subagents.transcriptTitle", {
                                  name: detail.name,
                                  description: detail.description
                              })
                            : t("subagents.label")}
                    </DialogTitle>
                </DialogHeader>
                {detail ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
                        <StatusMark status={detail.status} />
                        <span>{t(`subagents.status.${detail.status}`)}</span>
                        <span>{durationOf(t, detail.startedAt, detail.endedAt, now)}</span>
                        {detail.model ? <span className="min-w-0 truncate" title={detail.model}>{detail.model}</span> : null}
                        <span>
                            {t("subagents.tokens", {
                                count: detail.inputTokens + detail.outputTokens
                            })}
                        </span>
                    </div>
                ) : null}
                <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border p-3 text-sm">
                    {failed ? (
                        <div className="flex flex-col items-start gap-2">
                            <p className="text-foreground-muted">{t("subagents.loadFailed")}</p>
                            <Button size="sm" variant="outline" onClick={() => void load()}>
                                {t("subagents.retry")}
                            </Button>
                        </div>
                    ) : !detail ? (
                        <div className="flex flex-col gap-2" aria-busy>
                            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {(detail.lines.length > 0
                                ? detail.lines
                                : [{ role: "task" as const, text: detail.prompt }]
                            ).map((line, index) =>
                                line.role === "tool" ? (
                                    <p key={index} className="min-w-0 truncate font-mono text-xs text-foreground-muted">
                                        {t("subagents.usedTool", { tool: line.tool ?? "?" })}
                                    </p>
                                ) : (
                                    <div key={index} className="flex min-w-0 flex-col gap-1">
                                        <span className="text-xs font-medium text-foreground-muted">
                                            {line.role === "task"
                                                ? t("subagents.task")
                                                : line.role === "steer"
                                                  ? t("subagents.you")
                                                  : detail.name}
                                        </span>
                                        <p className="whitespace-pre-wrap break-words">{line.text}</p>
                                    </div>
                                )
                            )}
                            {!running ? (
                                <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
                                    <span className="text-xs font-medium text-foreground-muted">
                                        {t("subagents.report")}
                                    </span>
                                    <p className="whitespace-pre-wrap break-words">
                                        {detail.summary ||
                                            (detail.status === "failed"
                                                ? t("subagents.failure")
                                                : t("subagents.noReport"))}
                                    </p>
                                </div>
                            ) : null}
                            <div ref={end} />
                        </div>
                    )}
                </div>
                {detail && (running || onContinue) ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <Textarea
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            maxLength={shared.STEER_MAX}
                            rows={2}
                            placeholder={
                                running
                                    ? t("subagents.steerPlaceholder")
                                    : t("subagents.continuePlaceholder")
                            }
                            className="min-w-0 flex-1 resize-none"
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    void send();
                                }
                            }}
                        />
                        <div className="flex shrink-0 gap-2">
                            {running ? (
                                <Button variant="outline" onClick={() => void stop()} disabled={busy}>
                                    <Square className="h-3.5 w-3.5" aria-hidden />
                                    {t("subagents.stop")}
                                </Button>
                            ) : null}
                            <Button onClick={() => void send()} disabled={busy || !draft.trim()}>
                                {running ? t("subagents.send") : t("subagents.continue")}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The bar over the composer while the chat has subagents, opening the list of
 * all of them; hidden when it has none.
 */
export function SubagentBar({
    list,
    onOpen
}: {
    list: shared.SubagentView[] | null;
    onOpen: (id: string) => void;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const now = useNow(open);
    if (!list || list.length === 0) return null;
    const running = list.filter((entry) => entry.status === "running").length;
    if (running === 0 && !open) return null;
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="mx-auto flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground-muted hover:text-foreground"
            >
                <Workflow className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t("subagents.panelOpen")}</span>
                <span className="shrink-0 font-medium text-primary">
                    {t("subagents.panelRunning", { count: running })}
                </span>
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent
                    aria-describedby={undefined}
                    className="flex max-h-[80vh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-3"
                >
                    <DialogHeader>
                        <DialogTitle>{t("subagents.title")}</DialogTitle>
                    </DialogHeader>
                    <ul className="flex min-h-0 flex-col gap-1 overflow-auto overscroll-contain">
                        {[...list].reverse().map((entry) => (
                            <li key={entry.id}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setOpen(false);
                                        onOpen(entry.id);
                                    }}
                                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                                >
                                    <StatusMark status={entry.status} />
                                    <span className="min-w-0 flex-1 truncate" title={entry.description}>
                                        <span className="font-medium">{entry.name}</span>
                                        <span className="text-foreground-muted"> - {entry.description}</span>
                                    </span>
                                    {entry.background ? (
                                        <span
                                            className="hidden min-w-0 max-w-[30%] truncate text-xs text-foreground-muted sm:inline"
                                            title={t("subagents.background")}
                                        >
                                            {t("subagents.background")}
                                        </span>
                                    ) : null}
                                    <span className="shrink-0 text-xs text-foreground-muted">
                                        {t(`subagents.status.${entry.status}`)} ·{" "}
                                        {durationOf(t, entry.startedAt, entry.endedAt, now)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    {list.length === 0 ? (
                        <p className="text-sm text-foreground-muted">{t("subagents.panelEmpty")}</p>
                    ) : null}
                </DialogContent>
            </Dialog>
        </>
    );
}
