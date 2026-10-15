"use client";

/**
 * Automations: when something happens in this project, do these things.
 *
 * A rule is one trigger - a schedule read in a time zone, a call to its own
 * webhook address, or an event the project already reports - and an ordered
 * list of actions on the project's services. The editor is drawn with the same
 * WHEN / THEN pieces as the other automation editors, and checked against the
 * same schema the server checks.
 *
 * The list paints at once; only the rows wait for the server. Somebody who may
 * not deploy here sees the rules and their runs, and not the controls.
 */

import * as core from "@polaris/core";
import { SettingsCard } from "../project-settings";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
    AutomationServiceOption,
    AutomationStepReason,
    DeployAutomationRunView,
    DeployAutomationView
} from "@/lib/deploy/automations";
import * as rules from "@polaris/ui/automation-rules";
import {
    AddMenu,
    Field,
    IssueProvider,
    KindPicker,
    NodeCard,
    SortableList,
    Stage,
    moved
} from "@polaris/ui/automation";
import {
    Button,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Textarea
} from "@polaris/ui";
import {
    Clock,
    History,
    Loader2,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Trash2,
    Workflow,
    Zap
} from "lucide-react";
import {
    deleteAutomationAction,
    listAutomationRunsAction,
    listAutomationsAction,
    rotateAutomationWebhookAction,
    runAutomationAction,
    saveAutomationAction,
    setAutomationEnabledAction,
    type AutomationsLoad
} from "../automation-actions";

type T = ReturnType<typeof useTranslations<"deploySettings">>;
type Key = NamespaceKey<"deploySettings">;

const TRIGGER_LABELS = {
    schedule: "automations.triggers.schedule",
    webhook: "automations.triggers.webhook",
    event: "automations.triggers.event"
} as const satisfies Record<core.DeployAutomationTrigger, Key>;

const EVENT_LABELS = {
    "deploy.succeeded": "automations.events.deploySucceeded",
    "deploy.failed": "automations.events.deployFailed",
    "domain.down": "automations.events.domainDown",
    "domain.up": "automations.events.domainUp"
} as const satisfies Record<core.DeployAutomationEvent, Key>;

const ACTION_LABELS = {
    redeploy: "automations.actions.redeploy",
    restart: "automations.actions.restart",
    command: "automations.actions.command",
    notify: "automations.actions.notify"
} as const satisfies Record<core.DeployAutomationActionType, Key>;

const REASON_LABELS = {
    gone: "automations.reasons.gone",
    failed: "automations.reasons.failed",
    notRunning: "automations.reasons.notRunning",
    unreachable: "automations.reasons.unreachable",
    timedOut: "automations.reasons.timedOut",
    exited: "automations.reasons.exited",
    notStarted: "automations.reasons.notStarted"
} as const satisfies Record<AutomationStepReason, Key>;

/** A schema complaint, by the field it is about, in the reader's language. */
const ISSUE_LABELS: Record<string, Key> = {
    name: "automations.issues.name",
    schedule: "automations.issues.schedule",
    timezone: "automations.issues.timezone",
    event: "automations.issues.event",
    eventApplicationId: "automations.issues.eventService",
    applicationId: "automations.issues.service",
    command: "automations.issues.command",
    timeoutSeconds: "automations.issues.timeout",
    message: "automations.issues.message",
    actions: "automations.issues.actions"
};

const STATUS_TONES: Record<string, rules.RuleTone> = {
    succeeded: "success",
    failed: "danger",
    timed_out: "danger",
    running: "active",
    skipped: "muted"
};

const ANY_SERVICE = "any";

interface ActionDraft {
    id: string;
    type: core.DeployAutomationActionType;
    applicationId: string;
    command: string;
    timeoutSeconds: string;
    message: string;
}

export interface AutomationDraft {
    id?: string;
    name: string;
    enabled: boolean;
    trigger: core.DeployAutomationTrigger;
    schedule: string;
    timezone: string;
    event: core.DeployAutomationEvent;
    eventApplicationId: string;
    actions: ActionDraft[];
}

let draftKey = 0;
function nextKey(): string {
    draftKey += 1;
    return `action-${draftKey}`;
}

function localTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

