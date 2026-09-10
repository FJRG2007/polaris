"use client";

/**
 * A service's scheduled jobs: commands it runs on a cron schedule inside its own
 * container, and what each run printed.
 *
 * The form validates against the same schema the server does, field by field as
 * it is typed, and the schedule is read back in words and with its next firing
 * - "0 3 * * *" is not something anybody should have to check in their head.
 */

import * as core from "@polaris/core";
import { useProjectCan } from "./access-context";
import { relativeTime } from "@/lib/relative-time";
import { useDisplayFormat } from "@/components/display-format";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { ServiceCronRunView, ServiceCronView } from "@/lib/deploy/service-cron";
import { Button, ConfirmDeleteDialog, Input, Switch, Textarea, cn } from "@polaris/ui";
import { ChevronRight, Clock, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
    deleteServiceCronAction,
    listServiceCronRunsAction,
    listServiceCronsAction,
    runServiceCronAction,
    saveServiceCronAction
} from "./cron-actions";

/** Schedules offered with one click, because most jobs are one of these. */
const PRESETS = [
    { label: "Every 15 minutes", schedule: "*/15 * * * *" },
    { label: "Hourly", schedule: "0 * * * *" },
    { label: "Daily at 03:00", schedule: "0 3 * * *" },
    { label: "Mondays at 09:00", schedule: "0 9 * * 1" },
    { label: "Monthly", schedule: "0 0 1 * *" }
] as const;

interface Draft {
    id?: string;
    name: string;
    schedule: string;
    timezone: string;
    command: string;
    timeoutSeconds: string;
    maxAttempts: string;
    retryDelaySeconds: string;
    enabled: boolean;
}

function emptyDraft(): Draft {
    let timezone = "UTC";
    try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        // A browser that will not say keeps UTC.
    }
    return {
        name: "",
        schedule: "0 3 * * *",
        timezone,
        command: "",
        timeoutSeconds: "900",
        maxAttempts: "1",
        retryDelaySeconds: "60",
        enabled: true
    };
}

function draftOf(cron: ServiceCronView): Draft {
    return {
        id: cron.id,
        name: cron.name,
        schedule: cron.schedule,
        timezone: cron.timezone,
        command: cron.command,
        timeoutSeconds: String(cron.timeoutSeconds),
        maxAttempts: String(cron.maxAttempts),
        retryDelaySeconds: String(cron.retryDelaySeconds),
        enabled: cron.enabled
    };
}

/** The draft as the schema reads it; blank numbers stay blank so they are
 *  reported as missing rather than as zero. */
function inputOf(draft: Draft) {
    const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
    return {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        schedule: draft.schedule,
        timezone: draft.timezone,
        command: draft.command,
        timeoutSeconds: number(draft.timeoutSeconds),
        maxAttempts: number(draft.maxAttempts),
        retryDelaySeconds: number(draft.retryDelaySeconds),
        enabled: draft.enabled
    };
}

const STATUS_TONE: Record<string, string> = {
    succeeded: "bg-success-soft text-success-ink",
    running: "bg-warning-soft text-warning-ink",
    failed: "bg-danger-soft text-danger-ink",
    timed_out: "bg-danger-soft text-danger-ink",
    skipped: "bg-muted text-muted-foreground"
};

const STATUS_LABEL: Record<string, string> = {
    succeeded: "Succeeded",
    running: "Running",
    failed: "Failed",
    timed_out: "Timed out",
    skipped: "Skipped"
};

function StatusChip({ status }: { status: string | null }) {
    if (!status) return <span className="text-xs text-muted-foreground">Never run</span>;
    return (
        <span
            className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium",
                STATUS_TONE[status] ?? "bg-muted text-muted-foreground"
            )}
        >
            {STATUS_LABEL[status] ?? status}
        </span>
    );
}

