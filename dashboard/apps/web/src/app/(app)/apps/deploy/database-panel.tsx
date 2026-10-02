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
import { LikelyCause } from "./likely-cause";
import * as actions from "./database-actions";
import { useProjectCan } from "./access-context";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { PrivateNetworkPanel } from "./private-network-panel";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import { KeyRound, Link2, Loader2, Maximize2, Minimize2, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { DatabaseWorkspace } from "./database-workspace";
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
    Switch,
    cn
} from "@polaris/ui";

type Overview = NonNullable<Awaited<ReturnType<typeof actions.databaseOverviewAction>>["overview"]>;
type Tab = "database" | "versions" | "settings" | "network" | "pitr" | "copy" | "buckets" | "activity";

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
    const t = useTranslations("deployData");
    const can = useProjectCan();
    const manage = can("databases.manage");
    const [overview, setOverview] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("database");
    const [full, setFull] = useState(false);
    const [confirm, setConfirm] = useState<Confirmation | null>(null);
    const [confirmError, setConfirmError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(async () => {
        const result = await actions.databaseOverviewAction(database.id);
        if (result.overview) {
            setOverview(result.overview);
            setError(null);
        } else setError(result.error ?? t("database.unreadable"));
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
              // The data itself first, as the Database tab is on Railway: the
              // rest of this panel is about the instance around it.
              ...(!overview.storage && core.isDbEngine(overview.engine)
                  ? [{ value: "database" as const, label: t("database.tabs.database") }]
                  : []),
              ...(overview.upgrade
                  ? [{ value: "versions" as const, label: t("database.tabs.version") }]
                  : []),
              ...(overview.redis || overview.mongo || overview.limits || overview.topology
                  ? [{ value: "settings" as const, label: t("database.tabs.settings") }]
                  : []),
              // A database inside another instance is reached through that one's container.
              ...(!overview.hosted
                  ? [{ value: "network" as const, label: t("database.tabs.network") }]
                  : []),
              ...(overview.pitr
                  ? [{ value: "pitr" as const, label: t("database.tabs.pitr") }]
                  : []),
              // A cluster's keys are spread over its masters; one dump cannot be loaded into it.
              ...(!overview.storage && !overview.redis?.clusterMasters
                  ? [{ value: "copy" as const, label: t("database.tabs.copy") }]
                  : []),
              ...(overview.storage
                  ? [{ value: "buckets" as const, label: t("database.tabs.buckets") }]
                  : []),
              { value: "activity" as const, label: t("database.tabs.activity") }
          ]
        : [];
    const current = tabs.some((entry) => entry.value === tab)
        ? tab
        : (tabs[0]?.value ?? "activity");

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
            <DialogContent
                className={cn(
                    "right-0 left-auto top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto overscroll-contain rounded-none rounded-l-xl border-y-0 border-r-0 data-[state=open]:slide-in-from-right-4",
                    full ? "w-full max-w-none" : "w-full max-w-none sm:w-[920px] sm:max-w-[calc(100vw-2rem)]"
                )}
            >
                <button
                    type="button"
                    onClick={() => setFull((value) => !value)}
                    title={full ? t("database.exitFullScreen") : t("database.fullScreen")}
                    aria-label={full ? t("database.exitFullScreen") : t("database.fullScreen")}
                    className="absolute right-12 top-4 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </button>
                <DialogHeader className="pr-20">
                    <DialogTitle className="flex items-center gap-2">
                        <DbEngineIcon engine={database.engine} className="size-6" />
                        <span className="truncate" title={database.name}>
                            {database.name}
                        </span>
                        {overview ? (
                            <Badge>
                                {core.dbEngineLabel(overview.engine)} {overview.version}
                            </Badge>
                        ) : null}
                        {overview?.topology ? <Badge>{overview.topology.label}</Badge> : null}
                    </DialogTitle>
                    {overview?.hosted ? (
                        <DialogDescription>
                            {t("database.hosted", {
                                host: overview.hostName ?? t("database.anotherInstance")
                            })}
                        </DialogDescription>
                    ) : overview?.recovery ? (
                        <DialogDescription>
                            {t("database.recovered", {
                                from: overview.recovery.from ?? t("database.removedInstance")
                            })}
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
                        {overview.failedDeploymentId ? (
                            <LikelyCause
                                deploymentId={overview.failedDeploymentId}
                                canConfigure={false}
                                canSetVariables={false}
                                onFixed={() => void load()}
                            />
                        ) : null}
                        {tabs.length > 1 ? (
                            <ScrollRow>
                                <SegmentedControl
                                    aria-label={t("database.section")}
                                    size="sm"
                                    value={current}
                                    onValueChange={setTab}
                                    options={tabs}
                                />
                            </ScrollRow>
                        ) : null}
                        {current === "database" ? (
                            <DatabaseWorkspace
                                database={database}
                                deployed={overview.deployed}
                                manage={manage}
                                hosted={overview.hosted}
                            />
                        ) : !overview.deployed && current !== "activity" ? (
                            <p className="text-sm text-muted-foreground">
                                {t("database.provisionFirst")}
                            </p>
                        ) : current === "versions" && overview.upgrade ? (
                            <VersionsSection
                                overview={overview}
                                manage={manage}
                                ask={ask}
                                onChanged={load}
                            />
                        ) : current === "settings" ? (
                            <div className="flex flex-col gap-5">
                                {overview.topology ? <ClusterSection overview={overview} /> : null}
                                <LimitsSection overview={overview} manage={manage} ask={ask} />
                                <SettingsSection overview={overview} manage={manage} ask={ask} />
                            </div>
                        ) : current === "network" ? (
                            <PrivateNetworkPanel kind="database" id={database.id} />
                        ) : current === "pitr" && overview.pitr ? (
                            <PitrSection overview={overview} manage={manage} ask={ask} />
                        ) : current === "copy" ? (
                            <CopySection overview={overview} manage={manage} ask={ask} />
                        ) : current === "buckets" ? (
                            <BucketsSection storeId={overview.id} manage={manage} ask={ask} />
                        ) : null}
                        {current === "activity" || running ? (
                            <ActivityList overview={overview} compact={current !== "activity"} />
                        ) : null}
                    </div>
                ) : null}

                {confirm ? (
                    <Dialog open onOpenChange={(value) => !value && setConfirm(null)}>
                        <DialogContent className="max-w-md">
                            <DialogHeader>
                                <DialogTitle>{confirm.title}</DialogTitle>
                                <DialogDescription>{confirm.body}</DialogDescription>
                            </DialogHeader>
                            {confirmError ? (
                                <p className="text-sm text-danger">{confirmError}</p>
                            ) : null}
                            <DialogFooter>
                                <Button variant="ghost" onClick={() => setConfirm(null)}>
                                    {t("database.cancel")}
                                </Button>
                                <Button
                                    variant={confirm.danger ? "danger" : "primary"}
                                    disabled={pending}
                                    onClick={agree}
                                >
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

function Section({
    title,
    hint,
    children
}: {
    title: string;
    hint?: ReactNode;
    children: ReactNode;
}) {
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
    const t = useTranslations("deployData");
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
    const caveat = refresh ? null : core.dbVersionCaveat(overview.engine, version);
    const options = [
        {
            value: overview.version,
            label: t("database.versions.newestRelease", {
                engine: label,
                version: overview.version
            })
        },
        ...upgrade.versions.map((entry) => ({ value: entry, label: `${label} ${entry}` }))
    ];

    function start() {
        const at = when === "later" && moment ? moment.toISOString() : undefined;
        const runsAt = at ? t("database.versions.runsAt", { time: format.dateTime(at) }) : "";
        ask({
            title: at
                ? t("database.versions.scheduleTitle", { engine: label, version })
                : refresh
                  ? t("database.versions.refreshTitle", { version })
                  : t("database.versions.upgradeTitle", { engine: label, version }),
            body: refresh
                ? overview.topology
                    ? t("database.versions.refreshMembers")
                    : t("database.versions.refreshInstance")
                : overview.topology?.kind === "replicaSet"
                  ? t("database.versions.replicaSet", {
                        engine: label,
                        version,
                        current: overview.version
                    }) + runsAt
                  : overview.storage
                    ? t("database.versions.store", { version, current: overview.version })
                    : t("database.versions.dumpRestore", {
                          engine: label,
                          version,
                          current: overview.version
                      }) + runsAt,
            label: at
                ? t("database.versions.schedule")
                : refresh
                  ? t("database.versions.update")
                  : t("database.versions.upgrade"),
            run: () =>
                actions.upgradeDatabaseAction({
                    databaseId: overview.id,
                    version,
                    ...(at ? { at } : {})
                })
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
                        {t("database.versions.movingAt", {
                            engine: label,
                            version: upgrade.to ?? "",
                            time: format.dateTime(upgrade.at)
                        })}
                    </span>
                    {manage ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
                            {t("database.versions.cancelIt")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {upgrade.state === "running" || upgrade.state === "starting" ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />{" "}
                    {t("database.versions.moving", { engine: label, version: upgrade.to ?? "" })}
                </p>
            ) : null}
            {upgrade.state === "failed" && upgrade.error ? (
                <p className="rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-xs text-danger-ink">
                    {t("database.versions.failed", { error: upgrade.error })}
                </p>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {manage && upgrade.state !== "running" && upgrade.state !== "starting" ? (
                <Section
                    title={t("database.versions.change")}
                    hint={
                        upgrade.versions.length === 0
                            ? t("database.versions.newestOffered", { engine: label })
                            : t("database.versions.onlyNewer")
                    }
                >
                    <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-56 flex-1">
                            <Select value={version} onValueChange={setVersion} options={options} />
                        </div>
                        <SegmentedControl
                            aria-label={t("database.versions.when")}
                            value={when}
                            onValueChange={setWhen}
                            options={[
                                { value: "now", label: t("database.versions.now") },
                                { value: "later", label: t("database.versions.later") }
                            ]}
                        />
                    </div>
                    {when === "later" ? (
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("database.versions.startAt")}
                            <Input
                                type="datetime-local"
                                value={at}
                                onChange={(event) => setAt(event.target.value)}
                                className="w-64"
                            />
                        </label>
                    ) : null}
                    {caveat ? <p className="text-xs text-muted-foreground">{caveat}</p> : null}
                    <div>
                        <Button
                            size="sm"
                            disabled={
                                when === "later" &&
                                (!moment || moment.getTime() < Date.now() + 60_000)
                            }
                            onClick={start}
                        >
                            {when === "later"
                                ? t("database.versions.schedule")
                                : refresh
                                  ? t("database.versions.update")
                                  : t("database.versions.upgrade")}
                        </Button>
                    </div>
                </Section>
            ) : null}

            {manage && upgrade.previousVersion && upgrade.previousVolume ? (
                <Section
                    title={t("database.versions.previousKept", {
                        engine: label,
                        version: upgrade.previousVersion
                    })}
                    hint={t("database.versions.previousHint", { volume: upgrade.previousVolume })}
                >
                    <div>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                                ask({
                                    title: t("database.versions.revertTitle", {
                                        engine: label,
                                        version: upgrade.previousVersion ?? ""
                                    }),
                                    body: t("database.versions.revertBody", {
                                        version: upgrade.previousVersion ?? ""
                                    }),
                                    label: t("database.versions.goBack"),
                                    danger: true,
                                    run: () => actions.revertUpgradeAction(overview.id)
                                })
                            }
                        >
                            <RotateCcw className="size-4" /> {t("database.versions.goBack")}
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

type MemberState = NonNullable<
    Awaited<ReturnType<typeof actions.databaseMembersAction>>["members"]
>[number];

const ROLE_LABELS: Readonly<Record<string, NamespaceKey<"deployData">>> = {
    member: "database.roles.member",
    config: "database.roles.config",
    shard: "database.roles.shard",
    router: "database.roles.router",
    primary: "database.roles.primary",
    replica: "database.roles.replica"
};

/** What upkeep does for each layout, said where somebody looks for it. */
const TOPOLOGY_NOTES: Readonly<Record<string, NamespaceKey<"deployData">>> = {
    replicaSet: "database.topology.replicaSet",
    sharded: "database.topology.sharded",
    replicas: "database.topology.replicas"
};

/**
 * The members of a database laid out over several containers, each with what
 * it is doing now - read from the members when the panel opens, and again on
 * request. The names and roles are known up front, so they show at once and
 * only the states wait.
 */
function ClusterSection({ overview }: { overview: Overview }) {
    const t = useTranslations("deployData");
    const topology = overview.topology!;
    const note = TOPOLOGY_NOTES[topology.kind];
    const [states, setStates] = useState<Map<string, MemberState> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const check = useCallback(() => {
        startTransition(async () => {
            const result = await actions.databaseMembersAction(overview.id);
            if (result.members) {
                setStates(new Map(result.members.map((member) => [member.name, member])));
                setError(null);
            } else setError(result.error ?? t("database.membersUnreadable"));
        });
    }, [overview.id]);

    useEffect(() => {
        check();
    }, [check]);

    return (
        <Section title={topology.label} hint={note ? t(note) : undefined}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                    {t("database.containers", { count: topology.members.length })}
                </span>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("database.checkMembers")}
                    title={t("database.checkMembers")}
                    disabled={pending}
                    onClick={check}
                >
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <RefreshCw className="size-4" />
                    )}
                </Button>
            </div>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {topology.members.map((member) => {
                    const state = states?.get(member.name);
                    return (
                        <li
                            key={member.name}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate font-mono text-xs" title={member.name}>
                                    {member.name}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {ROLE_LABELS[member.role]
                                        ? t(ROLE_LABELS[member.role]!)
                                        : member.role}
                                    {member.set && member.role !== "member"
                                        ? ` - ${member.set}`
                                        : ""}
                                </span>
                            </span>
                            {state ? (
                                <span
                                    className={`text-xs ${state.healthy ? "text-success" : "text-warning"}`}
                                >
                                    {state.state}
                                </span>
                            ) : error ? null : (
                                <Skeleton className="h-4 w-20" />
                            )}
                        </li>
                    );
                })}
            </ul>
        </Section>
    );
}

/** The most CPU and memory the instance's container may use, applied by
 *  starting it again. Blank is no limit. */
function LimitsSection({
    overview,
    manage,
    ask
}: {
    overview: Overview;
    manage: boolean;
    ask: Ask;
}) {
    const t = useTranslations("deployData");
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
        <Section
            title={t("database.limits.title")}
            hint={
                (overview.topology ? t("database.limits.eachMember") : "") +
                t("database.limits.hint")
            }
        >
            <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">
                        {t("database.limits.cpus")}
                    </span>
                    <Input
                        type="number"
                        min={0.05}
                        step={0.05}
                        value={cpus}
                        disabled={!manage}
                        onChange={(event) => setCpus(event.target.value)}
                        placeholder={t("database.limits.noLimit")}
                        className="w-28"
                    />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">
                        {t("database.limits.memory")}
                    </span>
                    <Input
                        type="number"
                        min={16}
                        step={64}
                        value={memory}
                        disabled={!manage}
                        onChange={(event) => setMemory(event.target.value)}
                        placeholder={t("database.limits.noLimit")}
                        className="w-28"
                    />
                </label>
            </div>
            {!parsed.success ? (
                <p className="text-xs text-danger">
                    {parsed.error.issues[0]?.message ?? t("database.limits.check")}
                </p>
            ) : null}
            {manage ? (
                <div>
                    <Button
                        size="sm"
                        disabled={!changed || !parsed.success}
                        onClick={() =>
                            ask({
                                title: t("database.limits.confirmTitle"),
                                body: t("database.limits.confirmBody"),
                                label: t("database.apply"),
                                run: () =>
                                    actions.setDatabaseLimitsAction({
                                        databaseId: overview.id,
                                        ...next
                                    })
                            })
                        }
                    >
                        {t("database.apply")}
                    </Button>
                </div>
            ) : null}
        </Section>
    );
}

function SettingsSection({
    overview,
    manage,
    ask
}: {
    overview: Overview;
    manage: boolean;
    ask: Ask;
}) {
    const t = useTranslations("deployData");
    const redis = overview.redis;
    const mongo = overview.mongo;
    const [mode, setMode] = useState<core.RedisMode>((redis?.mode as core.RedisMode) ?? "default");
    const [size, setSize] = useState(String(redis?.maxMemoryMb ?? 256));

    if (redis) {
        const changed =
            mode !== redis.mode ||
            (mode === "cache" && Number(size) !== (redis.maxMemoryMb ?? 256));
        const masters = redis.clusterMasters;
        return (
            <>
                {masters ? (
                    <Section
                        title={t("database.redis.cluster")}
                        hint={t("database.redis.clusterHint", { masters })}
                    >
                        <p className="text-xs text-muted-foreground">
                            {t("database.redis.clusterBackup")}
                        </p>
                    </Section>
                ) : null}
                <Section title={t("database.redis.title")} hint={t(`database.redis.notes.${mode}`)}>
                    <SegmentedControl
                        aria-label={t("database.redis.mode")}
                        value={mode}
                        onValueChange={setMode}
                        options={core.REDIS_MODES.map((value) => ({
                            value,
                            label: t(`database.redis.labels.${value}`)
                        }))}
                    />
                    {mode === "cache" ? (
                        <div className="w-48">
                            <Select
                                value={size}
                                onValueChange={setSize}
                                options={core.REDIS_CACHE_SIZES_MB.map((value) => ({
                                    value: String(value),
                                    label:
                                        value >= 1024
                                            ? t("database.redis.limitGb", { size: value / 1024 })
                                            : t("database.redis.limitMb", { size: value })
                                }))}
                            />
                        </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{t("database.redis.pubsub")}</p>
                    {manage ? (
                        <div>
                            <Button
                                size="sm"
                                disabled={!changed}
                                onClick={() =>
                                    ask({
                                        title: t(`database.redis.switchTitle.${mode}`),
                                        body:
                                            (masters ? t("database.redis.everyNode") : "") +
                                            t(`database.redis.switchBody.${mode}`),
                                        label: t("database.redis.switch"),
                                        run: () =>
                                            actions.setRedisModeAction({
                                                databaseId: overview.id,
                                                mode,
                                                ...(mode === "cache"
                                                    ? { maxMemoryMb: Number(size) }
                                                    : {})
                                            })
                                    })
                                }
                            >
                                {t("database.apply")}
                            </Button>
                        </div>
                    ) : null}
                </Section>
            </>
        );
    }

    if (mongo) {
        return (
            <Section title={t("database.mongo.title")} hint={t("database.mongo.hint")}>
                <label className="flex items-center gap-2 text-sm">
                    <Switch
                        checked={mongo.replicaSet}
                        disabled={!manage}
                        onChange={(enabled) =>
                            ask({
                                title: enabled
                                    ? t("database.mongo.onTitle")
                                    : t("database.mongo.offTitle"),
                                body: enabled
                                    ? t("database.mongo.onBody")
                                    : t("database.mongo.offBody"),
                                label: enabled ? t("database.turnOn") : t("database.turnOff"),
                                danger: !enabled,
                                run: () =>
                                    actions.setMongoReplicaSetAction({
                                        databaseId: overview.id,
                                        enabled
                                    })
                            })
                        }
                    />
                    {mongo.replicaSet ? t("database.on") : t("database.off")}
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
    const t = useTranslations("deployData");
    const format = useDisplayFormat();
    const pitr = overview.pitr!;
    const [keepDays, setKeepDays] = useState(String(pitr.keepDays));
    const [target, setTarget] = useState("");
    const [name, setName] = useState(`${overview.name}-recovered`);
    const moment = fromLocalInput(target);
    const earliest = pitr.from ? new Date(pitr.from) : null;
    const inWindow = Boolean(
        moment && earliest && moment >= earliest && moment.getTime() <= Date.now()
    );

    return (
        <div className="flex flex-col gap-4">
            <Section title={t("database.pitr.title")} hint={t("database.pitr.hint")}>
                <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={pitr.enabled}
                            disabled={!manage}
                            onChange={(enabled) =>
                                ask({
                                    title: enabled
                                        ? t("database.pitr.onTitle")
                                        : t("database.pitr.offTitle"),
                                    body: enabled
                                        ? t("database.pitr.onBody")
                                        : t("database.pitr.offBody"),
                                    label: enabled ? t("database.turnOn") : t("database.turnOff"),
                                    danger: !enabled,
                                    run: () =>
                                        actions.setPitrAction({
                                            databaseId: overview.id,
                                            enabled,
                                            keepDays: Number(keepDays)
                                        })
                                })
                            }
                        />
                        {pitr.enabled ? t("database.on") : t("database.off")}
                    </label>
                    <div className="w-40">
                        <Select
                            value={keepDays}
                            disabled={!manage}
                            onValueChange={(value) => {
                                setKeepDays(value);
                                if (pitr.enabled) {
                                    void actions.setPitrAction({
                                        databaseId: overview.id,
                                        enabled: true,
                                        keepDays: Number(value)
                                    });
                                }
                            }}
                            options={core.PITR_KEEP_DAYS.map((days) => ({
                                value: String(days),
                                label: t("database.pitr.keepDays", { count: days })
                            }))}
                        />
                    </div>
                </div>
                {pitr.enabled ? (
                    <p className="text-xs text-muted-foreground">
                        {pitr.from
                            ? t("database.pitr.window", {
                                  from: format.dateTime(pitr.from),
                                  count: pitr.baseBackups.length
                              })
                            : t("database.pitr.firstBackup")}
                    </p>
                ) : null}
            </Section>

            {pitr.enabled && pitr.from && manage ? (
                <Section
                    title={t("database.pitr.recoverTitle")}
                    hint={t("database.pitr.recoverHint")}
                >
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("database.pitr.moment")}
                            <Input
                                type="datetime-local"
                                step={1}
                                value={target}
                                onChange={(event) => setTarget(event.target.value)}
                                className="w-64"
                            />
                        </label>
                        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            {t("database.pitr.newName")}
                            <Input value={name} onChange={(event) => setName(event.target.value)} />
                        </label>
                    </div>
                    {moment && !inWindow ? (
                        <p className="text-xs text-warning">{t("database.pitr.outsideWindow")}</p>
                    ) : null}
                    <div>
                        <Button
                            size="sm"
                            disabled={!inWindow || !name.trim()}
                            onClick={() =>
                                moment &&
                                ask({
                                    title: t("database.pitr.confirmTitle", {
                                        name: overview.name,
                                        time: format.dateTime(moment.toISOString(), {
                                            seconds: true
                                        })
                                    }),
                                    body: t("database.pitr.confirmBody", { name: name.trim() }),
                                    label: t("database.pitr.recover"),
                                    run: () =>
                                        actions.recoverDatabaseAction({
                                            databaseId: overview.id,
                                            target: moment.toISOString(),
                                            name: name.trim()
                                        })
                                })
                            }
                        >
                            {t("database.pitr.recover")}
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
    const t = useTranslations("deployData");
    const [from, setFrom] = useState<"managed" | "url">("managed");
    const [sources, setSources] = useState<{ id: string; name: string; where: string }[] | null>(
        null
    );
    const [sourceId, setSourceId] = useState("");
    const [url, setUrl] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!manage) return;
        let active = true;
        void actions.copySourcesAction(overview.id).then((result) => {
            if (!active) return;
            if (result.sources) setSources(result.sources);
            else setError(result.error ?? t("database.copy.sourcesUnreadable"));
        });
        return () => {
            active = false;
        };
    }, [overview.id, manage]);

    if (!manage)
        return (
            <p className="text-sm text-muted-foreground">{t("database.copy.needsPermission")}</p>
        );

    const parsed = core.databaseCopySchema.safeParse(
        from === "managed"
            ? { databaseId: overview.id, fromDatabaseId: sourceId || undefined }
            : { databaseId: overview.id, fromUrl: url.trim() || undefined }
    );
    const readable =
        from === "url" && url.trim()
            ? core.parseExternalSource(url.trim(), overview.engine) !== null
            : true;
    const sourceName = sources?.find((source) => source.id === sourceId)?.name;

    return (
        <Section
            title={t("database.tabs.copy")}
            hint={t("database.copy.hint", { name: overview.name })}
        >
            <SegmentedControl
                aria-label={t("database.copy.from")}
                size="sm"
                value={from}
                onValueChange={setFrom}
                options={[
                    { value: "managed", label: t("database.copy.managed") },
                    { value: "url", label: t("database.copy.url") }
                ]}
            />
            {from === "managed" ? (
                sources === null && !error ? (
                    <Skeleton className="h-9 w-full" />
                ) : sources && sources.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {t("database.copy.noOther", {
                            engine: core.dbEngineLabel(overview.engine)
                        })}
                    </p>
                ) : (
                    <Select
                        value={sourceId}
                        onValueChange={setSourceId}
                        placeholder={t("database.copy.pick")}
                        options={(sources ?? []).map((source) => ({
                            value: source.id,
                            label: `${source.name} (${source.where})`
                        }))}
                    />
                )
            ) : (
                <>
                    <Input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        // i18n-ignore: example connection strings
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
                            {t("database.copy.useScheme", {
                                scheme:
                                    overview.engine === "postgres"
                                        ? "postgresql"
                                        : overview.engine === "mongo"
                                          ? "mongodb"
                                          : overview.engine
                            })}
                        </p>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            {t("database.copy.readInside")}
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
                            title: t("database.copy.confirmTitle", { name: overview.name }),
                            body: t("database.copy.confirmBody", {
                                name: overview.name,
                                source:
                                    from === "managed"
                                        ? (sourceName ?? t("database.copy.thatDatabase"))
                                        : t("database.copy.thatAddress")
                            }),
                            label: t("database.copy.copy"),
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
                    {t("database.copy.copy")}
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
    { value: "900", label: "database.buckets.lifetimes.minutes15" },
    { value: "3600", label: "database.buckets.lifetimes.hour1" },
    { value: "86400", label: "database.buckets.lifetimes.day1" },
    { value: "604800", label: "database.buckets.lifetimes.days7" }
] as const;

function BucketsSection({ storeId, manage, ask }: { storeId: string; manage: boolean; ask: Ask }) {
    const t = useTranslations("deployData");
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
                    title={t("database.buckets.endpoint")}
                    hint={t("database.buckets.endpointHint")}
                >
                    <CopyRow value={list.endpoint} />
                </Section>
            ) : null}
            {manage ? (
                <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-48 flex-1">
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)} // i18n-ignore: an example bucket name
                            placeholder="new-bucket"
                        />
                        {name.trim() && !valid.success ? (
                            <p className="mt-1 text-xs text-warning">
                                {valid.error.issues[0]?.message}
                            </p>
                        ) : null}
                    </div>
                    <Button size="sm" disabled={!valid.success || pending} onClick={create}>
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Plus className="size-4" />
                        )}{" "}
                        {t("database.buckets.add")}
                    </Button>
                </div>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {list === null && !error ? <Skeleton className="h-24 w-full" /> : null}
            {list?.buckets?.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("database.buckets.empty")}</p>
            ) : null}
            {list?.buckets?.map((bucket) => (
                <BucketCard
                    key={bucket.id}
                    bucket={bucket}
                    manage={manage}
                    ask={ask}
                    onChanged={load}
                    onRemove={() => setRemoving(bucket)}
                />
            ))}
            {list?.unmanaged && list.unmanaged.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t("database.buckets.unmanaged", { names: list.unmanaged.join(", ") })}
                </p>
            ) : null}
            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="bucket"
                    title={t("database.buckets.deleteTitle")}
                    description={t("database.buckets.removeDescription")}
                    confirmLabel={t("database.buckets.remove")}
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
    const t = useTranslations("deployData");
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
    const [candidates, setCandidates] = useState<
        { id: string; name: string; storeName: string }[] | null
    >(null);

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
    const ruleValid = core.lifecycleRuleSchema.safeParse({
        bucketId: bucket.id,
        prefix,
        days: Number(days)
    });
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
                <span className="truncate font-mono text-sm" title={bucket.name}>
                    {bucket.name}
                </span>
                {manage ? (
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("database.buckets.removeNamed", { name: bucket.name })}
                        title={t("database.buckets.remove")}
                        onClick={onRemove}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                ) : null}
            </div>
            {error ? <p className="text-xs text-danger">{error}</p> : null}

            <Section title={t("database.buckets.keys")} hint={t("database.buckets.keysHint")}>
                {bucket.keys.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("database.buckets.noKeys")}</p>
                ) : null}
                {bucket.keys.map((key) => (
                    <div key={key.id} className="flex items-center gap-2 text-xs">
                        <KeyRound className="size-3.5 text-muted-foreground" />
                        <span className="font-medium">{key.name}</span>
                        <code className="font-mono text-muted-foreground">{key.accessKey}</code>
                        <Badge>
                            {key.access === "readonly"
                                ? t("database.buckets.readOnly")
                                : t("database.buckets.readWrite")}
                        </Badge>
                        {manage ? (
                            <Button
                                size="icon"
                                variant="ghost"
                                className="ml-auto"
                                aria-label={t("database.buckets.revokeNamed", { name: key.name })}
                                title={t("database.buckets.revokeKey")}
                                onClick={() =>
                                    ask({
                                        title: t("database.buckets.revokeTitle", {
                                            name: key.name
                                        }),
                                        body: t("database.buckets.revokeBody"),
                                        label: t("database.buckets.revoke"),
                                        danger: true,
                                        run: () =>
                                            actions.deleteBucketKeyAction({
                                                bucketId: bucket.id,
                                                keyId: key.id
                                            })
                                    })
                                }
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                        ) : null}
                    </div>
                ))}
                {secret ? (
                    <div className="flex flex-col gap-1 rounded-md border border-warning-edge bg-warning-soft p-2">
                        <p className="text-xs text-warning">{t("database.buckets.copySecret")}</p>
                        <CopyRow value={secret.accessKey} />
                        <CopyRow value={secret.secretKey} />
                        <Button
                            size="sm"
                            variant="ghost"
                            className="self-end"
                            onClick={() => setSecret(null)}
                        >
                            {t("database.buckets.done")}
                        </Button>
                    </div>
                ) : null}
                {manage ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={keyName}
                            onChange={(event) => setKeyName(event.target.value)} // i18n-ignore: an example key name
                            placeholder="key-name"
                            className="w-40"
                        />
                        <div className="w-40">
                            <Select
                                value={access}
                                onValueChange={(value) => setAccess(value as core.BucketAccess)}
                                options={[
                                    { value: "readwrite", label: t("database.buckets.readWrite") },
                                    { value: "readonly", label: t("database.buckets.readOnly") }
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
                                        const result = await actions.createBucketKeyAction({
                                            bucketId: bucket.id,
                                            name: keyName.trim(),
                                            access
                                        });
                                        if (result.accessKey && result.secretKey) {
                                            setSecret({
                                                accessKey: result.accessKey,
                                                secretKey: result.secretKey
                                            });
                                        }
                                        return result;
                                    },
                                    () => setKeyName("")
                                )
                            }
                        >
                            {t("database.buckets.newKey")}
                        </Button>
                    </div>
                ) : null}
            </Section>

            <Section title={t("database.buckets.expiry")} hint={t("database.buckets.expiryHint")}>
                {bucket.lifecycle.map((rule) => (
                    <div key={rule.prefix} className="flex items-center gap-2 text-xs">
                        <code className="font-mono">
                            {rule.prefix || t("database.buckets.wholeBucket")}
                        </code>
                        <span className="text-muted-foreground">
                            {t("database.buckets.afterDays", { count: rule.days })}
                        </span>
                        {manage ? (
                            <Button
                                size="icon"
                                variant="ghost"
                                className="ml-auto"
                                aria-label={t("database.buckets.removeRule")}
                                title={t("database.buckets.removeRule")}
                                disabled={pending}
                                onClick={() =>
                                    run(() =>
                                        actions.removeLifecycleRuleAction({
                                            bucketId: bucket.id,
                                            prefix: rule.prefix
                                        })
                                    )
                                }
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                        ) : null}
                    </div>
                ))}
                {manage ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={prefix}
                            onChange={(event) => setPrefix(event.target.value)}
                            placeholder={t("database.buckets.prefixPlaceholder")}
                            className="w-44"
                        />
                        <div className="w-36">
                            <Select
                                value={days}
                                onValueChange={setDays}
                                options={core.LIFECYCLE_DAYS.map((value) => ({
                                    value: String(value),
                                    label: t("database.buckets.afterDaysOption", { count: value })
                                }))}
                            />
                        </div>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={!ruleValid.success || pending}
                            onClick={() =>
                                run(
                                    () =>
                                        actions.setLifecycleRuleAction({
                                            bucketId: bucket.id,
                                            prefix: prefix.trim(),
                                            days: Number(days)
                                        }),
                                    () => setPrefix("")
                                )
                            }
                        >
                            {t("database.buckets.addRule")}
                        </Button>
                    </div>
                ) : null}
            </Section>

            {manage ? (
                <Section
                    title={t("database.buckets.presign")}
                    hint={t("database.buckets.presignHint")}
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={objectKey}
                            onChange={(event) => setObjectKey(event.target.value)} // i18n-ignore: an example object key
                            placeholder="path/to/file.png"
                            className="min-w-48 flex-1"
                        />
                        <div className="w-32">
                            <Select
                                value={method}
                                onValueChange={(value) => setMethod(value as "GET" | "PUT")}
                                options={[
                                    { value: "GET", label: t("database.buckets.download") },
                                    { value: "PUT", label: t("database.buckets.upload") }
                                ]}
                            />
                        </div>
                        <div className="w-32">
                            <Select
                                value={lifetime}
                                onValueChange={setLifetime}
                                options={PRESIGN_LIFETIMES.map((option) => ({
                                    value: option.value,
                                    label: t(option.label)
                                }))}
                            />
                        </div>
                    </div>
                    <Input
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder={t("database.buckets.baseUrlPlaceholder")}
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
                            <Link2 className="size-4" /> {t("database.buckets.sign")}
                        </Button>
                    </div>
                    {signed ? <CopyRow value={signed} /> : null}
                </Section>
            ) : null}

            <Section
                title={t("database.buckets.replication")}
                hint={t("database.buckets.replicationHint")}
            >
                {bucket.replicateTo ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span>
                            {t.rich("database.buckets.replicatingInto", {
                                store: bucket.replicateTo.storeName,
                                name: bucket.replicateTo.name,
                                bucket: (chunks) => (
                                    <span key="bucket" className="font-mono">
                                        {chunks}
                                    </span>
                                )
                            })}
                        </span>
                        <Badge
                            variant={bucket.replicationState === "failed" ? "danger" : "success"}
                        >
                            {bucket.replicationState === "failed"
                                ? t("database.buckets.stopped")
                                : t("database.running")}
                        </Badge>
                        {manage ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={pending}
                                onClick={() =>
                                    run(() =>
                                        actions.setBucketReplicationAction({
                                            bucketId: bucket.id,
                                            toBucketId: null
                                        })
                                    )
                                }
                            >
                                {t("database.buckets.stop")}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
                {bucket.replicationError ? (
                    <p className="text-xs text-danger">{bucket.replicationError}</p>
                ) : null}
                {manage && !bucket.replicateTo ? (
                    candidates === null ? (
                        <div>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    void actions
                                        .replicationCandidatesAction(bucket.id)
                                        .then((result) => {
                                            if (result.candidates) setCandidates(result.candidates);
                                            else
                                                setError(
                                                    result.error ??
                                                        t("database.buckets.candidatesUnreadable")
                                                );
                                        })
                                }
                            >
                                {t("database.buckets.replicate")}
                            </Button>
                        </div>
                    ) : candidates.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("database.buckets.noCandidates")}
                        </p>
                    ) : (
                        <Select
                            value=""
                            placeholder={t("database.buckets.replicateInto")}
                            onValueChange={(toBucketId) =>
                                run(() =>
                                    actions.setBucketReplicationAction({
                                        bucketId: bucket.id,
                                        toBucketId
                                    })
                                )
                            }
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

const KIND_LABEL: Record<string, NamespaceKey<"deployData">> = {
    restore: "database.kinds.restore",
    upgrade: "database.kinds.upgrade",
    copy: "database.kinds.copy",
    recover: "database.kinds.recover",
    setup: "database.kinds.setup",
    archive: "database.kinds.archive"
};

function ActivityList({ overview, compact }: { overview: Overview; compact: boolean }) {
    const t = useTranslations("deployData");
    const format = useDisplayFormat();
    const rows = compact
        ? overview.operations.filter((operation) => operation.status === "running")
        : overview.operations;
    if (rows.length === 0) {
        return compact ? null : (
            <p className="text-sm text-muted-foreground">{t("database.nothingRun")}</p>
        );
    }
    return (
        <ul className="flex flex-col gap-2">
            {rows.map((operation) => (
                <li
                    key={operation.id}
                    className="rounded-md border border-border px-3 py-2 text-xs"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                            {KIND_LABEL[operation.kind]
                                ? t(KIND_LABEL[operation.kind]!)
                                : operation.kind}
                        </span>
                        <Badge
                            variant={
                                operation.status === "failed"
                                    ? "danger"
                                    : operation.status === "running"
                                      ? "neutral"
                                      : "success"
                            }
                        >
                            {operation.status === "running"
                                ? t("database.running")
                                : operation.status === "failed"
                                  ? t("database.failed")
                                  : t("database.done")}
                        </Badge>
                        <span className="ml-auto text-muted-foreground">
                            {format.dateTime(operation.startedAt)}
                        </span>
                    </div>
                    {operation.status === "running" ? (
                        <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" /> {operation.step}
                            {operation.doneBytes > 0
                                ? operation.totalBytes
                                    ? t("database.progressOf", {
                                          done: core.formatBytes(BigInt(operation.doneBytes)),
                                          total: core.formatBytes(BigInt(operation.totalBytes))
                                      })
                                    : t("database.progress", {
                                          done: core.formatBytes(BigInt(operation.doneBytes))
                                      })
                                : ""}
                        </p>
                    ) : null}
                    {operation.error ? <p className="mt-1 text-danger">{operation.error}</p> : null}
                </li>
            ))}
        </ul>
    );
}