function blankAction(
    type: core.DeployAutomationActionType,
    services: readonly AutomationServiceOption[]
): ActionDraft {
    return {
        id: nextKey(),
        type,
        applicationId: services[0]?.id ?? "",
        command: "",
        timeoutSeconds: "300",
        message: ""
    };
}

export function draftFrom(rule: DeployAutomationView | null): AutomationDraft {
    if (!rule) {
        return {
            name: "",
            enabled: true,
            trigger: "schedule",
            schedule: "0 3 * * *",
            timezone: localTimeZone(),
            event: "deploy.failed",
            eventApplicationId: ANY_SERVICE,
            actions: []
        };
    }
    return {
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        trigger: rule.trigger,
        schedule: rule.schedule ?? "0 3 * * *",
        timezone: rule.timezone,
        event: rule.event ?? "deploy.failed",
        eventApplicationId: rule.eventApplicationId ?? ANY_SERVICE,
        actions: rule.actions.map((action) => ({
            id: nextKey(),
            type: action.type,
            applicationId: "applicationId" in action ? action.applicationId : "",
            command: action.type === "command" ? action.command : "",
            timeoutSeconds: action.type === "command" ? String(action.timeoutSeconds) : "300",
            message: action.type === "notify" ? action.message : ""
        }))
    };
}

/** The draft as the schema reads it. */
export function inputFrom(draft: AutomationDraft, projectId: string): unknown {
    return {
        id: draft.id,
        projectId,
        name: draft.name,
        enabled: draft.enabled,
        trigger: draft.trigger,
        schedule: draft.trigger === "schedule" ? draft.schedule : undefined,
        timezone: draft.timezone,
        event: draft.trigger === "event" ? draft.event : undefined,
        eventApplicationId:
            draft.trigger === "event" && draft.eventApplicationId !== ANY_SERVICE
                ? draft.eventApplicationId
                : null,
        actions: draft.actions.map((action) => {
            switch (action.type) {
                case "notify":
                    return { type: "notify", message: action.message };
                case "command":
                    return {
                        type: "command",
                        applicationId: action.applicationId,
                        command: action.command,
                        timeoutSeconds: Number(action.timeoutSeconds)
                    };
                default:
                    return { type: action.type, applicationId: action.applicationId };
            }
        })
    };
}

function triggerSummary(
    rule: DeployAutomationView,
    t: T,
    services: readonly AutomationServiceOption[]
): string {
    if (rule.trigger === "schedule") {
        const when = rule.scheduleText ?? rule.schedule ?? "";
        return rule.timezone === "UTC" ? when : `${when} (${rule.timezone})`;
    }
    if (rule.trigger === "webhook") return t("automations.summary.webhook");
    const event = rule.event ? t(EVENT_LABELS[rule.event]) : "";
    const service = services.find((entry) => entry.id === rule.eventApplicationId);
    return service ? t("automations.summary.eventOn", { event, service: service.name }) : event;
}

