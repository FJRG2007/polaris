"use client";

/**
 * The turns of a Code session that can be undone: the checkout as it was before
 * each prompt, newest first, with undo and redo.
 *
 * Undo puts the files back to before the newest turn, or before the one picked
 * in the list; redo walks forward again. Both overwrite what is in the checkout
 * now, so both ask first. Turns after the undo point stay listed, dimmed, until
 * the next prompt keeps the undo.
 */

import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { useConfirm } from "@/components/confirm-dialog";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Skeleton, cn } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import type { SessionView } from "@/lib/agents/session-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { sessionTurnsAction, stepSessionTurnAction } from "./actions";
import { History, Loader2, Redo2, RefreshCw, Undo2 } from "lucide-react";
import type { StepAnswer, TurnsAnswer } from "@/lib/agents/session-snapshot-service";

/** The last listing per session, shown at once on a return to the pane. */
const lastListing = new Map<string, TurnsAnswer>();

export function SessionTurns({
    session,
    onStepped
}: {
    session: Pick<SessionView, "id" | "state">;
    /** Called after the files moved, so the changes beside it read again. */
    onStepped?: () => void;
}) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [answer, setAnswer] = useState<TurnsAnswer | null>(() => lastListing.get(session.id) ?? null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const over = core.isSessionOver(session.state);

    const load = useCallback(async () => {
        setLoading(true);
        const result = await runAction(() => sessionTurnsAction(session.id), setProblem);
        setLoading(false);
        if (!result) return;
        if (result.error || !result.answer) return setProblem(result.error ?? t("session.turns.unreachable"));
        lastListing.set(session.id, result.answer);
        setAnswer(result.answer);
    }, [session.id, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const wordsForStep = (step: StepAnswer): string | null => {
        if (step.kind === "unreachable") return t("session.turns.unreachable");
        if (step.kind === "unavailable") return t(`session.turns.unavailable.${step.reason}`);
        switch (step.result.kind) {
            case "undone":
            case "restored":
                return null;
            case "empty":
                return t("session.turns.nothing");
            case "stale":
                return t("session.turns.stale");
            case "nocheckout":
                return t("session.turns.unavailable.ended");
            default:
                return t("session.turns.failed");
        }
    };

    const step = async (direction: "undo" | "redo", to?: { id: string; label: string }) => {
        const ok = await confirm({
            title: direction === "undo" ? t("session.turns.undoTitle") : t("session.turns.redoTitle"),
            description:
                direction === "undo"
                    ? to?.label
                        ? t("session.turns.undoToDescription", { label: to.label })
                        : t("session.turns.undoDescription")
                    : t("session.turns.redoDescription"),
            confirmLabel: direction === "undo" ? t("session.turns.undo") : t("session.turns.redo"),
            danger: direction === "undo"
        });
        if (!ok) return;
        setBusy(true);
        const result = await runAction(
            () => stepSessionTurnAction({ sessionId: session.id, direction, to: to?.id }),
            setProblem
        );
        setBusy(false);
        if (!result) return;
        if (result.error || !result.answer) return setProblem(result.error ?? t("session.turns.unreachable"));
        setProblem(wordsForStep(result.answer));
        onStepped?.();
        await load();
    };

    const listing = answer?.kind === "listing" ? answer.listing : null;
    const turns = listing?.turns ?? [];
    const undoneIndex = listing?.undone ? turns.findIndex((turn) => turn.id === listing.undone) : -1;
    const canUndo = !over && turns.length > 0 && undoneIndex !== turns.length - 1;
    const canRedo = !over && Boolean(listing?.undone);

    return (
        <section className="flex flex-col gap-2 border-b border-border p-3" aria-labelledby={`turns-${session.id}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <History className="size-4 shrink-0 text-muted-foreground" />
                <h3 id={`turns-${session.id}`} className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t("session.turns.title")}
                </h3>
                <div className="flex shrink-0 items-center gap-1">
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!canUndo || busy}
                        title={over ? t("session.turns.unavailable.over") : undefined}
                        onClick={() => void step("undo")}
                    >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
                        {t("session.turns.undo")}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!canRedo || busy}
                        title={over ? t("session.turns.unavailable.over") : undefined}
                        onClick={() => void step("redo")}
                    >
                        <Redo2 className="size-4" />
                        {t("session.turns.redo")}
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("session.turns.refresh")}
                        title={t("session.turns.refresh")}
                        disabled={loading}
                        onClick={() => void load()}
                    >
                        <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                    </Button>
                </div>
            </div>
            {problem ? (
                <p role="alert" className="text-sm text-destructive">
                    {problem}
                </p>
            ) : null}
            {!answer ? (
                <Skeleton className="h-16 w-full" />
            ) : answer.kind === "unavailable" ? (
                <p className="text-sm text-muted-foreground">{t(`session.turns.unavailable.${answer.reason}`)}</p>
            ) : answer.kind === "unreachable" ? (
                <p className="text-sm text-muted-foreground">{t("session.turns.unreachable")}</p>
            ) : turns.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("session.turns.empty")}</p>
            ) : (
                <ol className="flex max-h-56 flex-col gap-1 overflow-y-auto overscroll-contain">
                    {turns.map((turn, index) => {
                        const undone = undoneIndex >= 0 && index <= undoneIndex;
                        return (
                            <li
                                key={turn.id}
                                className={cn("flex min-w-0 items-center gap-2 rounded-md px-2 py-1", undone && "opacity-60")}
                            >
                                <div className="min-w-0 flex-1">
                                    <p
                                        className={cn("truncate text-sm", undone && "line-through")}
                                        title={turn.label || t("session.turns.unnamed")}
                                    >
                                        {turn.label || t("session.turns.unnamed")}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">{format.dateTime(turn.at)}</p>
                                </div>
                                {undone ? <Badge variant="neutral">{t("session.turns.undone")}</Badge> : null}
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="shrink-0"
                                    disabled={over || busy || undone}
                                    aria-label={t("session.turns.undoTo")}
                                    title={t("session.turns.undoTo")}
                                    onClick={() => void step("undo", turn)}
                                >
                                    <Undo2 className="size-4" />
                                </Button>
                            </li>
                        );
                    })}
                </ol>
            )}
            {confirmElement}
        </section>
    );
}
