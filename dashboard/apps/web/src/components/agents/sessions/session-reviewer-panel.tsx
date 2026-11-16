"use client";

/**
 * The reviewer agent on a session's pull request tab: which tool reviews this
 * repository's pull requests (its owner picks it), and what the latest passes
 * over this pull request said. The last answer paints first and is read again
 * behind it; a pass still running is read again every few seconds.
 */

import { runAction } from "@/lib/run-action";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ScanSearch } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import type { SessionView } from "@/lib/agents/session-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Input, Select, Skeleton } from "@polaris/ui";
import {
    requestSessionReviewAction,
    sessionReviewerAction,
    setSessionReviewerAction,
    type SessionReviewerView
} from "./actions";

const OFF = "__off__";
const RUNNING_POLL_MS = 10_000;
const cache = new Map<string, SessionReviewerView | null>();

export function SessionReviewerPanel({ session }: { session: SessionView }) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const [view, setView] = useState<SessionReviewerView | null | undefined>(() => cache.get(session.id));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [model, setModel] = useState(view?.model ?? "");

    const load = useCallback(async () => {
        const result = await sessionReviewerAction(session.id).catch(() => null);
        if (!result) return;
        if (result.error) return setError(result.error);
        cache.set(session.id, result.view ?? null);
        setView(result.view ?? null);
        setModel(result.view?.model ?? "");
    }, [session.id]);

    useEffect(() => {
        void load();
    }, [load]);
    const running = view?.reviews.some((review) => review.state === "running") ?? false;
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => void load(), RUNNING_POLL_MS);
        return () => clearInterval(timer);
    }, [running, load]);

    if (view === null) return null;
    if (view === undefined)
        return (
            <section className="flex min-w-0 flex-col gap-2">
                <h4 className="text-sm font-semibold">{t("session.reviewer.title")}</h4>
                <Skeleton className="h-16 w-full" />
            </section>
        );

    // Optimistic: the picker moves now and goes back if the save is refused.
    const save = async (cli: string | null, nextModel: string | null) => {
        const before = view;
        const optimistic = { ...view, cli, model: cli ? nextModel : null };
        setView(optimistic);
        setError(null);
        const result = await runAction(
            () => setSessionReviewerAction({ sessionId: session.id, cli, model: nextModel }),
            setError
        );
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setView(before);
            setModel(before.model ?? "");
            return;
        }
        cache.set(session.id, optimistic);
    };
    const reviewNow = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(() => requestSessionReviewAction(session.id), setError);
        if (result?.error) setError(result.error);
        await load();
        setBusy(false);
    };

    const latest = view.reviews[0];
    const modelChanged = (model.trim() || null) !== (view.model ?? null);
    const disabledReason = view.canEdit ? undefined : t("session.reviewer.ownerOnly");

    return (
        <section className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("session.reviewer.title")}</h4>
                {view.cli && session.pullRequest ? (
                    <Button size="sm" variant="secondary" onClick={() => void reviewNow()} disabled={busy || running}>
                        {busy || running ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : (
                            <RefreshCw className="size-4 shrink-0" />
                        )}
                        {running ? t("session.reviewer.running") : t("session.reviewer.again")}
                    </Button>
                ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t("session.reviewer.hint")}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2" title={disabledReason}>
                <div className="min-w-0 flex-1 basis-40">
                    <Select
                        aria-label={t("session.reviewer.tool")}
                        value={view.cli ?? OFF}
                        disabled={!view.canEdit}
                        onValueChange={(next) => void save(next === OFF ? null : next, model.trim() || null)}
                        options={[
                            { value: OFF, label: t("session.reviewer.off") },
                            ...view.options.map((option) => ({ value: option.id, label: option.label }))
                        ]}
                    />
                </div>
                {view.cli ? (
                    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
                        <Input
                            aria-label={t("session.reviewer.model")}
                            placeholder={t("session.reviewer.modelPlaceholder")}
                            value={model}
                            maxLength={200}
                            disabled={!view.canEdit}
                            onChange={(event) => setModel(event.target.value)}
                        />
                        {modelChanged ? (
                            <Button size="sm" onClick={() => void save(view.cli, model.trim() || null)}>
                                {t("session.reviewer.save")}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {view.cli && !latest ? (
                <p className="text-xs text-muted-foreground">{t("session.reviewer.none")}</p>
            ) : null}
            {view.reviews.length > 0 ? (
                <ul className="flex min-w-0 flex-col gap-2">
                    {view.reviews.map((review, index) => (
                        <li key={review.id} className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
                            <details open={index === 0} className="min-w-0">
                                <summary className="flex min-w-0 cursor-pointer flex-wrap items-center gap-2 text-sm">
                                    <ScanSearch className="size-4 shrink-0 text-muted-foreground" />
                                    <Badge variant={badgeOf(review.state, review.verdict)}>
                                        {t(`session.reviewer.states.${stateKey(review.state, review.verdict)}`)}
                                    </Badge>
                                    <code className="shrink-0 text-xs" title={review.headSha}>
                                        {review.headSha.slice(0, 7)}
                                    </code>
                                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                                        {format.dateTime(review.startedAt)}
                                    </span>
                                </summary>
                                <div className="mt-2 flex min-w-0 flex-col gap-2">
                                    {review.error ? (
                                        <p className="text-xs text-destructive">
                                            {t(`session.reviewer.errors.${errorKey(review.error)}`)}
                                        </p>
                                    ) : null}
                                    {review.summary ? (
                                        <p className="whitespace-pre-wrap break-words text-sm">{review.summary}</p>
                                    ) : null}
                                    {review.findings.length > 0 ? (
                                        <ul className="flex min-w-0 flex-col gap-1">
                                            {review.findings.map((finding, at) => (
                                                <li key={at} className="min-w-0 text-sm">
                                                    <code
                                                        className="block truncate text-xs"
                                                        title={finding.line ? `${finding.path}:${finding.line}` : finding.path}
                                                    >
                                                        {finding.line ? `${finding.path}:${finding.line}` : finding.path}
                                                    </code>
                                                    <p className="whitespace-pre-wrap break-words">{finding.body}</p>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : null}
                                    {review.fedBack ? (
                                        <p className="text-xs text-muted-foreground">{t("session.reviewer.fedBack")}</p>
                                    ) : null}
                                </div>
                            </details>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

function stateKey(state: string, verdict: string | null) {
    if (state === "complete") return verdict === "changes_requested" ? "changesRequested" : "approved";
    return (["running", "failed", "cancelled"] as const).find((one) => one === state) ?? "failed";
}

function badgeOf(state: string, verdict: string | null): "success" | "warning" | "neutral" | "danger" {
    if (state === "running") return "neutral";
    if (state === "complete") return verdict === "changes_requested" ? "warning" : "success";
    return "danger";
}

function errorKey(error: string) {
    return (["start_failed", "timed_out", "container_gone", "no_result"] as const).find((one) => one === error) ?? "no_result";
}