export function AutomationsSection({ projectId }: { projectId: string }) {
    const t = useTranslations("deploySettings");
    const display = useDisplayFormat();
    const [data, setData] = useState<AutomationsLoad | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<AutomationDraft | null>(null);
    const [deleting, setDeleting] = useState<DeployAutomationView | null>(null);
    const [rotating, setRotating] = useState<DeployAutomationView | null>(null);
    const [address, setAddress] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const [runsKey, setRunsKey] = useState(0);
    const [pending, startTransition] = useTransition();

    function load() {
        setLoadError(null);
        void listAutomationsAction(projectId).then((result) => {
            if (result.error || !result.data) {
                setLoadError(result.error ?? t("automations.loadFailed"));
                return;
            }
            setData(result.data);
        });
    }

    useEffect(load, [projectId]);

    const services = data?.services ?? [];
    const canEdit = data?.canEdit ?? false;

    function replace(rule: DeployAutomationView) {
        setData((held) =>
            held
                ? {
                      ...held,
                      automations: held.automations.some((entry) => entry.id === rule.id)
                          ? held.automations.map((entry) => (entry.id === rule.id ? rule : entry))
                          : [...held.automations, rule]
                  }
                : held
        );
    }

    function toggle(rule: DeployAutomationView, enabled: boolean) {
        setError(null);
        replace({ ...rule, enabled });
        startTransition(async () => {
            const result = await setAutomationEnabledAction({
                projectId,
                automationId: rule.id,
                enabled
            });
            if (result.error || !result.automation) {
                replace(rule);
                setError(result.error ?? t("automations.saveFailed"));
                return;
            }
            replace(result.automation);
        });
    }

    function run(rule: DeployAutomationView) {
        setError(null);
        startTransition(async () => {
            const result = await runAutomationAction({ projectId, automationId: rule.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setOpen(rule.id);
            setRunsKey((key) => key + 1);
        });
    }

    function remove() {
        if (!deleting) return;
        const target = deleting;
        startTransition(async () => {
            const result = await deleteAutomationAction({ projectId, automationId: target.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setDeleting(null);
            setData((held) =>
                held
                    ? {
                          ...held,
                          automations: held.automations.filter((entry) => entry.id !== target.id)
                      }
                    : held
            );
        });
    }

    function rotate() {
        if (!rotating) return;
        const target = rotating;
        startTransition(async () => {
            const result = await rotateAutomationWebhookAction({
                projectId,
                automationId: target.id
            });
            if (result.error || !result.webhookUrl) {
                setError(result.error ?? t("automations.rotateFailed"));
                return;
            }
            setRotating(null);
            setAddress(result.webhookUrl);
        });
    }

    const atLimit = (data?.automations.length ?? 0) >= core.DEPLOY_AUTOMATION_LIMIT;

    return (
        <SettingsCard title={t("automations.title")} description={t("automations.description")}>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    disabled={!canEdit || atLimit}
                    onClick={() => setEditing(draftFrom(null))}
                >
                    <Plus className="size-4 shrink-0" />
                    {t("automations.new")}
                </Button>
                {data && !canEdit && (
                    <p className="text-xs text-muted-foreground">{t("automations.readOnly")}</p>
                )}
                {data && canEdit && atLimit && (
                    <p className="text-xs text-muted-foreground">
                        {t("automations.atLimit", { limit: core.DEPLOY_AUTOMATION_LIMIT })}
                    </p>
                )}
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {loadError ? (
                <div className="flex flex-col items-center gap-2 rounded-md border border-border/60 px-3 py-8 text-center">
                    <p className="text-sm text-danger">{loadError}</p>
                    <Button size="sm" variant="outline" onClick={load}>
                        {t("automations.retry")}
                    </Button>
                </div>
            ) : data === null ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                </div>
            ) : data.automations.length === 0 ? (
                <div className="flex flex-col items-center gap-1 rounded-md border border-border/60 px-3 py-8 text-center">
                    <Workflow className="size-5 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t("automations.empty")}</p>
                </div>
            ) : (
                <rules.RuleList label={t("automations.title")}>
                    {data.automations.map((rule) => (
                        <rules.RuleRow
                            key={rule.id}
                            name={rule.name}
                            summary={
                                <>
                                    {t(TRIGGER_LABELS[rule.trigger])}:{" "}
                                    {triggerSummary(rule, t, services)}
                                    {" / "}
                                    {t("automations.actionCount", { count: rule.actions.length })}
                                </>
                            }
                            enabled={rule.enabled}
                            onToggle={(checked) => toggle(rule, checked)}
                            toggleLabel={t("automations.enabled")}
                            toggleDisabled={!canEdit || pending}
                            open={
                                canEdit
                                    ? ({ className, children }) => (
                                          <button
                                              type="button"
                                              className={className}
                                              title={t("automations.edit")}
                                              onClick={() => setEditing(draftFrom(rule))}
                                          >
                                              {children}
                                          </button>
                                      )
                                    : undefined
                            }
                            last={
                                rule.lastRunAt ? outcomeOf(rule.lastStatus ?? "running", t) : null
                            }
                            lastRun={rule.lastRunAt ? display.dateTime(rule.lastRunAt) : null}
                            neverRan={t("automations.neverRan")}
                            detail={
                                open === rule.id ? (
                                    <RunHistory
                                        key={runsKey}
                                        projectId={projectId}
                                        automationId={rule.id}
                                        services={services}
                                    />
                                ) : null
                            }
                            actions={
                                <>
                                    <rules.RuleAction
                                        label={
                                            open === rule.id
                                                ? t("automations.hideRuns")
                                                : t("automations.showRuns")
                                        }
                                        onClick={() =>
                                            setOpen((held) => (held === rule.id ? null : rule.id))
                                        }
                                    >
                                        <History className="size-4" />
                                    </rules.RuleAction>
                                    {canEdit && (
                                        <>
                                            <rules.RuleAction
                                                label={t("automations.runNow")}
                                                disabled={pending}
                                                onClick={() => run(rule)}
                                            >
                                                <Play className="size-4" />
                                            </rules.RuleAction>
                                            {rule.trigger === "webhook" && (
                                                <rules.RuleAction
                                                    label={t("automations.rotate")}
                                                    onClick={() => setRotating(rule)}
                                                >
                                                    <RefreshCw className="size-4" />
                                                </rules.RuleAction>
                                            )}
                                            <rules.RuleAction
                                                label={t("automations.edit")}
                                                onClick={() => setEditing(draftFrom(rule))}
                                            >
                                                <Pencil className="size-4" />
                                            </rules.RuleAction>
                                            <rules.RuleAction
                                                label={t("automations.delete")}
                                                onClick={() => setDeleting(rule)}
                                            >
                                                <Trash2 className="size-4" />
                                            </rules.RuleAction>
                                        </>
                                    )}
                                </>
                            }
                        />
                    ))}
                </rules.RuleList>
            )}
            {editing && data && (
                <AutomationEditor
                    projectId={projectId}
                    initial={editing}
                    services={services}
                    canCommand={data.canCommand}
                    onClose={() => setEditing(null)}
                    onSaved={(rule, webhookUrl) => {
                        replace(rule);
                        setEditing(null);
                        if (webhookUrl) setAddress(webhookUrl);
                    }}
                />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(next) => !next && setDeleting(null)}
                name={deleting?.name ?? ""}
                requireTyping={false}
                kind={t("automations.kind")}
                description={t("automations.deleteHint")}
                pending={pending}
                onConfirm={remove}
            />

            <ConfirmDeleteDialog
                open={rotating !== null}
                onOpenChange={(next) => !next && setRotating(null)}
                name={rotating?.name ?? ""}
                requireTyping={false}
                kind={t("automations.kind")}
                title={t("automations.rotateTitle")}
                question={t("automations.rotateQuestion", { name: rotating?.name ?? "" })}
                confirmLabel={t("automations.rotate")}
                pending={pending}
                onConfirm={rotate}
            />

            <Dialog open={address !== null} onOpenChange={(next) => !next && setAddress(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("automations.addressTitle")}</DialogTitle>
                        <DialogDescription>{t("automations.addressHint")}</DialogDescription>
                    </DialogHeader>
                    <div className="flex min-w-0 items-center gap-2">
                        <Input
                            readOnly
                            value={address ?? ""}
                            aria-label={t("automations.addressTitle")}
                            className="min-w-0 flex-1 font-mono text-xs"
                            onFocus={(event) => event.currentTarget.select()}
                        />
                        <CopyButton value={address ?? ""} label={t("automations.copy")} />
                    </div>
                    <p className="text-xs text-muted-foreground">{t("automations.addressUse")}</p>
                    <div className="flex justify-end">
                        <Button size="sm" onClick={() => setAddress(null)}>
                            {t("automations.done")}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </SettingsCard>
    );
}

/** A run's or a step's outcome, as the shared rule pieces draw it. */
function outcomeOf(status: string, t: T): rules.RuleOutcome {
    return { text: t(statusKey(status)), tone: STATUS_TONES[status] ?? "muted" };
}

/** A rule's recent runs, newest first, refreshed while one is still going. */
function RunHistory({
    projectId,
    automationId,
    services
}: {
    projectId: string;
    automationId: string;
    services: readonly AutomationServiceOption[];
}) {
    const t = useTranslations("deploySettings");
    const display = useDisplayFormat();
    const [runs, setRuns] = useState<DeployAutomationRunView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let alive = true;
        function fetchRuns() {
            void listAutomationRunsAction({ projectId, automationId }).then((result) => {
                if (!alive) return;
                if (result.error) {
                    setError(result.error);
                    return;
                }
                const next = result.runs ?? [];
                setError(null);
                setRuns(next);
                setExpanded((held) => held ?? next[0]?.id ?? null);
                if (next.some((entry) => entry.status === "running"))
                    timer.current = setTimeout(fetchRuns, 3000);
            });
        }
        fetchRuns();
        return () => {
            alive = false;
            if (timer.current) clearTimeout(timer.current);
        };
    }, [projectId, automationId]);

    const serviceName = (id: string | null) =>
        services.find((entry) => entry.id === id)?.name ?? null;

    if (error) return <p className="text-sm text-danger">{error}</p>;
    if (runs === null) {
        return (
            <div aria-busy="true">
                <Skeleton className="h-9 w-full" />
            </div>
        );
    }
    if (runs.length === 0)
        return <p className="text-muted-foreground">{t("automations.runs.empty")}</p>;
    return (
        <rules.RunList label={t("automations.runs.title")}>
            {runs.map((entry) => (
                <rules.RunRow
                    key={entry.id}
                    outcome={outcomeOf(entry.status, t)}
                    cause={t(runTriggerKey(entry.trigger))}
                    at={display.dateTime(entry.startedAt)}
                    expanded={expanded === entry.id}
                    onToggle={() => setExpanded((held) => (held === entry.id ? null : entry.id))}
                >
                    {entry.note && (
                        <p className="text-xs text-muted-foreground">{t(noteKey(entry.note))}</p>
                    )}
                    {entry.steps.length > 0 && (
                        <ol className="flex flex-col gap-1.5 text-xs">
                            {entry.steps.map((step, index) => (
                                <li key={index} className="flex min-w-0 flex-col gap-1">
                                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                        <rules.OutcomeBadge outcome={outcomeOf(step.status, t)} />
                                        <span className="min-w-0 truncate">
                                            {t(ACTION_LABELS[step.type])}
                                            {serviceName(step.applicationId)
                                                ? ` / ${serviceName(step.applicationId)}`
                                                : ""}
                                            {step.exitCode !== undefined && step.exitCode !== null
                                                ? ` / ${t("automations.runs.exit", { code: step.exitCode })}`
                                                : ""}
                                        </span>
                                    </span>
                                    {step.reason && (
                                        <span className="break-words text-danger">
                                            {t(REASON_LABELS[step.reason])}
                                        </span>
                                    )}
                                    {step.output && (
                                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[0.6875rem]">
                                            {step.output}
                                        </pre>
                                    )}
                                </li>
                            ))}
                        </ol>
                    )}
                </rules.RunRow>
            ))}
        </rules.RunList>
    );
}
function statusKey(status: string): Key {
    switch (status) {
        case "succeeded":
            return "automations.status.succeeded";
        case "failed":
            return "automations.status.failed";
        case "timed_out":
            return "automations.status.timedOut";
        case "running":
            return "automations.status.running";
        default:
            return "automations.status.skipped";
    }
}

function runTriggerKey(trigger: string): Key {
    switch (trigger) {
        case "schedule":
            return "automations.triggers.schedule";
        case "webhook":
            return "automations.triggers.webhook";
        case "event":
            return "automations.triggers.event";
        default:
            return "automations.runs.manual";
    }
}

function noteKey(note: "creator" | "busy" | "empty"): Key {
    if (note === "creator") return "automations.runs.creator";
    if (note === "busy") return "automations.runs.busy";
    return "automations.runs.noActions";
}

const PRESETS = [
    { label: "automations.presets.hourly", schedule: "0 * * * *" },
    { label: "automations.presets.daily", schedule: "0 3 * * *" },
    { label: "automations.presets.mondays", schedule: "0 9 * * 1" }
] as const satisfies readonly { label: Key; schedule: string }[];

/** Create or change one rule. */
export function AutomationEditor({
    projectId,
    initial,
    services,
    canCommand,
    onClose,
    onSaved
}: {
    projectId: string;
    initial: AutomationDraft;
    services: readonly AutomationServiceOption[];
    canCommand: boolean;
    onClose: () => void;
    onSaved: (rule: DeployAutomationView, webhookUrl: string | null) => void;
}) {
    const t = useTranslations("deploySettings");
    const display = useDisplayFormat();
    const [draft, setDraft] = useState(initial);
    const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
    const [attempted, setAttempted] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const parsed = useMemo(
        () => core.deployAutomationInputSchema.safeParse(inputFrom(draft, projectId)),
        [draft, projectId]
    );
    const issues = useMemo(() => {
        const out = new Map<string, string>();
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                const key = issue.path.join(".");
                if (out.has(key)) continue;
                const field = [...issue.path].reverse().find((part) => typeof part === "string");
                const label = typeof field === "string" ? ISSUE_LABELS[field] : undefined;
                out.set(key, label ? t(label) : issue.message);
            }
        }
        return out;
    }, [parsed, t]);
    const lookup = (path: readonly (string | number)[]) => {
        const key = path.join(".");
        return attempted || touched.has(key) ? issues.get(key) : undefined;
    };
    const next = useMemo(() => {
        if (draft.trigger !== "schedule") return null;
        try {
            return core.nextCronRun(
                core.parseCron(draft.schedule),
                new Date(),
                draft.timezone || "UTC"
            );
        } catch {
            return null;
        }
    }, [draft.trigger, draft.schedule, draft.timezone]);

    function set<K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) {
        setDraft((held) => ({ ...held, [key]: value }));
        setTouched((held) => new Set(held).add(String(key)));
    }

    function setAction(index: number, patch: Partial<ActionDraft>) {
        setDraft((held) => ({
            ...held,
            actions: held.actions.map((action, at) =>
                at === index ? { ...action, ...patch } : action
            )
        }));
        setTouched((held) => {
            const out = new Set(held);
            for (const field of Object.keys(patch)) out.add(`actions.${index}.${field}`);
            return out;
        });
    }

    const offered = core.DEPLOY_AUTOMATION_ACTIONS.filter((type) => {
        if (type === "command" && !canCommand) return false;
        if (type !== "notify" && services.length === 0) return false;
        return true;
    });
    const serviceOptions = services.map((entry) => ({
        value: entry.id,
        label: `${entry.name} (${entry.environmentName})`
    }));
    const scoped = core.SERVICE_SCOPED_EVENTS.includes(draft.event);

    function save() {
        setAttempted(true);
        if (!parsed.success) return;
        setProblem(null);
        startTransition(async () => {
            const result = await saveAutomationAction(parsed.data);
            if (result.error || !result.automation) {
                setProblem(result.error ?? t("automations.saveFailed"));
                return;
            }
            onSaved(result.automation, result.webhookUrl ?? null);
        });
    }

    const actionsIssue = attempted ? issues.get("actions") : undefined;

    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {draft.id ? t("automations.editTitle") : t("automations.newTitle")}
                    </DialogTitle>
                    <DialogDescription>{t("automations.editorHint")}</DialogDescription>
                </DialogHeader>
                <IssueProvider value={lookup}>
                    <div className="flex flex-col gap-4">
                        <Field label={t("automations.name")} path={["name"]} required>
                            {(id, invalid) => (
                                <Input
                                    id={id}
                                    value={draft.name}
                                    maxLength={64}
                                    aria-invalid={invalid}
                                    placeholder={t("automations.namePlaceholder")}
                                    onChange={(event) => set("name", event.target.value)}
                                />
                            )}
                        </Field>

                        <ol className="flex flex-col">
                            <Stage
                                icon={<Zap className="size-4" />}
                                title={t("automations.when")}
                                hint={t("automations.whenHint")}
                            >
                                <Select
                                    value={draft.trigger}
                                    aria-label={t("automations.trigger")}
                                    className="w-full sm:w-64"
                                    options={core.DEPLOY_AUTOMATION_TRIGGERS.map((trigger) => ({
                                        value: trigger,
                                        label: t(TRIGGER_LABELS[trigger])
                                    }))}
                                    onValueChange={(value) =>
                                        set("trigger", value as core.DeployAutomationTrigger)
                                    }
                                />
                                {draft.trigger === "schedule" && (
                                    <div className="flex flex-col gap-2">
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                            <Field
                                                label={t("automations.schedule")}
                                                path={["schedule"]}
                                                required
                                            >
                                                {(id, invalid) => (
                                                    <Input
                                                        id={id}
                                                        value={draft.schedule}
                                                        aria-invalid={invalid}
                                                        className="font-mono"
                                                        onChange={(event) =>
                                                            set("schedule", event.target.value)
                                                        }
                                                    />
                                                )}
                                            </Field>
                                            <Field
                                                label={t("automations.timezone")}
                                                path={["timezone"]}
                                                required
                                            >
                                                {(id, invalid) => (
                                                    <Input
                                                        id={id}
                                                        value={draft.timezone}
                                                        aria-invalid={invalid}
                                                        onChange={(event) =>
                                                            set("timezone", event.target.value)
                                                        }
                                                    />
                                                )}
                                            </Field>
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {PRESETS.map((preset) => (
                                                <Button
                                                    key={preset.schedule}
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7"
                                                    onClick={() => set("schedule", preset.schedule)}
                                                >
                                                    {t(preset.label)}
                                                </Button>
                                            ))}
                                        </div>
                                        {next && (
                                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                                <Clock className="size-3.5 shrink-0" />
                                                {core.describeCron(draft.schedule)}
                                                {" / "}
                                                {t("automations.nextRun", {
                                                    date: display.dateTime(next.toISOString())
                                                })}
                                            </p>
                                        )}
                                    </div>
                                )}
                                {draft.trigger === "webhook" && (
                                    <p className="text-xs text-muted-foreground">
                                        {draft.id && initial.trigger === "webhook"
                                            ? t("automations.webhookKept")
                                            : t("automations.webhookMinted")}
                                    </p>
                                )}
                                {draft.trigger === "event" && (
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <Field
                                            label={t("automations.event")}
                                            path={["event"]}
                                            required
                                        >
                                            {(id) => (
                                                <Select
                                                    id={id}
                                                    value={draft.event}
                                                    options={core.DEPLOY_AUTOMATION_EVENTS.map(
                                                        (event) => ({
                                                            value: event,
                                                            label: t(EVENT_LABELS[event])
                                                        })
                                                    )}
                                                    onValueChange={(value) => {
                                                        const event =
                                                            value as core.DeployAutomationEvent;
                                                        setDraft((held) => ({
                                                            ...held,
                                                            event,
                                                            eventApplicationId:
                                                                core.SERVICE_SCOPED_EVENTS.includes(
                                                                    event
                                                                )
                                                                    ? held.eventApplicationId
                                                                    : ANY_SERVICE
                                                        }));
                                                    }}
                                                />
                                            )}
                                        </Field>
                                        {scoped && (
                                            <Field
                                                label={t("automations.eventService")}
                                                path={["eventApplicationId"]}
                                            >
                                                {(id) => (
                                                    <Select
                                                        id={id}
                                                        value={draft.eventApplicationId}
                                                        options={[
                                                            {
                                                                value: ANY_SERVICE,
                                                                label: t("automations.anyService")
                                                            },
                                                            ...serviceOptions
                                                        ]}
                                                        onValueChange={(value) =>
                                                            set("eventApplicationId", value)
                                                        }
                                                    />
                                                )}
                                            </Field>
                                        )}
                                    </div>
                                )}
                            </Stage>

                            <Stage
                                icon={<Play className="size-4" />}
                                title={t("automations.then")}
                                hint={t("automations.thenHint")}
                                issue={actionsIssue}
                                last
                            >
                                <SortableList
                                    items={draft.actions}
                                    label={t("automations.then")}
                                    handleLabel={t("automations.move")}
                                    onMove={(from, to) =>
                                        setDraft((held) => ({
                                            ...held,
                                            actions: moved(held.actions, from, to)
                                        }))
                                    }
                                >
                                    {(action, index, handle) => (
                                        <NodeCard
                                            handle={handle}
                                            number={index + 1}
                                            removeLabel={t("automations.removeAction")}
                                            upLabel={t("automations.moveUp")}
                                            downLabel={t("automations.moveDown")}
                                            onUp={
                                                index > 0
                                                    ? () =>
                                                          setDraft((held) => ({
                                                              ...held,
                                                              actions: moved(
                                                                  held.actions,
                                                                  index,
                                                                  index - 1
                                                              )
                                                          }))
                                                    : undefined
                                            }
                                            onDown={
                                                index < draft.actions.length - 1
                                                    ? () =>
                                                          setDraft((held) => ({
                                                              ...held,
                                                              actions: moved(
                                                                  held.actions,
                                                                  index,
                                                                  index + 1
                                                              )
                                                          }))
                                                    : undefined
                                            }
                                            onRemove={() =>
                                                setDraft((held) => ({
                                                    ...held,
                                                    actions: held.actions.filter(
                                                        (_, at) => at !== index
                                                    )
                                                }))
                                            }
                                            kind={
                                                <KindPicker
                                                    value={action.type}
                                                    kinds={
                                                        offered.includes(action.type)
                                                            ? offered
                                                            : [...offered, action.type]
                                                    }
                                                    label={t("automations.actionKind")}
                                                    text={(kind) => t(ACTION_LABELS[kind])}
                                                    onChange={(type) => setAction(index, { type })}
                                                />
                                            }
                                        >
                                            {action.type !== "notify" && (
                                                <Field
                                                    label={t("automations.service")}
                                                    path={["actions", index, "applicationId"]}
                                                    required
                                                >
                                                    {(id) => (
                                                        <Select
                                                            id={id}
                                                            value={action.applicationId}
                                                            placeholder={t(
                                                                "automations.pickService"
                                                            )}
                                                            options={serviceOptions}
                                                            onValueChange={(value) =>
                                                                setAction(index, {
                                                                    applicationId: value
                                                                })
                                                            }
                                                        />
                                                    )}
                                                </Field>
                                            )}
                                            {action.type === "command" && (
                                                <>
                                                    <Field
                                                        label={t("automations.timeout")}
                                                        path={["actions", index, "timeoutSeconds"]}
                                                        required
                                                    >
                                                        {(id, invalid) => (
                                                            <Input
                                                                id={id}
                                                                type="number"
                                                                min={10}
                                                                max={3600}
                                                                value={action.timeoutSeconds}
                                                                aria-invalid={invalid}
                                                                onChange={(event) =>
                                                                    setAction(index, {
                                                                        timeoutSeconds:
                                                                            event.target.value
                                                                    })
                                                                }
                                                            />
                                                        )}
                                                    </Field>
                                                    <Field
                                                        label={t("automations.command")}
                                                        path={["actions", index, "command"]}
                                                        required
                                                        className="sm:col-span-2"
                                                    >
                                                        {(id, invalid) => (
                                                            <Textarea
                                                                id={id}
                                                                rows={3}
                                                                value={action.command}
                                                                aria-invalid={invalid}
                                                                className="font-mono text-xs"
                                                                placeholder={t(
                                                                    "automations.commandPlaceholder"
                                                                )}
                                                                onChange={(event) =>
                                                                    setAction(index, {
                                                                        command: event.target.value
                                                                    })
                                                                }
                                                            />
                                                        )}
                                                    </Field>
                                                </>
                                            )}
                                            {action.type === "notify" && (
                                                <Field
                                                    label={t("automations.message")}
                                                    path={["actions", index, "message"]}
                                                    required
                                                    className="sm:col-span-2"
                                                >
                                                    {(id, invalid) => (
                                                        <Input
                                                            id={id}
                                                            value={action.message}
                                                            maxLength={300}
                                                            aria-invalid={invalid}
                                                            onChange={(event) =>
                                                                setAction(index, {
                                                                    message: event.target.value
                                                                })
                                                            }
                                                        />
                                                    )}
                                                </Field>
                                            )}
                                        </NodeCard>
                                    )}
                                </SortableList>
                                {draft.actions.length < core.DEPLOY_AUTOMATION_ACTION_LIMIT && (
                                    <AddMenu
                                        label={t("automations.addAction")}
                                        options={offered.map((type) => ({
                                            value: type,
                                            label: t(ACTION_LABELS[type])
                                        }))}
                                        onPick={(type) =>
                                            setDraft((held) => ({
                                                ...held,
                                                actions: [
                                                    ...held.actions,
                                                    blankAction(
                                                        type as core.DeployAutomationActionType,
                                                        services
                                                    )
                                                ]
                                            }))
                                        }
                                    />
                                )}
                                {services.length === 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        {t("automations.noServices")}
                                    </p>
                                )}
                                {!canCommand && services.length > 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        {t("automations.noCommands")}
                                    </p>
                                )}
                            </Stage>
                        </ol>

                        {problem && <p className="text-sm text-danger">{problem}</p>}
                        <div className="flex justify-end gap-2">
                            <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
                                {t("automations.cancel")}
                            </Button>
                            <Button
                                size="sm"
                                aria-disabled={!parsed.success || pending}
                                onClick={() => !pending && save()}
                            >
                                {pending && <Loader2 className="size-4 shrink-0 animate-spin" />}
                                {t("automations.save")}
                            </Button>
                        </div>
                    </div>
                </IssueProvider>
            </DialogContent>
        </Dialog>
    );
}
