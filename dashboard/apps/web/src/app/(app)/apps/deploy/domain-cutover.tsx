"use client";

/**
 * Moving one of a service's domains to another service of the project, as a guided
 * dialog: choose the service, let Polaris check it, switch, and watch the public
 * resolvers catch up while the old service keeps answering - with a rollback at
 * every step until it is done.
 */

import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import * as polls from "./deploy-polls";
import { useUnmountSignal } from "@/lib/poll-fetch";
import type { CutoverFailure, CutoverPhase, CutoverView } from "@/lib/deploy/dns-cutover";
import {
    ArrowRightLeft,
    CheckCircle2,
    Circle,
    Loader2,
    RotateCcw,
    TriangleAlert,
    XCircle
} from "lucide-react";
import {
    rollbackCutoverAction,
    startCutoverAction,
    switchCutoverAction,
    type CutoverPanel,
    type CutoverReply
} from "./dns-cutover-actions";
import {
    Badge,
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DnsRecordTable,
    Select,
    Skeleton
} from "@polaris/ui";

/** How often an open dialog asks again while something is being waited on. */
const POLL_MS = 10_000;
/** The TTL a record is lowered to, the same as the server's. */
const LOWERED_TTL = 60;

/** The last panel seen per domain this visit, drawn at once while it is asked again. */
const lastSeen = new Map<string, CutoverPanel>();

const WAITING: readonly CutoverPhase[] = ["lowering", "propagating", "finishing"];

type CutoverT = NamespaceTranslator<"deployService">;

const PHASE_KEYS = {
    checking: "cutover.phase.checking",
    "preflight-failed": "cutover.phase.preflightFailed",
    lowering: "cutover.phase.lowering",
    ready: "cutover.phase.ready",
    propagating: "cutover.phase.propagating",
    finishing: "cutover.phase.finishing",
    done: "cutover.phase.done",
    failed: "cutover.phase.failed",
    "rolled-back": "cutover.phase.rolledBack"
} as const satisfies Record<CutoverPhase, string>;

const FAILURE_KEYS = {
    "same-service": "cutover.failure.sameService",
    "target-not-deployed": "cutover.failure.notDeployed",
    "target-not-running": "cutover.failure.notRunning",
    "target-not-routed": "cutover.failure.notRouted",
    "target-down": "cutover.failure.down",
    "no-address": "cutover.failure.noAddress",
    "record-write-failed": "cutover.failure.recordWrite",
    "route-move-failed": "cutover.failure.routeMove",
    "rollback-write-failed": "cutover.failure.rollbackWrite",
    "rollback-route-failed": "cutover.failure.rollbackRoute",
    "propagation-timeout": "cutover.failure.timeout"
} as const satisfies Record<CutoverFailure, string>;

function phaseVariant(phase: CutoverPhase): "success" | "danger" | "warning" | "neutral" {
    if (phase === "done") return "success";
    if (phase === "failed" || phase === "preflight-failed") return "danger";
    if (phase === "rolled-back") return "neutral";
    return "warning";
}

