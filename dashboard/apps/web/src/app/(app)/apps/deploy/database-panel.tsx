"use client";

/**
 * A managed database's Manage panel: its version and upgrades, the settings its
 * engine has, point-in-time recovery, copying data in, an object store's
 * buckets, and what has been run on it.
 *
 * Every destructive step is confirmed in an in-app dialog that says what will
 * happen to the data, and long operations are followed here - the panel polls
 * while one is running, so the step it is on is on screen without a refresh.
 */

import * as core from "@polaris/core";
import { CopyRow } from "./deploy-view";
import * as actions from "./database-actions";
import { useProjectCan } from "./access-context";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { useDisplayFormat } from "@/components/display-format";
import { KeyRound, Link2, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    ScrollRow,
    SegmentedControl,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";

type Overview = NonNullable<Awaited<ReturnType<typeof actions.databaseOverviewAction>>["overview"]>;
type Tab = "versions" | "settings" | "pitr" | "copy" | "buckets" | "activity";

/** A pending confirmation: what it says, and what it runs once agreed to. */
interface Confirmation {
    title: string;
    body: ReactNode;
    label: string;
    danger?: boolean;
    run: () => Promise<{ error?: string }>;
}

export function DatabaseManageDialog({
    database,
    open,
    onOpenChange
}: {
    database: { id: string; name: string; engine: string };
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const can = useProjectCan();
    const manage = can("databases.manage");
    const [overview, setOverview] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("versions");
    const [confirm, setConfirm] = useState<Confirmation | null>(null);
    const [confirmError, setConfirmError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(async () => {
        const result = await actions.databaseOverviewAction(database.id);
        if (result.overview) {
            setOverview(result.overview);
            setError(null);
        } else setError(result.error ?? "Could not read this database");
    }, [database.id]);

    useEffect(() => {
        if (!open) return;
        setOverview(null);
        void load();
    }, [open, load]);

    // Followed while something runs: an upgrade or a copy takes minutes, and the
    // step it is on is what somebody opened this to see.
    const running =
        overview?.operations.some((operation) => operation.status === "running") ||
        overview?.upgrade?.state === "running" ||
        overview?.upgrade?.state === "starting";
    useEffect(() => {
        if (!open || !running) return;
        const timer = setInterval(() => void load(), 3000);
        return () => clearInterval(timer);
    }, [open, running, load]);

    const tabs: { value: Tab; label: string }[] = overview
        ? [
              ...(overview.upgrade ? [{ value: "versions" as const, label: "Version" }] : []),
              ...(overview.redis || overview.mongo || overview.limits
                  ? [{ value: "settings" as const, label: "Settings" }]
                  : []),
              ...(overview.pitr ? [{ value: "pitr" as const, label: "Point in time" }] : []),
              ...(!overview.storage ? [{ value: "copy" as const, label: "Copy data in" }] : []),
              ...(overview.storage ? [{ value: "buckets" as const, label: "Buckets" }] : []),
              { value: "activity" as const, label: "Activity" }
          ]
        : [];
    const current = tabs.some((entry) => entry.value === tab) ? tab : (tabs[0]?.value ?? "activity");

    function ask(confirmation: Confirmation) {
        setConfirmError(null);
        setConfirm(confirmation);
    }

    function agree() {
        if (!confirm) return;
        const run = confirm.run;
        startTransition(async () => {
            const result = await run();
            if (result.error) {
                setConfirmError(result.error);
                return;
            }
            setConfirm(null);
            await load();
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-full max-w-2xl">
                <DialogHeader className="pr-8">
                    <DialogTitle className="flex items-center gap-2">
                        <DbEngineIcon engine={database.engine} className="size-6" />
                        <span className="truncate" title={database.name}>{database.name}</span>
                        {overview ? (
                            <Badge>
                                {core.dbEngineLabel(overview.engine)} {overview.version}
                            </Badge>
                        ) : null}
                    </DialogTitle>
                    {overview?.hosted ? (
                        <DialogDescription>
                            Lives inside {overview.hostName ?? "another instance"}. Its version and settings are the instance's.
                        </DialogDescription>
                    ) : overview?.recovery ? (
                        <DialogDescription>
                            Recovered from {overview.recovery.from ?? "a removed instance"}.
                        </DialogDescription>
                    ) : null}
                </DialogHeader>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {!overview && !error ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-8 w-72" />
                        <Skeleton className="h-24 w-full" />
                    </div>
                ) : null}

                {overview ? (
                    <div className="flex flex-col gap-4">
                        {tabs.length > 1 ? (
                            <ScrollRow>
                                <SegmentedControl
                                    aria-label="Section"
                                    size="sm"
                                    value={current}
                                    onValueChange={setTab}
                                    options={tabs}
                                />
                            </ScrollRow>
                        ) : null}
                        {!overview.deployed && current !== "activity" ? (
                            <p className="text-sm text-muted-foreground">Provision it first; there is nothing running to manage yet.</p>
                        ) : current === "versions" && overview.upgrade ? (
                            <VersionsSection overview={overview} manage={manage} ask={ask} onChanged={load} />
                        ) : current === "settings" ? (
                            <div className="flex flex-col gap-5">
                                <LimitsSection overview={overview} manage={manage} ask={ask} />
                                <SettingsSection overview={overview} manage={manage} ask={ask} />
                            </div>
                        ) : current === "pitr" && overview.pitr ? (
                            <PitrSection overview={overview} manage={manage} ask={ask} />
                        ) : current === "copy" ? (
                            <CopySection overview={overview} manage={manage} ask={ask} />
                        ) : current === "buckets" ? (
                            <BucketsSection storeId={overview.id} manage={manage} ask={ask} />
                        ) : null}
                        {current === "activity" || running ? <ActivityList overview={overview} compact={current !== "activity"} /> : null}
                    </div>
                ) : null}

                {confirm ? (
                    <Dialog open onOpenChange={(value) => !value && setConfirm(null)}>
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle>{confirm.title}</DialogTitle>
                                <DialogDescription>{confirm.body}</DialogDescription>
                            </DialogHeader>
                            {confirmError ? <p className="text-sm text-danger">{confirmError}</p> : null}
                            <DialogFooter>
                                <Button variant="ghost" onClick={() => setConfirm(null)}>
                                    Cancel
                                </Button>
                                <Button variant={confirm.danger ? "danger" : "primary"} disabled={pending} onClick={agree}>
                                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                                    {confirm.label}
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

type Ask = (confirmation: Confirmation) => void;

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-2">
            <div>
                <h3 className="text-sm font-medium">{title}</h3>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            {children}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** `datetime-local` gives the browser's wall time with no zone; this is the
 *  moment it names, or null when it names none. */
function fromLocalInput(value: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function VersionsSection({
    overview,
    manage,
    ask,
    onChanged
}: {
    overview: Overview;
    manage: boolean;
    ask: Ask;
    onChanged: () => Promise<void>;
}) {
    const format = useDisplayFormat();
    const upgrade = overview.upgrade!;
    const label = core.dbEngineLabel(overview.engine);
    const [version, setVersion] = useState(upgrade.versions[0] ?? overview.version);
    const [when, setWhen] = useState<"now" | "later">("now");
    const [at, setAt] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const moment = fromLocalInput(at);
    const refresh = version === overview.version;
    const options = [
        { value: overview.version, label: `Newest ${label} ${overview.version} release` },
        ...upgrade.versions.map((entry) => ({ value: entry, label: `${label} ${entry}` }))
    ];

    function start() {
        const at = when === "later" && moment ? moment.toISOString() : undefined;
        ask({
            title: at
                ? `Schedule the move to ${label} ${version}?`
                : refresh
                  ? `Update to the newest ${version} release?`
                  : `Upgrade to ${label} ${version}?`,
            body: refresh
                ? "The instance restarts on the newest release of the version it runs. Its data stays where it is."
                : overview.storage
                  ? `The store restarts on ${version} with the data it has. If it does not start, it goes back to ${overview.version}.`
                  : `Its data is copied out, ${label} ${version} starts on a new volume, and the copy is loaded into it. It is unavailable while that runs. If any step fails it goes back to ${overview.version} on its old data, which is kept either way.${at ? ` Runs at ${format.dateTime(at)}.` : ""}`,
            label: at ? "Schedule" : refresh ? "Update" : "Upgrade",
            run: () => actions.upgradeDatabaseAction({ databaseId: overview.id, version, ...(at ? { at } : {}) })
        });
    }

    function cancel() {
        setError(null);
        startTransition(async () => {
            const result = await actions.cancelUpgradeAction(overview.id);
            if (result.error) setError(result.error);
            await onChanged();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            {upgrade.state === "scheduled" && upgrade.at ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm">
                    <span>
                        Moving to {label} {upgrade.to} at {format.dateTime(upgrade.at)}.
                    </span>
                    {manage ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
                            Cancel it
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {upgrade.state === "running" || upgrade.state === "starting" ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Moving to {label} {upgrade.to}.
                </p>
            ) : null}
            {upgrade.state === "failed" && upgrade.error ? (
                <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    The last upgrade did not go through: {upgrade.error}
                </p>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {manage && upgrade.state !== "running" && upgrade.state !== "starting" ? (
                <Section
                    title="Change version"
                    hint={
                        upgrade.versions.length === 0
                            ? `Runs the newest ${label} Polaris offers.`
                            : "Only newer versions are offered: a copy from a newer version may not load into an older one."
                    }
                >
                    <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-56 flex-1">
                            <Select value={version} onValueChange={setVersion} options={options} />
                        </div>
                        <SegmentedControl
                            aria-label="When"
                            value={when}
                            onValueChange={setWhen}
                            options={[
                                { value: "now", label: "Now" },
                                { value: "later", label: "In a window" }
                            ]}
                        />
                    </div>
                    {when === "later" ? (
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Start at (this browser's time)
                            <Input
                                type="datetime-local"
                                value={at}
                                onChange={(event) => setAt(event.target.value)}
                                className="w-64"
                            />
                        </label>
                    ) : null}
                    <div>
                        <Button
                            size="sm"
                            disabled={when === "later" && (!moment || moment.getTime() < Date.now() + 60_000)}
                            onClick={start}
                        >
                            {when === "later" ? "Schedule" : refresh ? "Update" : "Upgrade"}
                        </Button>
                    </div>
                </Section>
            ) : null}

            {manage && upgrade.previousVersion && upgrade.previousVolume ? (
                <Section
                    title={`${label} ${upgrade.previousVersion} is still kept`}
                    hint={`Its data is on the volume ${upgrade.previousVolume}, as it was before the upgrade. Remove that volume from the server's Storage tab once you no longer need it.`}
                >
                    <div>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                                ask({
                                    title: `Go back to ${label} ${upgrade.previousVersion}?`,
                                    body: `The instance restarts on ${upgrade.previousVersion} with the data it had before the upgrade. Anything written since stays on the newer volume and is not carried back.`,
                                    label: "Go back",
                                    danger: true,
                                    run: () => actions.revertUpgradeAction(overview.id)
                                })
                            }
                        >
                            <RotateCcw className="size-4" /> Go back
                        </Button>
                    </div>
                </Section>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The most CPU and memory the instance's container may use, applied by
 *  starting it again. Blank is no limit. */
function LimitsSection({ overview, manage, ask }: { overview: Overview; manage: boolean; ask: Ask }) {
    const limits = overview.limits;
    const [cpus, setCpus] = useState(limits?.cpus == null ? "" : String(limits.cpus));
    const [memory, setMemory] = useState(limits?.memoryMb == null ? "" : String(limits.memoryMb));
    if (!limits) return null;
    const next = {
        cpus: cpus.trim() ? Number(cpus) : null,
        memoryMb: memory.trim() ? Number(memory) : null
    };
    const parsed = core.resourceLimitsSchema.safeParse(next);
    const changed = next.cpus !== limits.cpus || next.memoryMb !== limits.memoryMb;
    return (
        <Section title="Resources" hint="Past its memory the database is stopped and started again; past its CPU it is slowed. Blank = no limit.">
            <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">CPU (cores)</span>
                    <Input
                        type="number"
                        min={0.05}
                        step={0.05}
                        value={cpus}
                        disabled={!manage}
                        onChange={(event) => setCpus(event.target.value)}
                        placeholder="No limit"
                        className="w-28"
                    />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Memory (MB)</span>
                    <Input
                        type="number"
                        min={16}
                        step={64}
                        value={memory}
                        disabled={!manage}
                        onChange={(event) => setMemory(event.target.value)}
                        placeholder="No limit"
                        className="w-28"
                    />
                </label>
            </div>
            {!parsed.success ? (
                <p className="text-xs text-danger">{parsed.error.issues[0]?.message ?? "Check these limits"}</p>
            ) : null}
            {manage ? (
                <div>
                    <Button
                        size="sm"
                        disabled={!changed || !parsed.success}
                        onClick={() =>
                            ask({
                                title: "Apply the new limits?",
                                body: "The database is started again with them. Connections drop for the few seconds that takes.",
                                label: "Apply",
                                run: () => actions.setDatabaseLimitsAction({ databaseId: overview.id, ...next })
                            })
                        }
                    >
                        Apply
                    </Button>
                </div>
            ) : null}
        </Section>
    );
}

function SettingsSection({ overview, manage, ask }: { overview: Overview; manage: boolean; ask: Ask }) {
    const redis = overview.redis;
    const mongo = overview.mongo;
    const [mode, setMode] = useState<core.RedisMode>((redis?.mode as core.RedisMode) ?? "default");
    const [size, setSize] = useState(String(redis?.maxMemoryMb ?? 256));

    if (redis) {
        const changed = mode !== redis.mode || (mode === "cache" && Number(size) !== (redis.maxMemoryMb ?? 256));
        return (
            <Section title="How Redis keeps its data" hint={core.REDIS_MODE_NOTES[mode]}>
                <SegmentedControl
                    aria-label="Mode"
                    value={mode}
                    onValueChange={setMode}
                    options={core.REDIS_MODES.map((value) => ({ value, label: core.REDIS_MODE_LABELS[value] }))}
                />
                {mode === "cache" ? (
                    <div className="w-48">
                        <Select
                            value={size}
                            onValueChange={setSize}
                            options={core.REDIS_CACHE_SIZES_MB.map((value) => ({
                                value: String(value),
                                label: value >= 1024 ? `${value / 1024} GB limit` : `${value} MB limit`
                            }))}
                        />
                    </div>
                ) : null}
                <p className="text-xs text-muted-foreground">Publish and subscribe work in every mode.</p>
                {manage ? (
                    <div>
                        <Button
                            size="sm"
                            disabled={!changed}
                            onClick={() =>
                                ask({
                                    title: `Switch to ${core.REDIS_MODE_LABELS[mode].toLowerCase()} mode?`,
                                    body:
                                        mode === "persistent"
                                            ? "Redis writes everything it holds to its log first, then restarts with the log on."
                                            : mode === "cache"
                                              ? "Redis saves a snapshot, then restarts without writing to disk. Keys are evicted when it reaches the limit."
                                              : "Redis saves a snapshot, then restarts on its own snapshot schedule.",
                                    label: "Switch",
                                    run: () =>
                                        actions.setRedisModeAction({
                                            databaseId: overview.id,
                                            mode,
                                            ...(mode === "cache" ? { maxMemoryMb: Number(size) } : {})
                                        })
                                })
                            }
                        >
                            Apply
                        </Button>
                    </div>
                ) : null}
            </Section>
        );
    }

    if (mongo) {
        return (
            <Section
                title="Replica set"
                hint="A single-member replica set, rs0. Change streams and multi-document transactions need one. Connection strings gain replicaSet=rs0."
            >
                <label className="flex items-center gap-2 text-sm">
                    <Switch
                        checked={mongo.replicaSet}
                        disabled={!manage}
                        onChange={(enabled) =>
                            ask({
                                title: enabled ? "Run as a replica set?" : "Stop running as a replica set?",
                                body: enabled
                                    ? "The instance restarts with a replica set of one member. If it does not start that way, it is put back."
                                    : "The instance restarts as a standalone server with the same data. Change streams and transactions stop working.",
                                label: enabled ? "Turn on" : "Turn off",
                                danger: !enabled,
                                run: () => actions.setMongoReplicaSetAction({ databaseId: overview.id, enabled })
                            })
                        }
                    />
                    {mongo.replicaSet ? "On" : "Off"}
                </label>
            </Section>
        );
    }
    return null;
}

// ---------------------------------------------------------------------------
// Point in time
// ---------------------------------------------------------------------------

function PitrSection({ overview, manage, ask }: { overview: Overview; manage: boolean; ask: Ask }) {
    const format = useDisplayFormat();
    const pitr = overview.pitr!;
    const [keepDays, setKeepDays] = useState(String(pitr.keepDays));
    const [target, setTarget] = useState("");
    const [name, setName] = useState(`${overview.name}-recovered`);
    const moment = fromLocalInput(target);
    const earliest = pitr.from ? new Date(pitr.from) : null;
    const inWindow = Boolean(moment && earliest && moment >= earliest && moment.getTime() <= Date.now());

    return (
        <div className="flex flex-col gap-4">
            <Section
                title="Continuous archiving"
                hint="Every change is archived, with a base backup each day, so the instance can be rebuilt as it was at any moment in the window. The archive is on this server's disk: it covers mistakes, not a lost disk."
            >
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={pitr.enabled}
                            disabled={!manage}
                            onChange={(enabled) =>
                                ask({
                                    title: enabled ? "Turn on point-in-time recovery?" : "Turn off point-in-time recovery?",
                                    body: enabled
                                        ? "The instance restarts with archiving on, and takes its first base backup."
                                        : "The instance restarts without archiving and the archive is deleted. Nothing before now can be recovered afterwards.",
                                    label: enabled ? "Turn on" : "Turn off",
                                    danger: !enabled,
                                    run: () =>
                                        actions.setPitrAction({ databaseId: overview.id, enabled, keepDays: Number(keepDays) })
                                })
                            }
                        />
                        {pitr.enabled ? "On" : "Off"}
                    </label>
                    <div className="w-40">
                        <Select
                            value={keepDays}
                            disabled={!manage}
                            onValueChange={(value) => {
                                setKeepDays(value);
                                if (pitr.enabled) {
                                    void actions.setPitrAction({ databaseId: overview.id, enabled: true, keepDays: Number(value) });
                                }
                            }}
                            options={core.PITR_KEEP_DAYS.map((days) => ({
                                value: String(days),
                                label: days === 1 ? "Keep 1 day" : `Keep ${days} days`
                            }))}
                        />
                    </div>
                </div>
                {pitr.enabled ? (
                    <p className="text-xs text-muted-foreground">
                        {pitr.from
                            ? `Recoverable from ${format.dateTime(pitr.from)} until about a minute ago. ${pitr.baseBackups.length} base ${pitr.baseBackups.length === 1 ? "backup" : "backups"} kept.`
                            : "Taking the first base backup. Nothing can be recovered until it finishes."}
                    </p>
                ) : null}
            </Section>

            {pitr.enabled && pitr.from && manage ? (
                <Section
                    title="Recover to a moment"
                    hint="The recovery lands in a new database beside this one, with the same accounts. This one is not touched."
                >
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Moment (this browser's time)
                            <Input
                                type="datetime-local"
                                step={1}
                                value={target}
                                onChange={(event) => setTarget(event.target.value)}
                                className="w-64"
                            />
                        </label>
                        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            New database name
                            <Input value={name} onChange={(event) => setName(event.target.value)} />
                        </label>
                    </div>
                    {moment && !inWindow ? (
                        <p className="text-xs text-warning">Pick a moment inside the window above.</p>
                    ) : null}
                    <div>
                        <Button
                            size="sm"
                            disabled={!inWindow || !name.trim()}
                            onClick={() =>
                                moment &&
                                ask({
                                    title: `Recover ${overview.name} as it was at ${format.dateTime(moment.toISOString(), { seconds: true })}?`,
                                    body: `A new database, ${name.trim()}, is created from the base backup before that moment and replays the log up to it. That can take a while on a busy instance.`,
                                    label: "Recover",
                                    run: () =>
                                        actions.recoverDatabaseAction({
                                            databaseId: overview.id,
                                            target: moment.toISOString(),
                                            name: name.trim()
                                        })
                                })
                            }
                        >
                            Recover
                        </Button>
                    </div>
                </Section>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Copy data in
// ---------------------------------------------------------------------------

function CopySection({ overview, manage, ask }: { overview: Overview; manage: boolean; ask: Ask }) {
    const [from, setFrom] = useState<"managed" | "url">("managed");
    const [sources, setSources] = useState<{ id: string; name: string; where: string }[] | null>(null);
    const [sourceId, setSourceId] = useState("");
    const [url, setUrl] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!manage) return;
        let active = true;
        void actions.copySourcesAction(overview.id).then((result) => {
            if (!active) return;
            if (result.sources) setSources(result.sources);
            else setError(result.error ?? "Could not list the databases to copy from");
        });
        return () => {
            active = false;
        };
    }, [overview.id, manage]);

    if (!manage) return <p className="text-sm text-muted-foreground">Copying data in needs permission to manage databases.</p>;

    const parsed = core.databaseCopySchema.safeParse(
        from === "managed" ? { databaseId: overview.id, fromDatabaseId: sourceId || undefined } : { databaseId: overview.id, fromUrl: url.trim() || undefined }
    );
    const readable =
        from === "url" && url.trim() ? core.parseExternalSource(url.trim(), overview.engine) !== null : true;
    const sourceName = sources?.find((source) => source.id === sourceId)?.name;

    return (
        <Section
            title="Copy data in"
            hint={`Replaces everything in ${overview.name} with a copy of another database. A backup of ${overview.name} is taken first when it is protected.`}
        >
            <SegmentedControl
                aria-label="From"
                size="sm"
                value={from}
                onValueChange={setFrom}
                options={[
                    { value: "managed", label: "A database here" },
                    { value: "url", label: "A connection string" }
                ]}
            />
            {from === "managed" ? (
                sources === null && !error ? (
                    <Skeleton className="h-9 w-full" />
                ) : sources && sources.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No other {core.dbEngineLabel(overview.engine)} database in this project is running.</p>
                ) : (
                    <Select
                        value={sourceId}
                        onValueChange={setSourceId}
                        placeholder="Pick a database"
                        options={(sources ?? []).map((source) => ({ value: source.id, label: `${source.name} (${source.where})` }))}
                    />
                )
            ) : (
                <>
                    <Input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        placeholder={
                            overview.engine === "postgres"
                                ? "postgresql://user:password@host:5432/database"
                                : overview.engine === "mongo"
                                  ? "mongodb://user:password@host:27017/database"
                                  : overview.engine === "redis"
                                    ? "redis://:password@host:6379"
                                    : "mysql://user:password@host:3306/database"
                        }
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {!readable ? (
                        <p className="text-xs text-warning">
                            Use a {overview.engine === "postgres" ? "postgresql" : overview.engine === "mongo" ? "mongodb" : overview.engine}:// address with a host name and the database at the end.
                        </p>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            Read from inside this database's container, so the host has to be reachable from its server.
                        </p>
                    )}
                </>
            )}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            <div>
                <Button
                    size="sm"
                    disabled={!parsed.success || !readable}
                    onClick={() =>
                        ask({
                            title: `Replace the contents of ${overview.name}?`,
                            body: `Everything in ${overview.name} is replaced with a copy of ${from === "managed" ? (sourceName ?? "that database") : "the database at that address"}. Follow it under Activity.`,
                            label: "Copy",
                            danger: true,
                            run: () =>
                                actions.copyIntoDatabaseAction(
                                    from === "managed"
                                        ? { databaseId: overview.id, fromDatabaseId: sourceId }
                                        : { databaseId: overview.id, fromUrl: url.trim() }
                                )
                        })
                    }
                >
                    Copy
                </Button>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

type BucketList = NonNullable<Awaited<ReturnType<typeof actions.listBucketsAction>>>;
type Bucket = NonNullable<BucketList["buckets"]>[number];

const PRESIGN_LIFETIMES = [
    { value: "900", label: "15 minutes" },
    { value: "3600", label: "1 hour" },
    { value: "86400", label: "1 day" },
    { value: "604800", label: "7 days" }
];

function BucketsSection({ storeId, manage, ask }: { storeId: string; manage: boolean; ask: Ask }) {
    const [list, setList] = useState<BucketList | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [pending, startTransition] = useTransition();
    const [removing, setRemoving] = useState<Bucket | null>(null);

    const load = useCallback(async () => {
        const result = await actions.listBucketsAction(storeId);
        if (result.error) setError(result.error);
        else {
            setList(result);
            setError(null);
        }
    }, [storeId]);

    useEffect(() => {
        void load();
    }, [load]);

    const valid = core.bucketNameSchema.safeParse(name);

    function create() {
        setError(null);
        startTransition(async () => {
            const result = await actions.createBucketAction({ storeId, name: name.trim() });
            if (result.error) setError(result.error);
            else setName("");
            await load();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            {list?.endpoint ? (
                <Section
                    title="Endpoint"
                    hint="Reachable by name from the services in this environment. Its keys are in Connection details and in references such as S3_ENDPOINT."
                >
                    <CopyRow value={list.endpoint} />
                </Section>
            ) : null}
            {manage ? (
                <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-48 flex-1">
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="new-bucket" />
                        {name.trim() && !valid.success ? (
                            <p className="mt-1 text-xs text-warning">{valid.error.issues[0]?.message}</p>
                        ) : null}
                    </div>
                    <Button size="sm" disabled={!valid.success || pending} onClick={create}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Bucket
                    </Button>
                </div>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {list === null && !error ? <Skeleton className="h-24 w-full" /> : null}
            {list?.buckets?.length === 0 ? <p className="text-sm text-muted-foreground">No buckets yet.</p> : null}
            {list?.buckets?.map((bucket) => (
                <BucketCard key={bucket.id} bucket={bucket} manage={manage} ask={ask} onChanged={load} onRemove={() => setRemoving(bucket)} />
            ))}
            {list?.unmanaged && list.unmanaged.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    Also in the store, made outside Polaris: {list.unmanaged.join(", ")}.
                </p>
            ) : null}
            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="bucket"
                    description="Every object in it and every key for it goes. This cannot be undone."
                    confirmLabel="Remove bucket"
                    onConfirm={() => {
                        const target = removing;
                        setRemoving(null);
                        startTransition(async () => {
                            const result = await actions.deleteBucketAction(target.id);
                            if (result.error) setError(result.error);
                            await load();
                        });
                    }}
                />
            ) : null}
        </div>
    );
}

function BucketCard({
    bucket,
    manage,
    ask,
    onChanged,
    onRemove
}: {
    bucket: Bucket;
    manage: boolean;
    ask: Ask;
    onChanged: () => Promise<void>;
    onRemove: () => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [keyName, setKeyName] = useState("");
    const [access, setAccess] = useState<core.BucketAccess>("readwrite");
    const [secret, setSecret] = useState<{ accessKey: string; secretKey: string } | null>(null);
    const [prefix, setPrefix] = useState("");
    const [days, setDays] = useState("30");
    const [objectKey, setObjectKey] = useState("");
    const [method, setMethod] = useState<"GET" | "PUT">("GET");
    const [lifetime, setLifetime] = useState("3600");
    const [baseUrl, setBaseUrl] = useState("");
    const [signed, setSigned] = useState<string | null>(null);
    const [candidates, setCandidates] = useState<{ id: string; name: string; storeName: string }[] | null>(null);

    function run(work: () => Promise<{ error?: string }>, after?: () => void) {
        setError(null);
        startTransition(async () => {
            const result = await work();
            if (result.error) setError(result.error);
            else after?.();
            await onChanged();
        });
    }

    const keyValid = core.bucketKeySchema.safeParse({ bucketId: bucket.id, name: keyName, access });
    const ruleValid = core.lifecycleRuleSchema.safeParse({ bucketId: bucket.id, prefix, days: Number(days) });
    const presignValid = core.presignSchema.safeParse({
        bucketId: bucket.id,
        key: objectKey,
        method,
        expiresIn: Number(lifetime),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
    });

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-sm" title={bucket.name}>{bucket.name}</span>
                {manage ? (
                    <Button size="icon" variant="ghost" aria-label={`Remove ${bucket.name}`} title="Remove bucket" onClick={onRemove}>
                        <Trash2 className="size-4" />
                    </Button>
                ) : null}
            </div>
            {error ? <p className="text-xs text-danger">{error}</p> : null}

            <Section title="Keys" hint="Each reaches this bucket only.">
                {bucket.keys.length === 0 ? <p className="text-xs text-muted-foreground">No keys yet.</p> : null}
                {bucket.keys.map((key) => (
                    <div key={key.id} className="flex items-center gap-2 text-xs">
                        <KeyRound className="size-3.5 text-muted-foreground" />
                        <span className="font-medium">{key.name}</span>
                        <code className="font-mono text-muted-foreground">{key.accessKey}</code>
                        <Badge>{key.access === "readonly" ? "Read only" : "Read and write"}</Badge>
                        {manage ? (
                            <Button
                                size="icon"
                                variant="ghost"
                                className="ml-auto"
                                aria-label={`Revoke ${key.name}`}
                                title="Revoke key"
                                onClick={() =>
                                    ask({
                                        title: `Revoke ${key.name}?`,
                                        body: "Anything using this key loses access to the bucket at once.",
                                        label: "Revoke",
                                        danger: true,
                                        run: () => actions.deleteBucketKeyAction({ bucketId: bucket.id, keyId: key.id })
                                    })
                                }
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                        ) : null}
                    </div>
                ))}
                {secret ? (
                    <div className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 p-2">
                        <p className="text-xs text-warning">Copy the secret now. It is not shown again.</p>
                        <CopyRow value={secret.accessKey} />
                        <CopyRow value={secret.secretKey} />
                        <Button size="sm" variant="ghost" className="self-end" onClick={() => setSecret(null)}>
                            Done
                        </Button>
                    </div>
                ) : null}
                {manage ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="key-name" className="w-40" />
                        <div className="w-40">
                            <Select
                                value={access}
                                onValueChange={(value) => setAccess(value as core.BucketAccess)}
                                options={[
                                    { value: "readwrite", label: "Read and write" },
                                    { value: "readonly", label: "Read only" }
                                ]}
                            />
                        </div>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={!keyValid.success || pending}
                            onClick={() =>
                                run(
                                    async () => {
                                        const result = await actions.createBucketKeyAction({ bucketId: bucket.id, name: keyName.trim(), access });
                                        if (result.accessKey && result.secretKey) {
                                            setSecret({ accessKey: result.accessKey, secretKey: result.secretKey });
                                        }
                                        return result;
                                    },
                                    () => setKeyName("")
                                )
                            }
                        >
                            New key
                        </Button>
                    </div>
                ) : null}
            </Section>

            <Section title="Expiry" hint="Objects written under a prefix from now on are deleted at that age.">
                {bucket.lifecycle.map((rule) => (
                    <div key={rule.prefix} className="flex items-center gap-2 text-xs">
                        <code className="font-mono">{rule.prefix || "(whole bucket)"}</code>
                        <span className="text-muted-foreground">after {rule.days === 1 ? "1 day" : `${rule.days} days`}</span>
                        {manage ? (
                            <Button
                                size="icon"
                                variant="ghost"
                                className="ml-auto"
                                aria-label="Remove rule"
                                title="Remove rule"
                                disabled={pending}
                                onClick={() => run(() => actions.removeLifecycleRuleAction({ bucketId: bucket.id, prefix: rule.prefix }))}
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                        ) : null}
                    </div>
                ))}
                {manage ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="tmp/ (blank for all)" className="w-44" />
                        <div className="w-36">
                            <Select
                                value={days}
                                onValueChange={setDays}
                                options={core.LIFECYCLE_DAYS.map((value) => ({
                                    value: String(value),
                                    label: value === 1 ? "After 1 day" : `After ${value} days`
                                }))}
                            />
                        </div>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={!ruleValid.success || pending}
                            onClick={() =>
                                run(() => actions.setLifecycleRuleAction({ bucketId: bucket.id, prefix: prefix.trim(), days: Number(days) }), () => setPrefix(""))
                            }
                        >
                            Add rule
                        </Button>
                    </div>
                ) : null}
            </Section>

            {manage ? (
                <Section title="Presigned URL" hint="Lets whoever holds it download or upload one object until it expires, without a key.">
                    <div className="flex flex-wrap items-center gap-2">
                        <Input value={objectKey} onChange={(event) => setObjectKey(event.target.value)} placeholder="path/to/file.png" className="min-w-48 flex-1" />
                        <div className="w-32">
                            <Select
                                value={method}
                                onValueChange={(value) => setMethod(value as "GET" | "PUT")}
                                options={[
                                    { value: "GET", label: "Download" },
                                    { value: "PUT", label: "Upload" }
                                ]}
                            />
                        </div>
                        <div className="w-32">
                            <Select value={lifetime} onValueChange={setLifetime} options={PRESIGN_LIFETIMES} />
                        </div>
                    </div>
                    <Input
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder="Address it is used on, if not inside the environment (https://files.example.com)"
                    />
                    <div>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={!presignValid.success || pending}
                            onClick={() =>
                                run(async () => {
                                    const result = await actions.presignObjectAction({
                                        bucketId: bucket.id,
                                        key: objectKey.trim(),
                                        method,
                                        expiresIn: Number(lifetime),
                                        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
                                    });
                                    if (result.url) setSigned(result.url);
                                    return result;
                                })
                            }
                        >
                            <Link2 className="size-4" /> Sign
                        </Button>
                    </div>
                    {signed ? <CopyRow value={signed} /> : null}
                </Section>
            ) : null}

            <Section
                title="Replication"
                hint="Every change is copied, one way, into a bucket of another store on the same server."
            >
                {bucket.replicateTo ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span>
                            Into <span className="font-mono">{bucket.replicateTo.name}</span> in {bucket.replicateTo.storeName}
                        </span>
                        <Badge variant={bucket.replicationState === "failed" ? "danger" : "success"}>
                            {bucket.replicationState === "failed" ? "Stopped" : "Running"}
                        </Badge>
                        {manage ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => run(() => actions.setBucketReplicationAction({ bucketId: bucket.id, toBucketId: null }))}
                            >
                                Stop
                            </Button>
                        ) : null}
                    </div>
                ) : null}
                {bucket.replicationError ? <p className="text-xs text-danger">{bucket.replicationError}</p> : null}
                {manage && !bucket.replicateTo ? (
                    candidates === null ? (
                        <div>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    void actions.replicationCandidatesAction(bucket.id).then((result) => {
                                        if (result.candidates) setCandidates(result.candidates);
                                        else setError(result.error ?? "Could not list the buckets to replicate into");
                                    })
                                }
                            >
                                Replicate...
                            </Button>
                        </div>
                    ) : candidates.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            No bucket in another store on this server. Create a second object store here first.
                        </p>
                    ) : (
                        <Select
                            value=""
                            placeholder="Replicate into..."
                            onValueChange={(toBucketId) => run(() => actions.setBucketReplicationAction({ bucketId: bucket.id, toBucketId }))}
                            options={candidates.map((candidate) => ({
                                value: candidate.id,
                                label: `${candidate.name} (${candidate.storeName})`
                            }))}
                        />
                    )
                ) : null}
            </Section>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
    restore: "Restore",
    upgrade: "Upgrade",
    copy: "Copy",
    recover: "Recovery",
    setup: "Setup",
    archive: "Archive"
};

function ActivityList({ overview, compact }: { overview: Overview; compact: boolean }) {
    const format = useDisplayFormat();
    const rows = compact ? overview.operations.filter((operation) => operation.status === "running") : overview.operations;
    if (rows.length === 0) {
        return compact ? null : <p className="text-sm text-muted-foreground">Nothing has been run on this database yet.</p>;
    }
    return (
        <ul className="flex flex-col gap-2">
            {rows.map((operation) => (
                <li key={operation.id} className="rounded-md border border-border px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{KIND_LABEL[operation.kind] ?? operation.kind}</span>
                        <Badge
                            variant={operation.status === "failed" ? "danger" : operation.status === "running" ? "neutral" : "success"}
                        >
                            {operation.status === "running" ? "Running" : operation.status === "failed" ? "Failed" : "Done"}
                        </Badge>
                        <span className="ml-auto text-muted-foreground">{format.dateTime(operation.startedAt)}</span>
                    </div>
                    {operation.status === "running" ? (
                        <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" /> {operation.step}
                            {operation.doneBytes > 0
                                ? ` - ${core.formatBytes(BigInt(operation.doneBytes))}${operation.totalBytes ? ` of ${core.formatBytes(BigInt(operation.totalBytes))}` : ""}`
                                : ""}
                        </p>
                    ) : null}
                    {operation.error ? <p className="mt-1 text-danger">{operation.error}</p> : null}
                </li>
            ))}
        </ul>
    );
}
