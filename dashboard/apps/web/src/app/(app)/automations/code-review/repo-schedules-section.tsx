"use client";

import Link from "next/link";
import { runAction } from "@/lib/run-action";
import { relativeTime } from "@/lib/relative-time";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Button, Select, Skeleton, Switch, Textarea } from "@polaris/ui";
import { CronScheduleField, browserTimeZone } from "@/components/cron-schedule-field";
import {
    SESSION_SCHEDULE_PROMPT_MAX,
    sessionScheduleInputSchema,
    type SessionScheduleView
} from "@/lib/agents/session-schedule-input";
import {
    deleteSessionScheduleAction,
    listSessionSchedulesAction,
    saveSessionScheduleAction,
    setSessionScheduleEnabledAction
} from "./schedule-actions";

interface Draft {
    id?: string;
    cli: string;
    schedule: string;
    timezone: string;
    prompt: string;
    enabled: boolean;
}

/** Code sessions this repository starts on its own, on a schedule. */
export function RepoSchedulesSection({ repoId }: { repoId: string }) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const [rows, setRows] = useState<SessionScheduleView[] | undefined>(undefined);
    const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);
    const [touched, setTouched] = useState(false);
    const [error, setError] = useState("");
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let live = true;
        void runAction(() => listSessionSchedulesAction(repoId), setError).then((result) => {
            if (!live || !result) return;
            if (result.error) setError(result.error);
            setRows(result.schedules ?? []);
            setAgents(result.agents ?? []);
        });
        return () => {
            live = false;
        };
    }, [repoId]);

    const parsed = useMemo(
        () => (draft ? sessionScheduleInputSchema.safeParse({ ...draft, repoId }) : null),
        [draft, repoId]
    );
    const issue = (field: string) =>
        touched && parsed && !parsed.success
            ? parsed.error.issues.find((entry) => entry.path[0] === field)?.message
            : undefined;

    const startNew = () => {
        setTouched(false);
        setDraft({ cli: agents[0]?.id ?? "", schedule: "0 9 * * 1", timezone: browserTimeZone(), prompt: "", enabled: true });
    };

    const save = () => {
        if (!parsed?.success) {
            setTouched(true);
            return;
        }
        setError("");
        startTransition(async () => {
            const result = await runAction(() => saveSessionScheduleAction(parsed.data), setError);
            if (!result) return;
            if (result.error || !result.schedule) {
                setError(result.error ?? t("repoSchedules.errors.saveFailed"));
                return;
            }
            const saved = result.schedule;
            setRows((list) =>
                list?.some((row) => row.id === saved.id)
                    ? list.map((row) => (row.id === saved.id ? saved : row))
                    : [...(list ?? []), saved]
            );
            setDraft(null);
        });
    };

    const toggle = (row: SessionScheduleView, enabled: boolean) => {
        const before = rows;
        setRows((list) => list?.map((entry) => (entry.id === row.id ? { ...entry, enabled } : entry)));
        startTransition(async () => {
            const result = await runAction(
                () => setSessionScheduleEnabledAction({ repoId, id: row.id, enabled }),
                setError
            );
            if (!result || result.error) {
                setRows(before);
                setError(result?.error ?? t("repoSchedules.errors.saveFailed"));
            }
        });
    };

    const remove = (row: SessionScheduleView) => {
        const before = rows;
        setRows((list) => list?.filter((entry) => entry.id !== row.id));
        setRemoving(null);
        startTransition(async () => {
            const result = await runAction(() => deleteSessionScheduleAction({ repoId, id: row.id }), setError);
            if (!result || result.error) {
                setRows(before);
                setError(result?.error ?? t("repoSchedules.errors.saveFailed"));
            }
        });
    };

    const agentLabel = (id: string) => agents.find((agent) => agent.id === id)?.label ?? id;

    return (
        <section className="flex min-w-0 flex-col gap-2 border-t border-border pt-4">
            <div className="min-w-0">
                <p className="text-sm font-medium">{t("repoSchedules.title")}</p>
                <p className="text-xs text-muted-foreground">{t("repoSchedules.hint")}</p>
            </div>
            {rows === undefined ? (
                <Skeleton className="h-10 w-full" />
            ) : rows.length === 0 && !draft ? (
                <p className="text-sm text-muted-foreground">{t("repoSchedules.empty")}</p>
            ) : (
                <ul className="flex min-w-0 flex-col gap-2">
                    {rows.map((row) => (
                        <li key={row.id} className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-2">
                            <div className="flex min-w-0 items-center gap-2">
                                <Switch
                                    checked={row.enabled}
                                    onChange={(on) => toggle(row, on)}
                                    aria-label={t("repoSchedules.enabled")}
                                />
                                <p className="min-w-0 flex-1 truncate text-sm" title={row.prompt}>
                                    {row.prompt}
                                </p>
                                {removing === row.id ? (
                                    <>
                                        <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                                            {t("repoSchedules.keep")}
                                        </Button>
                                        <Button size="sm" variant="danger" onClick={() => remove(row)} disabled={pending}>
                                            {t("repoSchedules.confirmRemove")}
                                        </Button>
                                    </>
                                ) : (
                                    <>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setTouched(false);
                                                setDraft({
                                                    id: row.id,
                                                    cli: row.cli,
                                                    schedule: row.schedule,
                                                    timezone: row.timezone,
                                                    prompt: row.prompt,
                                                    enabled: row.enabled
                                                });
                                            }}
                                        >
                                            {t("repoSchedules.edit")}
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => setRemoving(row.id)}>
                                            {t("repoSchedules.remove")}
                                        </Button>
                                    </>
                                )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground" title={row.schedule}>
                                {t("repoSchedules.summary", { agent: agentLabel(row.cli), when: row.scheduleText, zone: row.timezone })}
                                {row.enabled && row.nextRunAt ? (
                                    <span title={format.dateTime(row.nextRunAt)}>
                                        {" "}
                                        {t("repoSchedules.next", { when: relativeTime(row.nextRunAt, format) })}
                                    </span>
                                ) : null}
                            </p>
                            {row.runs.map((run) => (
                                <p key={run.id} className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                                    <span className="shrink-0" title={format.dateTime(run.at)}>
                                        {relativeTime(run.at, format)}
                                    </span>
                                    <span className="shrink-0">{t(`repoSchedules.status.${run.status}`)}</span>
                                    {run.sessionId ? (
                                        <Link href={`/polar?session=${run.sessionId}`} className="shrink-0 text-primary hover:underline">
                                            {t("repoSchedules.openSession")}
                                        </Link>
                                    ) : null}
                                    {run.error ? (
                                        <span className="min-w-0 truncate" title={run.error}>
                                            {run.error}
                                        </span>
                                    ) : null}
                                </p>
                            ))}
                        </li>
                    ))}
                </ul>
            )}

            {draft ? (
                <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
                    <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("repoSchedules.agent")} <span aria-hidden>*</span>
                        </span>
                        <Select
                            value={draft.cli}
                            onValueChange={(cli) => setDraft({ ...draft, cli })}
                            options={agents.map((agent) => ({ value: agent.id, label: agent.label }))}
                        />
                    </label>
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("repoSchedules.schedule")} <span aria-hidden>*</span>
                        </span>
                        <CronScheduleField
                            schedule={draft.schedule}
                            timezone={draft.timezone}
                            onSchedule={(schedule) => setDraft({ ...draft, schedule })}
                            onTimezone={(timezone) => setDraft({ ...draft, timezone })}
                            error={issue("schedule") ?? issue("timezone")}
                        />
                    </div>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("repoSchedules.prompt")} <span aria-hidden>*</span>
                        </span>
                        <Textarea
                            rows={3}
                            maxLength={SESSION_SCHEDULE_PROMPT_MAX}
                            value={draft.prompt}
                            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                            placeholder={t("repoSchedules.promptPlaceholder")}
                        />
                    </label>
                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                            {t("repoSchedules.cancel")}
                        </Button>
                        <Button size="sm" onClick={save} disabled={pending} aria-disabled={!parsed?.success}>
                            {draft.id ? t("repoSchedules.save") : t("repoSchedules.add")}
                        </Button>
                    </div>
                </div>
            ) : rows !== undefined ? (
                <div>
                    <Button size="sm" variant="outline" onClick={startNew} disabled={agents.length === 0}>
                        {t("repoSchedules.new")}
                    </Button>
                </div>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
        </section>
    );
}