function clock(iso: string | null): string {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function DomainCutoverButton({
    domainId,
    hostname,
    canManage,
    onChanged
}: {
    domainId: string;
    hostname: string;
    canManage: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const [open, setOpen] = useState(false);
    const [panel, setPanel] = useState<CutoverPanel | null>(lastSeen.get(domainId) ?? null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [pending, startTransition] = useTransition();
    const changed = useRef(false);
    const asking = useRef(false);

    const take = useCallback(
        (result: CutoverReply) => {
            if (result.panel) {
                lastSeen.set(domainId, result.panel);
                setPanel(result.panel);
            }
            setError(result.error ?? null);
        },
        [domainId]
    );

    const signal = useUnmountSignal();
    const refresh = useCallback(async () => {
        if (asking.current) return;
        asking.current = true;
        try {
            take(await polls.cutoverPanel(domainId, signal()));
        } finally {
            asking.current = false;
            setLoading(false);
        }
    }, [domainId, take]);

    function show(next: boolean) {
        if (next) {
            setError(null);
            setLoading(true);
            void refresh();
        } else if (changed.current) {
            changed.current = false;
            onChanged();
        }
        setOpen(next);
    }

    const phase = panel?.cutover?.phase ?? null;
    useEffect(() => {
        if (!open || !phase || !WAITING.includes(phase)) return;
        const timer = setInterval(() => void refresh(), POLL_MS);
        return () => clearInterval(timer);
    }, [open, phase, refresh]);

    function run(action: () => Promise<CutoverReply>) {
        setError(null);
        startTransition(async () => {
            changed.current = true;
            take(await action());
        });
    }

    const label = t("cutover.open");
    return (
        <>
            <button
                type="button"
                aria-label={t("cutover.openNamed", { hostname })}
                title={canManage ? label : `${label}. ${t("cutover.noManage")}`}
                disabled={!canManage}
                onClick={() => show(true)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
                <ArrowRightLeft className="size-3.5" />
            </button>
            <Dialog open={open} onOpenChange={show}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle className="break-words">
                            {t("cutover.title", { hostname })}
                        </DialogTitle>
                        <DialogDescription>{t("cutover.description")}</DialogDescription>
                    </DialogHeader>
                    <div className="flex min-w-0 flex-col gap-4">
                        {panel ? (
                            <CutoverBody
                                t={t}
                                panel={panel}
                                hostname={hostname}
                                pending={pending}
                                onStart={(targetApplicationId) =>
                                    run(() => startCutoverAction({ domainId, targetApplicationId }))
                                }
                                onSwitch={() => run(() => switchCutoverAction(domainId))}
                                onRollback={() => run(() => rollbackCutoverAction(domainId))}
                                onCheck={() => startTransition(refresh)}
                            />
                        ) : loading ? (
                            <div className="flex flex-col gap-2" aria-busy="true">
                                <Skeleton className="h-4 w-2/3" />
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-9 w-32" />
                            </div>
                        ) : null}
                        {error ? (
                            <div
                                className="flex min-w-0 items-start gap-2 text-sm text-danger"
                                role="alert"
                            >
                                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                                <span className="min-w-0 break-words">{error}</span>
                                {!panel ? (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        className="ml-auto"
                                        onClick={() => show(true)}
                                    >
                                        {t("cutover.retry")}
                                    </Button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

function CutoverBody({
    t,
    panel,
    hostname,
    pending,
    onStart,
    onSwitch,
    onRollback,
    onCheck
}: {
    t: CutoverT;
    panel: CutoverPanel;
    hostname: string;
    pending: boolean;
    onStart: (targetApplicationId: string) => void;
    onSwitch: () => void;
    onRollback: () => void;
    onCheck: () => void;
}) {
    const cutover = panel.cutover;
    const closed =
        !cutover ||
        cutover.phase === "done" ||
        cutover.phase === "rolled-back" ||
        cutover.phase === "preflight-failed";
    return (
        <>
            {cutover ? (
                <CutoverState
                    t={t}
                    cutover={cutover}
                    hostname={hostname}
                    pending={pending}
                    onSwitch={onSwitch}
                    onRollback={onRollback}
                    onCheck={onCheck}
                />
            ) : null}
            {closed ? (
                <StartForm
                    t={t}
                    targets={panel.targets}
                    pending={pending}
                    again={cutover !== null}
                    preselect={
                        cutover?.phase === "preflight-failed"
                            ? cutover.targetApplicationId
                            : undefined
                    }
                    onStart={onStart}
                />
            ) : null}
        </>
    );
}

function StartForm({
    t,
    targets,
    pending,
    again,
    preselect,
    onStart
}: {
    t: CutoverT;
    targets: CutoverPanel["targets"];
    pending: boolean;
    again: boolean;
    preselect: string | undefined;
    onStart: (targetApplicationId: string) => void;
}) {
    const [target, setTarget] = useState(preselect ?? "");
    if (targets.length === 0) {
        return <p className="text-sm text-muted-foreground">{t("cutover.noTargets")}</p>;
    }
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium">
                {again ? t("cutover.moveAgain") : t("cutover.target")}
            </span>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <div className="min-w-0 flex-1">
                    <Select
                        value={target}
                        onValueChange={setTarget}
                        placeholder={t("cutover.targetPlaceholder")}
                        options={targets.map((entry) => ({
                            value: entry.id,
                            label: `${entry.name} (${entry.environment})`
                        }))}
                        aria-label={t("cutover.target")}
                    />
                </div>
                <Button
                    disabled={pending || !target}
                    aria-disabled={pending || !target}
                    onClick={() => onStart(target)}
                >
                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                    {pending ? t("cutover.starting") : t("cutover.start")}
                </Button>
            </div>
        </div>
    );
}

function CheckLine({
    ok,
    warn,
    children
}: {
    ok: boolean;
    warn?: boolean;
    children: React.ReactNode;
}) {
    return (
        <li className="flex min-w-0 items-start gap-2 text-sm">
            {ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            ) : warn ? (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
            )}
            <span className="min-w-0 break-words">{children}</span>
        </li>
    );
}

function Preflight({
    t,
    cutover,
    hostname
}: {
    t: CutoverT;
    cutover: CutoverView;
    hostname: string;
}) {
    const checks = cutover.preflight;
    if (!checks) return null;
    const answers = checks.answers;
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
                {t("cutover.checks.title")}
            </span>
            <ul className="flex min-w-0 flex-col gap-1">
                <CheckLine ok={checks.deployed}>
                    {t("cutover.checks.deployed", { target: cutover.targetName })}
                </CheckLine>
                {checks.deployed ? (
                    <CheckLine ok={checks.running}>
                        {t("cutover.checks.running", { target: cutover.targetName })}
                    </CheckLine>
                ) : null}
                {cutover.mode !== "edge" ? (
                    <CheckLine ok={checks.newValue !== null}>
                        {checks.newValue
                            ? t("cutover.checks.address", { address: checks.newValue })
                            : t("cutover.checks.noAddress")}
                    </CheckLine>
                ) : null}
                {answers === "skipped" ? (
                    <CheckLine ok>{t("cutover.checks.sameEdge")}</CheckLine>
                ) : (
                    <CheckLine ok={answers === "up"} warn={answers === "unknown"}>
                        {answers === "up"
                            ? t("cutover.checks.answers", { hostname, code: checks.code ?? 0 })
                            : answers === "unknown"
                              ? t("cutover.checks.noAnswer")
                              : answers === "not-routed"
                                ? t("cutover.checks.notRouted", { hostname })
                                : t("cutover.checks.answersBadly", {
                                      hostname,
                                      code: checks.code ?? 0
                                  })}
                    </CheckLine>
                )}
                {cutover.mode !== "edge" ? (
                    <CheckLine ok={checks.tls === "ready"} warn={checks.tls !== "ready"}>
                        {checks.tls === "ready"
                            ? t("cutover.checks.tlsReady")
                            : t("cutover.checks.tlsOnSwitch")}
                    </CheckLine>
                ) : null}
            </ul>
        </div>
    );
}

function RecordToSet({ hostname, values }: { hostname: string; values: readonly string[] }) {
    return (
        <DnsRecordTable
            records={values.map((value) => ({
                type: "A",
                name: hostname,
                value,
                status: "waiting" as const
            }))}
        />
    );
}

function Propagation({
    t,
    cutover,
    hostname,
    pending,
    onCheck
}: {
    t: CutoverT;
    cutover: CutoverView;
    hostname: string;
    pending: boolean;
    onCheck: () => void;
}) {
    const asked = cutover.resolvers.filter((resolver) => resolver.status !== "unreachable");
    const agreeing = asked.filter((resolver) => resolver.agrees === true).length;
    const share = asked.length === 0 ? 0 : Math.round((agreeing / asked.length) * 100);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {cutover.mode !== "edge" ? (
                <>
                    <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
                        <span className="min-w-0">
                            {t("cutover.progress", { agree: agreeing, total: asked.length })}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                            {share}%
                        </span>
                    </div>
                    <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={share}
                        aria-label={t("cutover.progressLabel")}
                    >
                        <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${share}%` }}
                        />
                    </div>
                    {cutover.resolvers.length > 0 ? (
                        <ul className="flex min-w-0 flex-col gap-1">
                            {cutover.resolvers.map((resolver) => (
                                <li
                                    key={resolver.label}
                                    className="flex min-w-0 items-center gap-2 text-xs"
                                >
                                    {resolver.agrees === true ? (
                                        <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                                    ) : (
                                        <Circle className="size-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <span className="w-24 shrink-0 truncate" title={resolver.label}>
                                        {resolver.label}
                                    </span>
                                    <span
                                        className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                                        title={resolver.values.join(", ")}
                                    >
                                        {resolver.status === "unreachable"
                                            ? t("cutover.resolverUnreachable")
                                            : resolver.values.length === 0
                                              ? t("cutover.resolverEmpty")
                                              : resolver.values.join(", ")}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </>
            ) : null}
            {cutover.targetStatus ? (
                <CheckLine
                    ok={cutover.targetStatus.status === "up"}
                    warn={cutover.targetStatus.status !== "up"}
                >
                    {cutover.targetStatus.status === "up"
                        ? t("cutover.targetUp", { target: cutover.targetName, hostname })
                        : t("cutover.targetWaiting", { target: cutover.targetName })}
                </CheckLine>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {cutover.checkedAt ? (
                    <span>{t("cutover.checkedAt", { time: clock(cutover.checkedAt) })}</span>
                ) : null}
                <Button size="sm" variant="ghost" disabled={pending} onClick={onCheck}>
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t("cutover.checkNow")}
                </Button>
            </div>
        </div>
    );
}

function CutoverState({
    t,
    cutover,
    hostname,
    pending,
    onSwitch,
    onRollback,
    onCheck
}: {
    t: CutoverT;
    cutover: CutoverView;
    hostname: string;
    pending: boolean;
    onSwitch: () => void;
    onRollback: () => void;
    onCheck: () => void;
}) {
    const [confirm, confirmDialog] = useConfirm();
    const { phase, mode } = cutover;
    const target = cutover.targetName;
    const source = cutover.sourceName;

    async function rollback() {
        const yes = await confirm({
            title: t("cutover.rollbackTitle"),
            description:
                mode === "manual" && cutover.switchedAt
                    ? t("cutover.rollbackBodyManual", { hostname, source })
                    : t("cutover.rollbackBody", { hostname, source }),
            confirmLabel: t("cutover.rollback"),
            danger: true
        });
        if (yes) onRollback();
    }

    const failure = cutover.failure
        ? t(FAILURE_KEYS[cutover.failure], {
              target,
              hostname,
              code: cutover.preflight?.code ?? 0
          })
        : null;

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {confirmDialog}
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <Badge variant={phaseVariant(phase)}>{t(PHASE_KEYS[phase])}</Badge>
                <span
                    className="min-w-0 truncate text-muted-foreground"
                    title={`${source} -> ${target}`}
                >
                    {t("cutover.route", { source, target })}
                </span>
            </div>

            {phase === "preflight-failed" || phase === "lowering" || phase === "ready" ? (
                <Preflight t={t} cutover={cutover} hostname={hostname} />
            ) : null}

            {failure ? (
                <p className="flex min-w-0 items-start gap-2 text-sm text-danger" role="alert">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 break-words">{failure}</span>
                </p>
            ) : null}

            {phase === "checking" ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                    <span className="min-w-0 break-words">{t("cutover.checking", { target })}</span>
                </p>
            ) : null}

            {phase === "lowering" ? (
                <p className="text-sm text-muted-foreground">
                    {t("cutover.lowering", {
                        old: cutover.oldTtl ?? LOWERED_TTL,
                        ttl: LOWERED_TTL,
                        time: clock(cutover.lowerUntil)
                    })}
                </p>
            ) : null}

            {phase === "lowering" || phase === "ready" ? (
                mode === "manual" ? (
                    <div className="flex min-w-0 flex-col gap-2 text-sm">
                        <p>{t("cutover.manualIntro")}</p>
                        <ol className="flex list-decimal flex-col gap-2 pl-5">
                            <li>
                                {cutover.oldTtl !== null && cutover.oldTtl > LOWERED_TTL
                                    ? t("cutover.manualLower", {
                                          ttl: LOWERED_TTL,
                                          old: cutover.oldTtl
                                      })
                                    : t("cutover.manualTtlShort")}
                            </li>
                            <li className="min-w-0">
                                <span>{t("cutover.manualChange", { ttl: LOWERED_TTL })}</span>
                                <RecordToSet
                                    hostname={hostname}
                                    values={cutover.newValue ? [cutover.newValue] : []}
                                />
                            </li>
                        </ol>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        {mode === "edge"
                            ? t("cutover.readyEdge")
                            : t("cutover.readyCloudflare", { address: cutover.newValue ?? "" })}
                    </p>
                )
            ) : null}

            {phase === "propagating" ? (
                <>
                    <p className="text-sm text-muted-foreground">
                        {t("cutover.propagating", { source })}
                    </p>
                    <Propagation
                        t={t}
                        cutover={cutover}
                        hostname={hostname}
                        pending={pending}
                        onCheck={onCheck}
                    />
                </>
            ) : null}

            {phase === "finishing" ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("cutover.finishing")}
                </p>
            ) : null}

            {phase === "failed" ? (
                <Propagation
                    t={t}
                    cutover={cutover}
                    hostname={hostname}
                    pending={pending}
                    onCheck={onCheck}
                />
            ) : null}

            {phase === "done" ? (
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                    <p className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                        <span className="min-w-0 break-words">
                            {t("cutover.done", { hostname, target })}
                        </span>
                    </p>
                    {mode === "cloudflare" &&
                    cutover.oldTtl !== null &&
                    cutover.oldTtl > LOWERED_TTL ? (
                        <p className="text-muted-foreground">
                            {t("cutover.doneTtl", { ttl: cutover.oldTtl })}
                        </p>
                    ) : null}
                    {mode === "manual" &&
                    cutover.oldTtl !== null &&
                    cutover.oldTtl > LOWERED_TTL ? (
                        <p className="text-muted-foreground">
                            {t("cutover.doneManualTtl", { ttl: cutover.oldTtl })}
                        </p>
                    ) : null}
                </div>
            ) : null}

            {phase === "rolled-back" ? (
                <div className="flex min-w-0 flex-col gap-2 text-sm">
                    <p className="flex items-start gap-2">
                        <RotateCcw className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 break-words">
                            {t("cutover.rolledBack", { hostname, source })}
                        </span>
                    </p>
                    {mode === "manual" && cutover.switchedAt && cutover.oldValues.length > 0 ? (
                        <>
                            <p>{t("cutover.rolledBackManual")}</p>
                            <RecordToSet hostname={hostname} values={cutover.oldValues} />
                        </>
                    ) : null}
                </div>
            ) : null}

            {cutover.canSwitch || cutover.canRollback ? (
                <div className={cn("flex min-w-0 flex-wrap items-center gap-2", "justify-end")}>
                    {cutover.canRollback ? (
                        <Button variant="ghost" disabled={pending} onClick={() => void rollback()}>
                            <RotateCcw className="size-4" />
                            {t("cutover.rollback")}
                        </Button>
                    ) : null}
                    {cutover.canSwitch ? (
                        <Button disabled={pending} onClick={onSwitch}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {mode === "manual" ? t("cutover.switchManual") : t("cutover.switch")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
