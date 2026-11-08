"use client";

/**
 * The session's pull request once it is open: how its checks stand, the
 * failing ones handed to the agent in one press, and the merge.
 *
 * Read from GitHub on open and again every half minute while anything is still
 * running, never stored: a check that finished there is never shown as running
 * here for longer than that.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { SessionView } from "@/lib/agents/session-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useState, useTransition } from "react";
import { CheckCircle2, CircleDot, GitMerge, Loader2, Send, XCircle } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Select
} from "@polaris/ui";
import {
    mergeSessionPullAction,
    sendFailingChecksAction,
    sessionChecksAction,
    type SessionChecksView
} from "../actions";

const REFRESH_MS = 30_000;
type MergeMethod = "squash" | "merge" | "rebase";

export function SessionPull({ session }: { session: SessionView }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [view, setView] = useState<SessionChecksView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [merging, setMerging] = useState(false);
    const [method, setMethod] = useState<MergeMethod>("squash");
    const [busy, startTransition] = useTransition();
    const number = session.pullRequest?.number ?? null;

    const load = useCallback(async () => {
        const result = await runAction(() => sessionChecksAction(session.id), setError);
        if (!result) return;
        if (result.error) setError(result.error);
        else setError(null);
        if (result.view !== undefined) setView(result.view);
    }, [session.id]);

    useEffect(() => {
        if (number === null) return;
        void load();
    }, [load, number]);

    const pending = view?.tally.pending ?? 0;
    useEffect(() => {
        if (number === null || pending === 0) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [load, number, pending]);

    if (number === null || !view || view.pullState !== "open") {
        return error && number !== null ? <span className="text-xs text-danger">{error}</span> : null;
    }

    const { passed, failed } = view.tally;
    const summary =
        view.checks.length === 0
            ? t("session.checks.none")
            : t("session.checks.tally", { passed, failed, pending });
    const Icon = failed > 0 ? XCircle : pending > 0 ? CircleDot : CheckCircle2;
    const tone = failed > 0 ? "text-danger" : pending > 0 ? "text-warning" : "text-success";

    const sendFailing = () =>
        startTransition(async () => {
            setNote(null);
            const result = await runAction(() => sendFailingChecksAction(session.id), setError);
            if (result?.error) setError(result.error);
            else if (result) setNote(t("session.checks.sent"));
        });

    const merge = () =>
        startTransition(async () => {
            const result = await runAction(
                () => mergeSessionPullAction({ sessionId: session.id, method }),
                setError
            );
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            setMerging(false);
            setNote(t("session.merge.done", { number }));
            await load();
            router.refresh();
        });

    return (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Popover>
                <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" title={summary}>
                        <Icon className={`size-4 shrink-0 ${tone}`} />
                        <span className="max-w-48 truncate">{summary}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-2">
                    {view.checks.length === 0 ? (
                        <p className="p-2 text-sm text-muted-foreground">{t("session.checks.none")}</p>
                    ) : (
                        <ul className="max-h-72 space-y-0.5 overflow-y-auto overscroll-contain">
                            {view.checks.map((check, index) => (
                                <li
                                    key={`${check.name}-${index}`}
                                    className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-sm"
                                >
                                    {check.state === "failed" ? (
                                        <XCircle className="size-4 shrink-0 text-danger" />
                                    ) : check.state === "pending" ? (
                                        <CircleDot className="size-4 shrink-0 text-warning" />
                                    ) : (
                                        <CheckCircle2 className="size-4 shrink-0 text-success" />
                                    )}
                                    {check.url ? (
                                        <a
                                            href={check.url}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                            className="min-w-0 flex-1 truncate hover:underline"
                                            title={check.name}
                                        >
                                            {check.name}
                                        </a>
                                    ) : (
                                        <span className="min-w-0 flex-1 truncate" title={check.name}>
                                            {check.name}
                                        </span>
                                    )}
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {t(`session.checks.states.${check.state}`)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </PopoverContent>
            </Popover>
            {failed > 0 && !core.isSessionOver(session.state) ? (
                <Button size="sm" variant="secondary" onClick={sendFailing} disabled={busy}>
                    {busy && !merging ? (
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                        <Send className="size-4 shrink-0" />
                    )}
                    {t("session.checks.sendFailing")}
                </Button>
            ) : null}
            <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                    setError(null);
                    setMerging(true);
                }}
                disabled={!view.canMerge}
                title={view.canMerge ? undefined : t("session.ship.refusals.readOnly")}
            >
                <GitMerge className="size-4 shrink-0" />
                {t("session.merge.open")}
            </Button>
            {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
            {error && !merging ? <span className="text-xs text-danger">{error}</span> : null}
            {merging ? (
                <Dialog open onOpenChange={(open) => !open && !busy && setMerging(false)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("session.merge.title", { number })}</DialogTitle>
                            <DialogDescription>
                                {view.mergeableState === "blocked"
                                    ? t("session.merge.blocked")
                                    : failed > 0 || pending > 0
                                      ? t("session.merge.checksNotGreen")
                                      : t("session.merge.description")}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-1">
                            <label className="text-sm font-medium">{t("session.merge.method")}</label>
                            <Select
                                value={method}
                                onValueChange={(next) => setMethod(next as MergeMethod)}
                                options={(["squash", "merge", "rebase"] as const).map((value) => ({
                                    value,
                                    label: t(`session.merge.methods.${value}`)
                                }))}
                            />
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <DialogFooter>
                            <Button variant="ghost" onClick={() => setMerging(false)} disabled={busy}>
                                {tcommon("actions.cancel")}
                            </Button>
                            <Button onClick={merge} disabled={busy}>
                                {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                {busy ? t("session.merge.merging") : t("session.merge.submit")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
        </span>
    );
}
