"use client";

/**
 * One run: the graph it ran, each node ringed by what it did, and the steps in
 * order with their input, output, status and timing. "Run again" starts a new
 * run with the same trigger data on the version it ran or the live one.
 */

import Link from "next/link";
import { took } from "../runs-view";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import * as polls from "../../automations-polls";
import { nodeLabel } from "@/app/(app)/automations/[id]/canvas-editor";
import { ArrowLeft, ChevronDown, FlaskConical, RotateCcw, X } from "lucide-react";
import type { RunDetail, StepView } from "@/lib/automations/history";
import { cancelRunAction, pinRunDataAction, rerunAction } from "@/app/(app)/automations/actions";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    CanvasBoard,
    NO_SELECTION,
    stepKey,
    type CanvasSelection
} from "@/app/(app)/automations/[id]/canvas-board";
import {
    LoadFailed,
    RowsSkeleton,
    StatusChip,
    dropCache,
    passOf,
    portLabel,
    useCachedAction,
    useRunError,
    when
} from "@/app/(app)/automations/shared";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    PageHeader,
    Skeleton,
    cn,
    useToast
} from "@polaris/ui";

export function RunDetailView({ runId }: { runId: string }) {
    const t = useTranslations("automations");
    const { data, error, refresh } = useCachedAction(`polaris.automations.run.${runId}`, () =>
        polls.run(runId)
    );
    const run = data?.run;

    // A run still going is refetched until it ends.
    useEffect(() => {
        if (!run || core.runFinished(run.status)) return;
        const timer = setTimeout(() => void refresh(), 2000);
        return () => clearTimeout(timer);
    }, [run, refresh]);

    return (
        <div className="space-y-4">
            <Link
                href="/automations/runs"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {t("runView.back")}
            </Link>
            {error !== null && !run ? (
                <LoadFailed
                    message={error || t("runView.notFound")}
                    onRetry={() => void refresh()}
                />
            ) : !run ? (
                <>
                    <Skeleton className="h-7 w-64" />
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
                        <Skeleton className="h-[28rem] w-full" />
                        <RowsSkeleton rows={5} />
                    </div>
                </>
            ) : (
                <Loaded run={run} onChanged={() => void refresh()} />
            )}
        </div>
    );
}

function Loaded({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const router = useRouter();
    const words = useRunError();
    const [selection, setSelection] = useState<CanvasSelection>(NO_SELECTION);
    const graph = useMemo(() => (run.graph ? core.layoutGraph(run.graph) : null), [run.graph]);
    const states = useMemo(() => {
        const out: Record<string, string> = {};
        // A node a loop ran many times shows its latest pass, unless one of them failed.
        const sticks = new Set(["failed", "refused", "timedOut", "interrupted"]);
        for (const step of run.steps)
            if (!sticks.has(out[step.nodeId] ?? "")) out[step.nodeId] = step.status;
        return out;
    }, [run.steps]);
    const byId = useMemo(
        () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
        [graph]
    );
    const picked = selection.nodes.size === 1 ? [...selection.nodes][0] : null;
    const steps = picked ? run.steps.filter((step) => step.nodeId === picked) : run.steps;

    const again = async (which: "same" | "published") => {
        const answer = await rerunAction({ runId: run.id, which });
        if (!answer.ok) return void toast.show({ title: answer.error });
        toast.show({ title: t("runView.rerunStarted") });
        router.push(`/automations/runs/${answer.runId}`);
    };

    const [opening, setOpening] = useState(false);
    const openWithData = async () => {
        setOpening(true);
        const answer = await pinRunDataAction(run.id).catch(() => null);
        if (!answer?.ok) {
            setOpening(false);
            return void toast.show({ title: answer?.error ?? t("errors.generic") });
        }
        dropCache(`polaris.automations.one.${answer.automationId}`);
        toast.show({ title: t("runView.dataPinned") });
        router.push(`/automations/${answer.automationId}`);
    };

    return (
        <>
            <PageHeader
                title={run.automationName}
                description={[
                    when(run.startedAt ?? run.queuedAt, locale),
                    run.finishedAt
                        ? t("runView.took", {
                              time: took(run.startedAt ?? run.queuedAt, run.finishedAt)
                          })
                        : null,
                    run.test
                        ? t("runView.testVersion")
                        : run.versionNumber
                          ? t("runView.version", { number: run.versionNumber })
                          : null
                ]
                    .filter(Boolean)
                    .join(" - ")}
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {run.test ? <Badge variant="neutral">{t("runView.test")}</Badge> : null}
                        <StatusChip status={run.status} />
                        <Button variant="outline" size="sm" asChild>
                            <Link href={`/automations/${run.automationId}`}>
                                {t("runView.openAutomation")}
                            </Link>
                        </Button>
                        {run.canSeeData ? (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={opening}
                                title={t("runView.openWithDataHint")}
                                onClick={() => void openWithData()}
                            >
                                <FlaskConical aria-hidden="true" />
                                {t("runView.openWithData")}
                            </Button>
                        ) : null}
                        {run.canRerun ? (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button size="sm">
                                        <RotateCcw aria-hidden="true" />
                                        {t("runView.runAgain")}
                                        <ChevronDown aria-hidden="true" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => void again("same")}>
                                        {t("runView.rerunSame")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void again("published")}>
                                        {t("runView.rerunLive")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : null}
                        {run.canCancel ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                    const answer = await cancelRunAction(run.id);
                                    toast.show({
                                        title: answer.ok ? t("runs.cancelled") : answer.error
                                    });
                                    if (answer.ok) onChanged();
                                }}
                            >
                                <X aria-hidden="true" />
                                {t("runs.cancel")}
                            </Button>
                        ) : null}
                    </div>
                }
            />
            {run.error ? <p className="text-sm text-danger">{words(run.error)}</p> : null}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
                <div className="h-[60vh] min-h-[22rem] min-w-0">
                    {graph ? (
                        <CanvasBoard
                            graph={graph}
                            readOnly
                            selection={selection}
                            onSelect={setSelection}
                            onChange={() => undefined}
                            onOpen={(id) =>
                                setSelection({ nodes: new Set([id]), notes: new Set(), edge: null })
                            }
                            onPalette={() => undefined}
                            onAddNote={() => undefined}
                            onRefused={() => undefined}
                            title={(node) => nodeLabel(t, node)}
                            subtitle={() => null}
                            incomplete={() => false}
                            states={states}
                        />
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            {t("runErrors.graphUnreadable")}
                        </p>
                    )}
                </div>
                <section className="min-w-0 space-y-2" aria-label={t("runView.steps")}>
                    <h2 className="text-sm font-semibold">{t("runView.steps")}</h2>
                    {!run.canSeeData ? (
                        <p className="text-xs text-muted-foreground">{t("runView.hiddenData")}</p>
                    ) : null}
                    <ol className="space-y-2">
                        {steps.map((step) => (
                            <StepItem
                                key={step.id}
                                step={step}
                                label={nodeLabel(t, byId.get(step.nodeId))}
                                node={byId.get(step.nodeId)}
                                finallyLane={
                                    step.iteration.split("/")[0] === core.FINALLY_ITERATION
                                }
                                pass={passOf(step.iteration)}
                                showData={run.canSeeData}
                            />
                        ))}
                    </ol>
                </section>
            </div>
        </>
    );
}