export function CronPanel({ applicationId }: { applicationId: string }) {
    const can = useProjectCan();
    const manage = can("console.use");
    const [crons, setCrons] = useState<ServiceCronView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [openRuns, setOpenRuns] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<ServiceCronView | null>(null);
    const [pending, startTransition] = useTransition();

    function reload() {
        void listServiceCronsAction(applicationId).then((result) => {
            if (result.crons) setCrons(result.crons);
            else setError(result.error ?? "Could not read the scheduled jobs");
        });
    }
    useEffect(reload, [applicationId]);

    function run(cron: ServiceCronView) {
        startTransition(async () => {
            const result = await runServiceCronAction(applicationId, cron.id);
            setError(result.error ?? null);
            setOpenRuns(cron.id);
            reload();
        });
    }

    function toggle(cron: ServiceCronView, enabled: boolean) {
        // Optimistic: the switch moves at once and goes back if the save fails.
        setCrons(
            (held) => held?.map((one) => (one.id === cron.id ? { ...one, enabled } : one)) ?? held
        );
        startTransition(async () => {
            const result = await saveServiceCronAction(
                applicationId,
                inputOf({ ...draftOf(cron), enabled })
            );
            if (result.error) {
                setError(result.error);
                setCrons((held) => held?.map((one) => (one.id === cron.id ? cron : one)) ?? held);
                return;
            }
            reload();
        });
    }

    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <p className="text-sm font-medium">Scheduled jobs</p>
                    <p className="text-xs text-muted-foreground">
                        Commands this service runs on a schedule, inside its own container.
                    </p>
                </div>
                {manage && !draft && (
                    <Button size="sm" onClick={() => setDraft(emptyDraft())}>
                        <Plus className="size-4" /> New job
                    </Button>
                )}
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {draft && (
                <CronForm
                    applicationId={applicationId}
                    draft={draft}
                    onChange={setDraft}
                    onCancel={() => setDraft(null)}
                    onSaved={() => {
                        setDraft(null);
                        reload();
                    }}
                />
            )}

            {crons === null ? (
                <div className="flex justify-center py-8 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            ) : crons.length === 0 ? (
                !draft && (
                    <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                        No scheduled jobs yet. A cleanup, a report or a queue drain can run here on
                        a schedule.
                    </p>
                )
            ) : (
                <ul className="flex flex-col gap-2">
                    {crons.map((cron) => (
                        <li key={cron.id} className="rounded-lg border border-border/60">
                            <div className="flex flex-wrap items-center gap-3 p-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setOpenRuns((open) => (open === cron.id ? null : cron.id))
                                    }
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    aria-expanded={openRuns === cron.id}
                                >
                                    <ChevronRight
                                        className={cn(
                                            "size-4 shrink-0 text-muted-foreground transition-transform",
                                            openRuns === cron.id && "rotate-90"
                                        )}
                                    />
                                    <span className="min-w-0">
                                        <span
                                            className="block truncate text-sm font-medium"
                                            title={cron.name}
                                        >
                                            {cron.name}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {cron.scheduleText}
                                            {cron.timezone !== "UTC"
                                                ? ` (${cron.timezone})`
                                                : " (UTC)"}
                                            {cron.enabled && cron.nextRunAt ? (
                                                <NextRun at={cron.nextRunAt} />
                                            ) : (
                                                " - paused"
                                            )}
                                        </span>
                                    </span>
                                </button>
                                <StatusChip status={cron.lastStatus} />
                                {manage && (
                                    <div className="flex items-center gap-1">
                                        <Switch
                                            checked={cron.enabled}
                                            onChange={(next) => toggle(cron, next)}
                                            aria-label={
                                                cron.enabled
                                                    ? `Pause ${cron.name}`
                                                    : `Resume ${cron.name}`
                                            }
                                        />
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            disabled={pending}
                                            onClick={() => run(cron)}
                                            aria-label={`Run ${cron.name} now`}
                                            title="Run now"
                                        >
                                            <Play className="size-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setDraft(draftOf(cron))}
                                            aria-label={`Edit ${cron.name}`}
                                            title="Edit"
                                        >
                                            <Pencil className="size-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setDeleting(cron)}
                                            aria-label={`Delete ${cron.name}`}
                                            title="Delete"
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                )}
                            </div>
                            {openRuns === cron.id && (
                                <CronRuns applicationId={applicationId} cronId={cron.id} />
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.name ?? ""}
                requireTyping={false}
                kind="scheduled job"
                question={
                    <>
                        Delete the scheduled job <strong>{deleting?.name}</strong>?
                    </>
                }
                description="It stops running, and the record of its past runs goes with it."
                pending={pending}
                onConfirm={() => {
                    const target = deleting;
                    if (!target) return;
                    startTransition(async () => {
                        const result = await deleteServiceCronAction(applicationId, target.id);
                        setError(result.error ?? null);
                        setDeleting(null);
                        reload();
                    });
                }}
            />
        </div>
    );
}

function NextRun({ at }: { at: string }) {
    const format = useDisplayFormat();
    return <span title={format.dateTime(at)}> - next {relativeTime(at, format)}</span>;
}

function CronForm({
    applicationId,
    draft,
    onChange,
    onCancel,
    onSaved
}: {
    applicationId: string;
    draft: Draft;
    onChange: (draft: Draft) => void;
    onCancel: () => void;
    onSaved: () => void;
}) {
    const format = useDisplayFormat();
    const [problem, setProblem] = useState<string | null>(null);
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [pending, startTransition] = useTransition();
    const parsed = useMemo(() => core.serviceCronInputSchema.safeParse(inputOf(draft)), [draft]);
    /** Each field's first complaint, shown once the field has been left - an
     *  empty field is unfinished, not wrong. */
    const issues = useMemo(() => {
        const out: Record<string, string> = {};
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                const key = String(issue.path[0] ?? "");
                if (!out[key]) out[key] = issue.message;
            }
        }
        return out;
    }, [parsed]);
    const next = useMemo(() => {
        try {
            return core.nextCronRun(
                core.parseCron(draft.schedule),
                new Date(),
                draft.timezone || "UTC"
            );
        } catch {
            return null;
        }
    }, [draft.schedule, draft.timezone]);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        onChange({ ...draft, [key]: value });
    const shown = (key: string) => (touched[key] ? issues[key] : undefined);
    const leave = (key: string) => () => setTouched((held) => ({ ...held, [key]: true }));

    function save() {
        if (!parsed.success) {
            setTouched({
                name: true,
                schedule: true,
                timezone: true,
                command: true,
                timeoutSeconds: true,
                maxAttempts: true,
                retryDelaySeconds: true
            });
            return;
        }
        setProblem(null);
        startTransition(async () => {
            const result = await saveServiceCronAction(applicationId, parsed.data);
            if (result.error) {
                setProblem(result.error);
                return;
            }
            onSaved();
        });
    }

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-surface p-4">
            <p className="text-sm font-medium">{draft.id ? "Edit job" : "New job"}</p>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                    Name <span aria-hidden>*</span>
                </span>
                <Input
                    value={draft.name}
                    onChange={(event) => set("name", event.target.value)}
                    onBlur={leave("name")}
                    placeholder="Nightly cleanup"
                />
                {shown("name") && <span className="text-xs text-danger">{shown("name")}</span>}
            </label>
            <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                    Schedule <span aria-hidden>*</span>
                </span>
                <div className="flex flex-wrap gap-1.5">
                    {PRESETS.map((preset) => (
                        <button
                            key={preset.schedule}
                            type="button"
                            onClick={() => set("schedule", preset.schedule)}
                            className={cn(
                                "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                                draft.schedule === preset.schedule
                                    ? "border-primary/50 bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
                    <Input
                        value={draft.schedule}
                        onChange={(event) => set("schedule", event.target.value)}
                        onBlur={leave("schedule")}
                        className="font-mono"
                        spellCheck={false}
                        aria-label="Cron expression"
                    />
                    <Input
                        value={draft.timezone}
                        onChange={(event) => set("timezone", event.target.value)}
                        onBlur={leave("timezone")}
                        spellCheck={false}
                        aria-label="Time zone"
                        placeholder="UTC"
                    />
                </div>
                {shown("schedule") || shown("timezone") ? (
                    <span className="text-xs text-danger">
                        {shown("schedule") ?? shown("timezone")}
                    </span>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        {core.describeCron(draft.schedule)}
                        {next ? ` - next ${format.dateTime(next.toISOString())}` : ""}
                    </span>
                )}
            </div>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                    Command <span aria-hidden>*</span>
                </span>
                <Textarea
                    value={draft.command}
                    onChange={(event) => set("command", event.target.value)}
                    onBlur={leave("command")}
                    rows={3}
                    className="font-mono text-xs"
                    spellCheck={false}
                    placeholder="npm run cleanup"
                />
                {shown("command") ? (
                    <span className="text-xs text-danger">{shown("command")}</span>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        Runs with sh inside the running container, with the service&apos;s
                        variables.
                    </span>
                )}
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
                <NumberField
                    label="Stop after (seconds)"
                    value={draft.timeoutSeconds}
                    error={shown("timeoutSeconds")}
                    onChange={(value) => set("timeoutSeconds", value)}
                    onBlur={leave("timeoutSeconds")}
                />
                <NumberField
                    label="Tries"
                    value={draft.maxAttempts}
                    error={shown("maxAttempts")}
                    onChange={(value) => set("maxAttempts", value)}
                    onBlur={leave("maxAttempts")}
                />
                <NumberField
                    label="Wait between tries (seconds)"
                    value={draft.retryDelaySeconds}
                    error={shown("retryDelaySeconds")}
                    onChange={(value) => set("retryDelaySeconds", value)}
                    onBlur={leave("retryDelaySeconds")}
                />
            </div>
            {problem && <p className="text-sm text-danger">{problem}</p>}
            <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
                <Button onClick={save} disabled={pending} aria-disabled={!parsed.success}>
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Clock className="size-4" />
                    )}
                    {draft.id ? "Save" : "Schedule it"}
                </Button>
            </div>
        </div>
    );
}

function NumberField({
    label,
    value,
    error,
    onChange,
    onBlur
}: {
    label: string;
    value: string;
    error?: string;
    onChange: (value: string) => void;
    onBlur: () => void;
}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <Input
                inputMode="numeric"
                value={value}
                onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
                onBlur={onBlur}
            />
            {error && <span className="text-xs text-danger">{error}</span>}
        </label>
    );
}

function CronRuns({ applicationId, cronId }: { applicationId: string; cronId: string }) {
    const format = useDisplayFormat();
    const [runs, setRuns] = useState<ServiceCronRunView[] | null>(null);
    const [open, setOpen] = useState<string | null>(null);

    const [tick, setTick] = useState(0);
    useEffect(() => {
        let active = true;
        void listServiceCronRunsAction(applicationId, cronId).then((result) => {
            if (active) setRuns(result.runs ?? []);
        });
        return () => {
            active = false;
        };
    }, [applicationId, cronId, tick]);
    // Followed while one is still running, so the result lands without a click,
    // and left alone once nothing is.
    const running = runs?.some((run) => run.status === "running") ?? false;
    useEffect(() => {
        if (!running) return;
        const timer = setTimeout(() => setTick((value) => value + 1), 3000);
        return () => clearTimeout(timer);
    }, [running, runs]);

    if (runs === null) {
        return (
            <div className="flex justify-center border-t border-border/60 py-4 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
            </div>
        );
    }
    if (runs.length === 0) {
        return (
            <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
                It has not run yet.
            </p>
        );
    }
    return (
        <ul className="divide-y divide-border/40 border-t border-border/60">
            {runs.map((run) => {
                const took =
                    run.finishedAt !== null
                        ? Math.max(
                              0,
                              Math.round(
                                  (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
                              )
                          )
                        : null;
                return (
                    <li key={run.id} className="px-4 py-2">
                        <button
                            type="button"
                            onClick={() => setOpen((held) => (held === run.id ? null : run.id))}
                            className="flex w-full items-center gap-2 text-left text-xs"
                            aria-expanded={open === run.id}
                        >
                            <StatusChip status={run.status} />
                            <span
                                className="text-muted-foreground"
                                title={format.dateTime(run.startedAt)}
                            >
                                {relativeTime(run.startedAt, format)}
                            </span>
                            <span className="text-muted-foreground">
                                {run.trigger === "manual"
                                    ? "run by hand"
                                    : run.trigger === "retry"
                                      ? `try ${run.attempt}`
                                      : "on schedule"}
                            </span>
                            {took !== null && (
                                <span className="text-muted-foreground">- {took}s</span>
                            )}
                            {run.exitCode !== null && run.exitCode !== 0 && (
                                <span className="text-muted-foreground">- exit {run.exitCode}</span>
                            )}
                        </button>
                        {open === run.id && (
                            <div className="mt-2 flex flex-col gap-1">
                                {run.error && <p className="text-xs text-danger">{run.error}</p>}
                                <pre className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-[0.6875rem]">
                                    {run.output || "It printed nothing."}
                                </pre>
                            </div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
