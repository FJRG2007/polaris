"use client";

/**
 * The Rollouts screen: every server's agent and pin, the open rollout wave by
 * wave, and each server's queued commands.
 *
 * The section headings paint at once; only the regions waiting on the answer
 * show a skeleton, and a revisit paints the last answer this tab kept while the
 * new one is read. Every write asks the server again afterwards, and a cancel
 * or a pin shows at once and is put back if it is refused.
 */

import { ChevronDown, Pin, PinOff, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    cn
} from "@polaris/ui";
import * as plan from "@/lib/agent-rollouts/plan";
import * as queue from "@/lib/agent-rollouts/queue";
import { useConfirm } from "@/components/confirm-dialog";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useLiveRead } from "@/components/use-live-resource";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CommandView, RolloutScreen, ServerAgentView } from "@/lib/agent-rollouts/service";
import {
    cancelCommandAction,
    commandHistoryAction,
    enqueueCommandAction,
    rolloutControlAction,
    rolloutScreenAction,
    setPinAction,
    startRolloutAction,
    type Result
} from "./actions";

type T = NamespaceTranslator<"agentRollouts">;

const REFRESH_MS = 30_000;
/** Servers drawn at first, and added per "Show more". */
const SERVER_PAGE = 50;
const OPEN = new Set(["running", "halted"]);
const STATES: readonly plan.TargetState[] = [
    "pending",
    "updating",
    "verifying",
    "healthy",
    "failed",
    "skipped"
];
const REASONS = [
    "no-agent",
    "pinned",
    "current",
    "timeout",
    "heartbeat",
    "version",
    "refused"
] as const;
const ROLLOUT_STATUSES = ["running", "halted", "done", "rolled-back", "cancelled"] as const;
const COMMAND_STATUSES = [
    "queued",
    "delivering",
    "done",
    "failed",
    "cancelled",
    "expired"
] as const;
const RESULTS = [
    "offline",
    "noAgent",
    "unknownAssignment",
    "unreadable",
    "interrupted",
    "unknownServer",
    "failed"
] as const;
const ERRORS = [
    "rolloutOpen",
    "noRollout",
    "notHalted",
    "noTargets",
    "queueFull",
    "unknownServer",
    "unknownAssignment",
    "notCancellable",
    "badWaves",
    "invalid",
    "failed"
] as const;

function oneOf<V extends string>(value: string | null, list: readonly V[]): V | null {
    return value !== null && (list as readonly string[]).includes(value) ? (value as V) : null;
}

/** A refusal code from an action, as the sentence a reader is shown. */
export function errorText(t: T, code: string): string {
    return t(`errors.${oneOf(code, ERRORS) ?? "failed"}`);
}

