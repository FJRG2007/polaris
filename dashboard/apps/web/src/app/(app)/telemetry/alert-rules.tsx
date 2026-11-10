"use client";

/**
 * A project's alert rules: when one of its issues is new, happens too often or
 * comes back after being resolved, who is told. A list of rules with a switch
 * each, a dialog to write one, and the history of when they fired.
 */

import Link from "next/link";
import { issueHref } from "./paths";
import * as actions from "./actions";
import * as core from "@polaris/core";
import * as polls from "./telemetry-polls";
import { runAction } from "@/lib/run-action";
import { useCursorList } from "./use-cursor-list";
import type { NamespaceKey } from "@/lib/i18n/types";
import { RelativeTime } from "@/components/relative-time";
import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AlertFireRow, AlertRuleView } from "@/lib/telemetry/alerts";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { ALERT_TRIGGERS, alertRuleSchema, MAX_RECIPIENTS, type AlertTrigger } from "@/lib/telemetry/alert-schema";
import {
    Badge,
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";

type Key = NamespaceKey<"telemetry">;

export function AlertRules({ projectId }: { projectId: string }) {
    const t = useTranslations("telemetry");
    const [rules, setRules] = useState<readonly AlertRuleView[] | null>(null);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<AlertRuleView | "new" | null>(null);
    const [removing, setRemoving] = useState<AlertRuleView | null>(null);
    const [historyVersion, setHistoryVersion] = useState(0);

    const load = useCallback(async () => {
        const result = await polls.telemetryAlertRules({ projectId });
        if (!result || result.error || !result.data) {
            setError(result?.error ?? t("alerts.errors.read"));
            setRules((current) => current ?? []);
            return;
        }
        setError("");
        setRules(result.data);
    }, [projectId, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const toggle = async (rule: AlertRuleView, enabled: boolean) => {
        setRules((current) => current?.map((row) => (row.id === rule.id ? { ...row, enabled } : row)) ?? null);
        const result = await runAction(
            () => actions.setAlertRuleEnabledAction({ projectId, ruleId: rule.id, enabled }),
            setError
        );
        if (!result || result.error) {
            setRules(
                (current) => current?.map((row) => (row.id === rule.id ? { ...row, enabled: !enabled } : row)) ?? null
            );
            if (result?.error) setError(result.error);
        }
    };

    const add = (
        <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-3.5" />
            {t("alerts.add")}
        </Button>
    );

    return (
        <div className="flex min-w-0 flex-col gap-6">
            <section className="flex min-w-0 flex-col gap-3" aria-label={t("alerts.title")}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h3 className="text-sm font-medium">{t("alerts.title")}</h3>
                        <p className="text-xs text-muted-foreground">{t("alerts.hint")}</p>
                    </div>
                    {rules && rules.length > 0 ? add : null}
                </div>
                {error && (
                    <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                {rules === null ? (
                    <div className="flex flex-col gap-2" aria-busy="true">
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-16 w-full" />
                    </div>
                ) : rules.length === 0 ? (
                    <EmptyState
                        icon={<BellRing />}
                        title={t("alerts.none")}
                        description={t("alerts.noneHint")}
                        action={add}
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {rules.map((rule) => (
                            <RuleRow
                                key={rule.id}
                                rule={rule}
                                onToggle={(enabled) => void toggle(rule, enabled)}
                                onEdit={() => setEditing(rule)}
                                onDelete={() => setRemoving(rule)}
                            />
                        ))}
                    </ul>
                )}
            </section>

            <AlertHistory projectId={projectId} version={historyVersion} />

            {editing && (
                <RuleDialog
                    projectId={projectId}
                    rule={editing === "new" ? null : editing}
                    onOpenChange={(open) => {
                        if (!open) setEditing(null);
                    }}
                    onSaved={async () => {
                        setEditing(null);
                        await load();
                    }}
                />
            )}
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => {
                    if (!open) setRemoving(null);
                }}
                name={removing?.name ?? ""}
                kind={t("alerts.kind")}
                requireTyping={false}
                description={t("alerts.deleteBody")}
                confirmLabel={t("alerts.deleteConfirm")}
                onConfirm={async () => {
                    const rule = removing;
                    setRemoving(null);
                    if (!rule) return;
                    setRules((current) => current?.filter((row) => row.id !== rule.id) ?? null);
                    const result = await runAction(
                        () => actions.deleteAlertRuleAction({ projectId, ruleId: rule.id }),
                        setError
                    );
                    if (!result || result.error) {
                        if (result?.error) setError(result.error);
                        await load();
                    } else setHistoryVersion((value) => value + 1);
                }}
            />
        </div>
    );
}

/** What a rule does, in one sentence. */
function useSummary() {
    const t = useTranslations("telemetry");
    return (rule: Pick<AlertRuleView, "trigger" | "threshold" | "windowMinutes">) =>
        rule.trigger === "frequency"
            ? t("alerts.summary.frequency", { count: rule.threshold, minutes: rule.windowMinutes })
            : t(`alerts.summary.${rule.trigger}` as Key);
}

function RuleRow({
    rule,
    onToggle,
    onEdit,
    onDelete
}: {
    rule: AlertRuleView;
    onToggle: (enabled: boolean) => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const t = useTranslations("telemetry");
    const summary = useSummary();
    const who = [
        ...(rule.notifyMembers ? [t("alerts.members")] : []),
        ...rule.people.map((person) => person.name)
    ].join(", ");
    return (
        <li className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <button
                    type="button"
                    onClick={onEdit}
                    className="min-w-0 truncate text-left text-sm font-medium hover:underline"
                    title={rule.name}
                >
                    {rule.name}
                </button>
                <p className="text-xs text-muted-foreground">{summary(rule)}</p>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {rule.levels.map((level) => (
                        <Badge key={level} variant="neutral">
                            {t(`search.levels.${level}` as Key)}
                        </Badge>
                    ))}
                    {rule.environment && (
                        <Badge variant="neutral" className="max-w-48 truncate" title={rule.environment}>
                            {t("search.environmentIs", { value: rule.environment })}
                        </Badge>
                    )}
                </div>
                <p className="min-w-0 truncate text-xs text-muted-foreground" title={who}>
                    {t("alerts.notifies", { who: who || t("alerts.nobody") })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {rule.lastFiredAt ? (
                        <>
                            {t("alerts.lastFired")} <RelativeTime iso={rule.lastFiredAt} />
                        </>
                    ) : (
                        t("alerts.neverFired")
                    )}
                </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
                <Switch checked={rule.enabled} aria-label={t("alerts.enabled")} onChange={onToggle} />
                <Button variant="ghost" size="icon-sm" aria-label={t("alerts.edit")} title={t("alerts.edit")} onClick={onEdit}>
                    <Pencil aria-hidden="true" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("alerts.delete")}
                    title={t("alerts.delete")}
                    onClick={onDelete}
                >
                    <Trash2 aria-hidden="true" />
                </Button>
            </div>
        </li>
    );
}

interface Draft {
    name: string;
    trigger: AlertTrigger;
    threshold: string;
    windowMinutes: string;
    levels: string[];
    environment: string;
    people: readonly PickedPerson[];
    notifyMembers: boolean;
    throttleMinutes: string;
    enabled: boolean;
}

function draftOf(rule: AlertRuleView | null): Draft {
    return {
        name: rule?.name ?? "",
        trigger: rule?.trigger ?? "new",
        threshold: String(rule?.threshold || 100),
        windowMinutes: String(rule?.windowMinutes || 60),
        levels: [...(rule?.levels ?? [])],
        environment: rule?.environment ?? "",
        people: rule?.people ?? [],
        notifyMembers: rule?.notifyMembers ?? true,
        throttleMinutes: String(rule?.throttleMinutes ?? 60),
        enabled: rule?.enabled ?? true
    };
}

/** A number field's value, or NaN for one that is not a whole number, which
 *  the schema then refuses rather than a guess being saved. */
function whole(value: string): number {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function ruleOfDraft(draft: Draft) {
    return {
        name: draft.name,
        enabled: draft.enabled,
        trigger: draft.trigger,
        threshold: draft.trigger === "frequency" ? whole(draft.threshold) : 0,
        windowMinutes: draft.trigger === "frequency" ? whole(draft.windowMinutes) : 0,
        levels: draft.levels,
        environment: draft.environment,
        recipients: draft.people.map((person) => person.id),
        notifyMembers: draft.notifyMembers,
        throttleMinutes: whole(draft.throttleMinutes)
    };
}

function RuleDialog({
    projectId,
    rule,
    onOpenChange,
    onSaved
}: {
    projectId: string;
    rule: AlertRuleView | null;
    onOpenChange: (open: boolean) => void;
    onSaved: () => Promise<void>;
}) {
    const t = useTranslations("telemetry");
    const [draft, setDraft] = useState<Draft>(() => draftOf(rule));
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const initial = useMemo(() => JSON.stringify(alertRuleSchema.safeParse(ruleOfDraft(draftOf(rule))).data ?? null), [rule]);
    const parsed = alertRuleSchema.safeParse(ruleOfDraft(draft));
    const problem = (field: string): string | null => {
        if (parsed.success) return null;
        const issue = parsed.error.issues.find((entry) => entry.path[0] === field);
        if (!issue) return null;
        if (field === "threshold") return t("alerts.errors.threshold");
        if (field === "windowMinutes") return t("alerts.errors.window");
        if (field === "throttleMinutes") return t("alerts.errors.throttle");
        if (field === "recipients") return t("alerts.errors.nobody");
        return null;
    };
    const unchanged = parsed.success && rule !== null && JSON.stringify(parsed.data) === initial;
    const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

    const save = async () => {
        if (!parsed.success || unchanged) return;
        setSaving(true);
        const result = await runAction(
            () => actions.saveAlertRuleAction({ projectId, ruleId: rule?.id ?? null, rule: parsed.data }),
            setError
        );
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        await onSaved();
    };

    const search = useCallback((query: string) => actions.searchAssigneesAction(projectId, query), [projectId]);
    const fieldError = (text: string | null) =>
        text ? <p className="text-xs text-danger">{text}</p> : null;

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{rule ? t("alerts.form.editTitle") : t("alerts.form.newTitle")}</DialogTitle>
                    <DialogDescription>{t("alerts.form.hint")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto overscroll-contain"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("alerts.form.name")} *</span>
                        <Input
                            value={draft.name}
                            maxLength={80}
                            placeholder={t("alerts.form.namePlaceholder")}
                            onChange={(event) => set({ name: event.target.value })}
                        />
                    </label>

                    <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("alerts.form.when")}</span>
                        <Select
                            value={draft.trigger}
                            onValueChange={(value) => set({ trigger: value as AlertTrigger })}
                            className="w-full"
                            options={ALERT_TRIGGERS.map((trigger) => ({
                                value: trigger,
                                label: t(`alerts.triggers.${trigger}` as Key)
                            }))}
                        />
                    </div>

                    {draft.trigger === "frequency" && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex min-w-0 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">{t("alerts.form.threshold")} *</span>
                                <Input
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    value={draft.threshold}
                                    onChange={(event) => set({ threshold: event.target.value })}
                                />
                                {fieldError(problem("threshold"))}
                            </label>
                            <label className="flex min-w-0 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">{t("alerts.form.window")} *</span>
                                <Input
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    value={draft.windowMinutes}
                                    onChange={(event) => set({ windowMinutes: event.target.value })}
                                />
                                {fieldError(problem("windowMinutes"))}
                            </label>
                        </div>
                    )}

                    <fieldset className="flex flex-col gap-1.5">
                        <legend className="text-xs text-muted-foreground">{t("alerts.form.levels")}</legend>
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                            {core.TELEMETRY_LEVELS.map((level) => (
                                <label key={level} className="flex items-center gap-1.5 text-sm">
                                    <Checkbox
                                        checked={draft.levels.includes(level)}
                                        onChange={(event) =>
                                            set({
                                                levels: event.target.checked
                                                    ? [...draft.levels, level]
                                                    : draft.levels.filter((entry) => entry !== level)
                                            })
                                        }
                                    />
                                    {t(`search.levels.${level}` as Key)}
                                </label>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("alerts.form.levelsHint")}</p>
                    </fieldset>

                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("alerts.form.environment")}</span>
                        <Input
                            value={draft.environment}
                            maxLength={100}
                            placeholder={t("alerts.form.environmentPlaceholder")}
                            onChange={(event) => set({ environment: event.target.value })}
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-xs text-muted-foreground">{t("alerts.form.notify")}</span>
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={draft.notifyMembers}
                                onChange={(event) => set({ notifyMembers: event.target.checked })}
                            />
                            {t("alerts.form.members")}
                        </label>
                        <PeoplePicker
                            picked={draft.people}
                            onChange={(people) => set({ people })}
                            max={MAX_RECIPIENTS}
                            label={t("alerts.form.findPeople")}
                            search={search}
                        />
                        {fieldError(problem("recipients"))}
                    </div>

                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("alerts.form.throttle")} *</span>
                        <Input
                            type="number"
                            min={1}
                            inputMode="numeric"
                            className="w-32"
                            value={draft.throttleMinutes}
                            onChange={(event) => set({ throttleMinutes: event.target.value })}
                        />
                        <span className="text-xs text-muted-foreground">{t("alerts.form.throttleHint")}</span>
                        {fieldError(problem("throttleMinutes"))}
                    </label>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                    <button type="submit" hidden />
                </form>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("alerts.form.cancel")}
                    </Button>
                    <Button
                        aria-disabled={!parsed.success || unchanged || saving}
                        disabled={saving}
                        onClick={() => void save()}
                    >
                        {t("alerts.form.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** When the rules fired, newest first, read as the list scrolls. */
function AlertHistory({ projectId, version }: { projectId: string; version: number }) {
    const t = useTranslations("telemetry");
    const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);
    const list = useCursorList<AlertFireRow>(
        (cursor, signal) => polls.telemetryAlertHistory({ projectId, cursor }, signal),
        `${projectId}|${version}`
    );
    const { more, loadMore } = list;
    useEffect(() => {
        if (!sentinel || !more) return;
        const watcher = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) loadMore();
        });
        watcher.observe(sentinel);
        return () => watcher.disconnect();
    }, [sentinel, more, loadMore]);

    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={t("alerts.history.title")}>
            <h3 className="text-sm font-medium">{t("alerts.history.title")}</h3>
            {list.items === null ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : list.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">{list.error || t("alerts.history.none")}</p>
            ) : (
                <ol className="flex max-h-96 flex-col gap-1 overflow-y-auto overscroll-contain">
                    {list.items.map((row) => (
                        <li
                            key={row.id}
                            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        >
                            <span className="min-w-0 max-w-48 truncate font-medium" title={row.ruleName}>
                                {row.ruleName}
                            </span>
                            <Link
                                href={issueHref(projectId, row.issueId)}
                                className="min-w-0 flex-1 truncate text-primary hover:underline"
                                title={row.issueTitle}
                            >
                                {row.issueTitle}
                            </Link>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {t("alerts.history.notified", { count: row.notified })}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                <RelativeTime iso={row.at} />
                            </span>
                        </li>
                    ))}
                    {more && (
                        <li ref={setSentinel} aria-busy="true">
                            <Skeleton className="h-8 w-full" />
                        </li>
                    )}
                </ol>
            )}
        </section>
    );
}