/** The outputs a step left by, in the reader's words, when it is not the plain "next". */
function wentBy(
    t: ReturnType<typeof useTranslations<"automations">>,
    node: core.GraphNode | undefined,
    port: string | null
): string | null {
    if (!node || !port || port === "next") return null;
    return port
        .split(",")
        .map((one) => portLabel(t, node, one))
        .join(", ");
}

function StepItem({
    step,
    label,
    node,
    finallyLane,
    pass,
    showData
}: {
    step: StepView;
    label: string;
    node: core.GraphNode | undefined;
    finallyLane: boolean;
    pass: string | null;
    showData: boolean;
}) {
    const t = useTranslations("automations");
    const words = useRunError();
    const [open, setOpen] = useState(step.status === "failed");
    const failed = ["failed", "refused", "timedOut", "interrupted"].includes(step.status);
    const went = wentBy(t, node, step.port);
    return (
        <li
            className={cn(
                "rounded-lg border bg-card",
                failed ? "border-danger-edge" : "border-border"
            )}
        >
            <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 p-3 text-left"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={label}>
                        {label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                        {finallyLane ? `${t("editor.always")} - ` : ""}
                        {step.finishedAt ? took(step.startedAt, step.finishedAt) : ""}
                        {step.error ? ` - ${words(step.error)}` : ""}
                        {pass !== null ? ` - ${t("runView.pass", { number: pass })}` : ""}
                        {step.attempt > 1
                            ? ` - ${t("runView.attempt", { number: step.attempt })}`
                            : ""}
                        {went ? ` - ${t("runView.went", { port: went })}` : ""}
                        {node?.type === "core.try" &&
                        (step.output as { recovered?: unknown } | null)?.recovered === true
                            ? ` - ${t("runView.recovered")}`
                            : ""}
                    </p>
                </div>
                <Badge
                    variant={
                        failed
                            ? "danger"
                            : step.status === "ok"
                              ? "success"
                              : step.status === "retried"
                                ? "warning"
                                : "neutral"
                    }
                >
                    {t(`stepStatus.${stepKey(step.status)}`)}
                </Badge>
                <ChevronDown
                    className={cn("size-4 transition-transform", open && "rotate-180")}
                    aria-hidden="true"
                />
            </button>
            {open ? (
                <div className="space-y-2 border-t border-border p-3">
                    {showData ? (
                        <>
                            <DataBlock title={t("runView.input")} value={step.input} />
                            <DataBlock title={t("runView.output")} value={step.output} />
                        </>
                    ) : (
                        <p className="text-xs text-muted-foreground">{t("runView.hiddenData")}</p>
                    )}
                </div>
            ) : null}
        </li>
    );
}

function DataBlock({ title, value }: { title: string; value: unknown }) {
    const t = useTranslations("automations");
    return (
        <div className="min-w-0 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                {title}
            </p>
            {value === null || value === undefined ? (
                <p className="text-xs text-muted-foreground">{t("runView.noData")}</p>
            ) : (
                <pre className="max-h-64 overflow-auto overscroll-contain rounded-md bg-field p-2 font-mono text-xs">
                    {JSON.stringify(value, null, 2)}
                </pre>
            )}
        </div>
    );
}