/** "1, 10, 50, 100" as numbers, or null when it is not a list of whole numbers. */
export function parseWaveInput(text: string): number[] | null {
    const parts = text.split(",").map((part) => part.trim());
    if (parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
    const waves = parts.map(Number);
    return plan.validWaves(waves) ? waves : null;
}

export function RolloutsView() {
    const t = useTranslations("agentRollouts");
    const load = useCallback(async () => {
        const answer = await rolloutScreenAction();
        if (!answer.ok) throw new Error(answer.error);
        return answer.value;
    }, []);
    const screen = useLiveRead<RolloutScreen>({
        load,
        cacheKey: "agent-rollouts",
        intervalMs: REFRESH_MS
    });
    const data = screen.kept && screen.stale !== null ? null : screen.data;
    const failure = screen.error ?? (data === null ? screen.stale : null);
    const [notice, setNotice] = useState<string | null>(null);
    const [, startTransition] = useTransition();
    const [confirm, confirmDialog] = useConfirm();

    /** Run a write, say why when it is refused, and read the screen again. */
    const act = useCallback(
        (run: () => Promise<Result<unknown>>, rollback?: () => void) => {
            setNotice(null);
            startTransition(async () => {
                const result = await run().catch(() => ({ ok: false as const, error: "failed" }));
                if (!result.ok) {
                    rollback?.();
                    setNotice(errorText(t, result.error));
                }
                screen.refresh();
            });
        },
        [screen, t]
    );

    const busy = screen.loading || screen.kept;
    return (
        <div className="flex min-w-0 flex-col gap-6">
            {confirmDialog}
            {notice ? (
                <p
                    role="alert"
                    className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                    {notice}
                </p>
            ) : null}
            {failure && !data ? (
                <p role="alert" className="text-sm text-danger">
                    {errorText(t, failure)}
                </p>
            ) : null}
            <RolloutSection
                data={data}
                busy={busy}
                onStart={(input) => act(() => startRolloutAction(input))}
                onControl={async (action) => {
                    if (action === "rollback") {
                        const previous = data?.rollout?.previousVersion ?? "";
                        const ok = await confirm({
                            title: t("rollout.rollbackTitle"),
                            description: t("rollout.rollbackBody", { version: previous || "-" }),
                            confirmLabel: t("rollout.rollback"),
                            danger: true
                        });
                        if (!ok) return;
                    }
                    act(() => rolloutControlAction(action));
                }}
            />
            <ServersSection
                data={data}
                busy={busy}
                onPin={(server, version) => {
                    const before = screen.data;
                    if (before) {
                        screen.replace({
                            ...before,
                            servers: before.servers.map((row) =>
                                row.id === server.id ? { ...row, pinnedVersion: version } : row
                            )
                        });
                    }
                    act(
                        () => setPinAction({ serverId: server.id, version }),
                        () => before && screen.replace(before)
                    );
                }}
                onQueue={(input) => act(() => enqueueCommandAction(input))}
                onCancel={(server, command) => {
                    const before = screen.data;
                    if (before) {
                        screen.replace({
                            ...before,
                            servers: before.servers.map((row) =>
                                row.id === server.id
                                    ? {
                                          ...row,
                                          waiting: row.waiting.filter(
                                              (one) => one.id !== command.id
                                          )
                                      }
                                    : row
                            )
                        });
                    }
                    act(
                        () => cancelCommandAction(command.id),
                        () => before && screen.replace(before)
                    );
                }}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// The rollout
// ---------------------------------------------------------------------------

function RolloutSection({
    data,
    busy,
    onStart,
    onControl
}: {
    data: RolloutScreen | null;
    busy: boolean;
    onStart: (input: { version: string; waves: number[]; healthMinutes: number }) => void;
    onControl: (action: "resume" | "halt" | "rollback") => void;
}) {
    const t = useTranslations("agentRollouts");
    const [starting, setStarting] = useState(false);
    const rollout = data?.rollout ?? null;
    const open = rollout !== null && OPEN.has(rollout.status);
    return (
        <section aria-labelledby="rollout-heading" className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="rollout-heading" className="text-sm font-semibold">
                    {t("rollout.heading")}
                </h2>
                <Button
                    size="sm"
                    onClick={() => setStarting(true)}
                    disabled={busy || data === null || open}
                    title={open ? t("errors.rolloutOpen") : undefined}
                >
                    {t("rollout.start")}
                </Button>
            </div>
            {data === null ? (
                <Skeleton className="h-28 w-full rounded-lg" />
            ) : rollout === null ? (
                <p className="text-sm text-muted-foreground">{t("rollout.none")}</p>
            ) : (
                <RolloutCard
                    rollout={rollout}
                    servers={data.servers}
                    busy={busy}
                    onControl={onControl}
                />
            )}
            {starting ? (
                <StartDialog
                    onClose={() => setStarting(false)}
                    onStart={(input) => {
                        setStarting(false);
                        onStart(input);
                    }}
                />
            ) : null}
        </section>
    );
}

function RolloutCard({
    rollout,
    servers,
    busy,
    onControl
}: {
    rollout: NonNullable<RolloutScreen["rollout"]>;
    servers: readonly ServerAgentView[];
    busy: boolean;
    onControl: (action: "resume" | "halt" | "rollback") => void;
}) {
    const t = useTranslations("agentRollouts");
    const names = useMemo(
        () => new Map(servers.map((server) => [server.id, server.name])),
        [servers]
    );
    const status = oneOf(rollout.status, ROLLOUT_STATUSES);
    const counted = rollout.targets.filter((target) => target.wave >= 0);
    const done = counted.filter((target) => target.state === "healthy").length;
    const waves = rollout.waves.map((_, index) => ({
        index,
        targets: rollout.targets.filter((target) => target.wave === index)
    }));
    const skipped = rollout.targets.filter((target) => target.wave < 0);
    const halt = oneOf(rollout.haltReason, ["failed", "manual"] as const);
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium" title={rollout.version}>
                    {t("rollout.summary", {
                        version: rollout.version,
                        wave: Math.min(rollout.wave + 1, rollout.waves.length),
                        waves: rollout.waves.length
                    })}
                </span>
                {status ? (
                    <Badge
                        variant={
                            status === "halted"
                                ? "danger"
                                : status === "done"
                                  ? "success"
                                  : "neutral"
                        }
                    >
                        {t(`rollout.status.${status}`)}
                    </Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">
                    {t("rollout.progress", { done, total: counted.length })}
                </span>
            </div>
            {rollout.status === "halted" && halt ? (
                <p role="status" className="text-sm text-danger">
                    {t(`rollout.halted.${halt}`)}
                </p>
            ) : null}
            {rollout.status === "rolled-back" ? (
                <p className="text-sm text-muted-foreground">
                    {rollout.previousVersion
                        ? t("rollout.rolledBack", { version: rollout.previousVersion })
                        : t("rollout.rolledBackNoPrevious")}
                </p>
            ) : null}
            <ol className="flex min-w-0 flex-col gap-2">
                {waves.map((wave) => (
                    <WaveRow
                        key={wave.index}
                        label={t("rollout.wave", { wave: wave.index + 1 })}
                        current={wave.index === rollout.wave && OPEN.has(rollout.status)}
                        targets={wave.targets}
                        names={names}
                    />
                ))}
                {skipped.length > 0 ? (
                    <WaveRow
                        label={t("rollout.skippedWave")}
                        current={false}
                        targets={skipped}
                        names={names}
                    />
                ) : null}
            </ol>
            {OPEN.has(rollout.status) ? (
                <div className="flex flex-wrap gap-2">
                    {rollout.status === "halted" ? (
                        <Button size="sm" disabled={busy} onClick={() => onControl("resume")}>
                            {t("rollout.resume")}
                        </Button>
                    ) : (
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => onControl("halt")}
                        >
                            {t("rollout.halt")}
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => onControl("rollback")}
                    >
                        {t("rollout.rollback")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function WaveRow({
    label,
    current,
    targets,
    names
}: {
    label: string;
    current: boolean;
    targets: NonNullable<RolloutScreen["rollout"]>["targets"];
    names: ReadonlyMap<string, string>;
}) {
    const t = useTranslations("agentRollouts");
    return (
        <li className="flex min-w-0 flex-col gap-1">
            <span className={cn("text-xs", current ? "font-semibold" : "text-muted-foreground")}>
                {label}
            </span>
            <ul className="flex min-w-0 flex-wrap gap-1.5">
                {targets.map((target) => {
                    const state = oneOf(target.state, STATES);
                    const reason = oneOf(target.error, REASONS);
                    const name = names.get(target.serverId) ?? target.serverId;
                    const words = [
                        state ? t(`rollout.state.${state}`) : "",
                        reason ? t(`rollout.reason.${reason}`) : ""
                    ]
                        .filter(Boolean)
                        .join(" - ");
                    return (
                        <li
                            key={target.serverId}
                            className={cn(
                                "flex min-w-0 max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs",
                                state === "failed"
                                    ? "bg-danger-soft text-danger-ink"
                                    : state === "healthy"
                                      ? "bg-success-soft text-success-ink"
                                      : "bg-background"
                            )}
                            title={`${name}: ${words}`}
                        >
                            <span className="min-w-0 truncate font-medium">{name}</span>
                            <span className="shrink-0">{words}</span>
                        </li>
                    );
                })}
            </ul>
        </li>
    );
}

function StartDialog({
    onClose,
    onStart
}: {
    onClose: () => void;
    onStart: (input: { version: string; waves: number[]; healthMinutes: number }) => void;
}) {
    const t = useTranslations("agentRollouts");
    const tc = useTranslations("common");
    const [version, setVersion] = useState("");
    const [waves, setWaves] = useState(plan.DEFAULT_WAVES.join(", "));
    const [health, setHealth] = useState(String(plan.DEFAULT_HEALTH_MINUTES));
    const trimmed = version.trim();
    const parsedWaves = parseWaveInput(waves);
    const minutes = /^\d{1,3}$/.test(health.trim()) ? Number(health.trim()) : NaN;
    const healthOk = minutes >= 1 && minutes <= 240;
    const versionOk = trimmed.length > 0 && trimmed.length <= 64;
    const ready = versionOk && parsedWaves !== null && healthOk;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("rollout.startTitle")}</DialogTitle>
                    <DialogDescription>{t("rollout.startBody")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (ready)
                            onStart({
                                version: trimmed,
                                waves: parsedWaves,
                                healthMinutes: minutes
                            });
                    }}
                >
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                            {t("rollout.version")} *
                        </span>
                        <Input
                            value={version}
                            onChange={(event) => setVersion(event.target.value)}
                            maxLength={64}
                            autoFocus
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("rollout.versionHint")}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                            {t("rollout.waves")} *
                        </span>
                        <Input
                            value={waves}
                            onChange={(event) => setWaves(event.target.value)}
                            aria-invalid={waves.trim() !== "" && parsedWaves === null}
                        />
                        <span
                            className={cn(
                                "text-xs",
                                waves.trim() !== "" && parsedWaves === null
                                    ? "text-danger"
                                    : "text-muted-foreground"
                            )}
                        >
                            {waves.trim() !== "" && parsedWaves === null
                                ? t("errors.badWaves")
                                : t("rollout.wavesHint")}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                            {t("rollout.health")} *
                        </span>
                        <Input
                            value={health}
                            inputMode="numeric"
                            onChange={(event) => setHealth(event.target.value)}
                            aria-invalid={health.trim() !== "" && !healthOk}
                        />
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={!ready}>
                            {t("rollout.start")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Servers and their queues
// ---------------------------------------------------------------------------

type QueueInput = {
    id: string;
    serverId: string;
    expiry: queue.ExpiryChoice;
    command: queue.CommandSpec;
};

function ServersSection({
    data,
    busy,
    onPin,
    onQueue,
    onCancel
}: {
    data: RolloutScreen | null;
    busy: boolean;
    onPin: (server: ServerAgentView, version: string | null) => void;
    onQueue: (input: QueueInput) => void;
    onCancel: (server: ServerAgentView, command: CommandView) => void;
}) {
    const t = useTranslations("agentRollouts");
    const [pinning, setPinning] = useState<ServerAgentView | null>(null);
    const [queueing, setQueueing] = useState<ServerAgentView | null>(null);
    const [shown, setShown] = useState(SERVER_PAGE);
    return (
        <section aria-labelledby="servers-heading" className="flex min-w-0 flex-col gap-3">
            <h2 id="servers-heading" className="text-sm font-semibold">
                {t("servers.heading")}
            </h2>
            {data === null ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-14 w-full rounded-lg" />
                    <Skeleton className="h-14 w-full rounded-lg" />
                </div>
            ) : data.servers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("servers.empty")}</p>
            ) : (
                <>
                    <ul className="flex min-w-0 flex-col gap-2">
                        {data.servers.slice(0, shown).map((server) => (
                            <ServerRow
                                key={server.id}
                                server={server}
                                busy={busy}
                                onPin={() =>
                                    server.pinnedVersion ? onPin(server, null) : setPinning(server)
                                }
                                onQueue={() => setQueueing(server)}
                                onCancel={(command) => onCancel(server, command)}
                            />
                        ))}
                    </ul>
                    {data.servers.length > shown ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="self-start"
                            onClick={() => setShown((count) => count + SERVER_PAGE)}
                        >
                            {t("servers.more")}
                        </Button>
                    ) : null}
                </>
            )}
            {pinning ? (
                <PinDialog
                    server={pinning}
                    onClose={() => setPinning(null)}
                    onPin={(version) => {
                        onPin(pinning, version);
                        setPinning(null);
                    }}
                />
            ) : null}
            {queueing ? (
                <QueueDialog
                    server={queueing}
                    onClose={() => setQueueing(null)}
                    onQueue={(input) => {
                        onQueue(input);
                        setQueueing(null);
                    }}
                />
            ) : null}
        </section>
    );
}

function ServerRow({
    server,
    busy,
    onPin,
    onQueue,
    onCancel
}: {
    server: ServerAgentView;
    busy: boolean;
    onPin: () => void;
    onQueue: () => void;
    onCancel: (command: CommandView) => void;
}) {
    const t = useTranslations("agentRollouts");
    const format = useDisplayFormat();
    const [expanded, setExpanded] = useState(server.waiting.length > 0);
    const pinLabel = server.pinnedVersion ? t("servers.unpin") : t("servers.pin");
    const listId = `commands-${server.id}`;
    return (
        <li className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={server.name}>
                    {server.name}
                </span>
                <Badge variant={server.online ? "success" : "neutral"}>
                    {server.online ? t("servers.online") : t("servers.offline")}
                </Badge>
                {server.pinnedVersion ? (
                    <Badge variant="warning" title={t("servers.pinBody")}>
                        {t("servers.pinned", { version: server.pinnedVersion })}
                    </Badge>
                ) : null}
            </div>
            <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-muted-foreground">{t("servers.columns.agent")}</dt>
                    <dd
                        className="min-w-0 truncate"
                        title={server.version ? server.version : t("servers.noAgentHint")}
                    >
                        {server.version ?? t("servers.noAgent")}
                    </dd>
                </div>
                <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-muted-foreground">{t("servers.columns.seen")}</dt>
                    <dd className="min-w-0 truncate">
                        {server.heartbeatAt
                            ? format.dateTime(server.heartbeatAt)
                            : t("servers.never")}
                    </dd>
                </div>
                <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-muted-foreground">
                        {t("servers.columns.waiting")}
                    </dt>
                    <dd>{server.waiting.length}</dd>
                </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={expanded}
                    aria-controls={listId}
                    onClick={() => setExpanded((open) => !open)}
                >
                    <ChevronDown
                        className={cn(
                            "size-4 shrink-0 transition-transform",
                            expanded && "rotate-180"
                        )}
                        aria-hidden
                    />
                    {t("servers.commands")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onQueue}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("queue.add")}
                </Button>
                {server.version !== null || server.pinnedVersion ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={onPin}>
                        {server.pinnedVersion ? (
                            <PinOff className="size-4 shrink-0" aria-hidden />
                        ) : (
                            <Pin className="size-4 shrink-0" aria-hidden />
                        )}
                        {pinLabel}
                    </Button>
                ) : null}
            </div>
            {expanded ? (
                <div id={listId} className="flex min-w-0 flex-col gap-2">
                    {server.waiting.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("queue.empty")}</p>
                    ) : (
                        <ul className="flex min-w-0 flex-col gap-1">
                            {server.waiting.map((command) => (
                                <CommandRow
                                    key={command.id}
                                    command={command}
                                    busy={busy}
                                    onCancel={() => onCancel(command)}
                                />
                            ))}
                        </ul>
                    )}
                    <CommandHistory serverId={server.id} busy={busy} />
                </div>
            ) : null}
        </li>
    );
}

/** A server's finished commands, read when someone opens them. */
function CommandHistory({ serverId, busy }: { serverId: string; busy: boolean }) {
    const t = useTranslations("agentRollouts");
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState<CommandView[] | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const listId = `history-${serverId}`;
    const toggle = () => {
        if (open) {
            setOpen(false);
            return;
        }
        setOpen(true);
        setFailure(null);
        commandHistoryAction(serverId)
            .catch(() => ({ ok: false as const, error: "failed" }))
            .then((answer) => (answer.ok ? setRows(answer.value) : setFailure(answer.error)));
    };
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <Button
                size="sm"
                variant="ghost"
                className="self-start"
                aria-expanded={open}
                aria-controls={listId}
                onClick={toggle}
            >
                <ChevronDown
                    className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
                    aria-hidden
                />
                {t("queue.history")}
            </Button>
            {open ? (
                <div id={listId} className="flex min-w-0 flex-col gap-1">
                    {failure ? (
                        <p role="alert" className="text-xs text-danger">
                            {errorText(t, failure)}
                        </p>
                    ) : rows === null ? (
                        <Skeleton className="h-8 w-full rounded-md" />
                    ) : rows.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("queue.historyEmpty")}</p>
                    ) : (
                        <ul className="flex min-w-0 flex-col gap-1">
                            {rows.map((command) => (
                                <CommandRow key={command.id} command={command} busy={busy} />
                            ))}
                        </ul>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function CommandRow({
    command,
    busy,
    onCancel
}: {
    command: CommandView;
    busy: boolean;
    onCancel?: () => void;
}) {
    const t = useTranslations("agentRollouts");
    const format = useDisplayFormat();
    const kind = oneOf(command.kind, queue.COMMAND_KINDS);
    const status = oneOf(command.status, COMMAND_STATUSES);
    const result =
        command.status === "failed" || command.status === "expired"
            ? oneOf(command.result, RESULTS)
            : null;
    const cancel = t("queue.cancel");
    return (
        <li className="flex min-w-0 items-center gap-2 rounded-md bg-background px-2 py-1 text-xs">
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="min-w-0 truncate" title={command.target}>
                    <span className="font-medium">
                        {kind ? t(`queue.kinds.${kind}`) : command.kind}
                    </span>
                    {command.target ? ` ${command.target}` : ""}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                    {status ? t(`queue.status.${status}`) : command.status}
                    {result ? ` - ${t(`queue.results.${result}`)}` : ""}
                    {command.status === "queued"
                        ? ` - ${t("queue.expires", { when: format.dateTime(command.expiresAt) })}`
                        : ""}
                </span>
            </div>
            {onCancel && queue.cancellable(command.status) ? (
                <Button
                    size="icon"
                    variant="ghost"
                    disabled={busy}
                    onClick={onCancel}
                    aria-label={cancel}
                    title={cancel}
                >
                    <X className="size-4 shrink-0" aria-hidden />
                </Button>
            ) : null}
        </li>
    );
}

function PinDialog({
    server,
    onClose,
    onPin
}: {
    server: ServerAgentView;
    onClose: () => void;
    onPin: (version: string) => void;
}) {
    const t = useTranslations("agentRollouts");
    const tc = useTranslations("common");
    const [version, setVersion] = useState(server.version ?? "");
    const trimmed = version.trim();
    const ready = trimmed.length > 0 && trimmed.length <= 64;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("servers.pinTitle", { name: server.name })}</DialogTitle>
                    <DialogDescription>{t("servers.pinBody")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (ready) onPin(trimmed);
                    }}
                >
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                            {t("servers.pinVersion")} *
                        </span>
                        <Input
                            value={version}
                            maxLength={64}
                            onChange={(event) => setVersion(event.target.value)}
                            autoFocus
                        />
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={!ready}>
                            {t("servers.pin")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function QueueDialog({
    server,
    onClose,
    onQueue
}: {
    server: ServerAgentView;
    onClose: () => void;
    onQueue: (input: QueueInput) => void;
}) {
    const t = useTranslations("agentRollouts");
    const tc = useTranslations("common");
    // Minted once per dialog, so a submit that is sent twice is still one command.
    const [id] = useState(() => crypto.randomUUID());
    const kinds = queue.COMMAND_KINDS.filter(
        (kind) =>
            (kind !== "agent.update" || server.version !== null) &&
            (kind !== "template.apply" || server.assignments.length > 0)
    );
    const [kind, setKind] = useState<queue.CommandKind>("container.restart");
    const [value, setValue] = useState("");
    const [expiry, setExpiry] = useState<queue.ExpiryChoice>("1d");
    const field =
        kind === "template.apply"
            ? "assignmentId"
            : kind === "agent.update"
              ? "version"
              : "container";
    const fieldLabel =
        kind === "template.apply"
            ? t("queue.assignment")
            : kind === "agent.update"
              ? t("queue.version")
              : t("queue.container");
    const parsed = queue.commandSchema.safeParse({ kind, [field]: value });
    const invalid = value.trim() !== "" && !parsed.success;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("queue.addTitle", { name: server.name })}</DialogTitle>
                    <DialogDescription>{t("queue.addBody")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (parsed.success)
                            onQueue({ id, serverId: server.id, expiry, command: parsed.data });
                    }}
                >
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("queue.kind")}</span>
                        <Select
                            value={kind}
                            onValueChange={(next) => {
                                setKind(next as queue.CommandKind);
                                setValue(
                                    next === "template.apply"
                                        ? (server.assignments[0]?.id ?? "")
                                        : ""
                                );
                            }}
                            options={kinds.map((one) => ({
                                value: one,
                                label: t(`queue.kinds.${one}`)
                            }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{fieldLabel} *</span>
                        {kind === "template.apply" ? (
                            <Select
                                value={value}
                                onValueChange={setValue}
                                options={server.assignments.map((one) => ({
                                    value: one.id,
                                    label: one.name
                                }))}
                            />
                        ) : (
                            <Input
                                value={value}
                                maxLength={128}
                                onChange={(event) => setValue(event.target.value)}
                                aria-invalid={invalid}
                            />
                        )}
                        {invalid ? (
                            <span className="text-xs text-danger">{t("errors.invalid")}</span>
                        ) : null}
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("queue.expiry")}</span>
                        <Select
                            value={expiry}
                            onValueChange={(next) => setExpiry(next as queue.ExpiryChoice)}
                            options={(
                                Object.keys(queue.EXPIRY_CHOICES) as queue.ExpiryChoice[]
                            ).map((one) => ({
                                value: one,
                                label: t(`queue.expiries.${one}`)
                            }))}
                        />
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!parsed.success}
                            disabled={!parsed.success}
                        >
                            {t("queue.add")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
