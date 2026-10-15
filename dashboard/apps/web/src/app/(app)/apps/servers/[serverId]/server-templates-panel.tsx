"use client";

/**
 * The Templates tab of a server: what it is expected to look like, whether it
 * does, each difference in words, and the buttons that put it back.
 */

import type { DriftItem } from "@polaris/core";
import { TemplatesDialog } from "./templates-dialog";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { RefreshCw, Settings2, Wrench, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Select, Skeleton, Switch } from "@polaris/ui";
import type { AssignmentView, TemplateView } from "@/lib/server-templates/service";
import {
    assignTemplateAction,
    checkAssignmentAction,
    fixAssignmentAction,
    hostAssignmentsAction,
    listTemplatesAction,
    setAutoFixAction,
    unassignTemplateAction
} from "../template-actions";

type T = ReturnType<typeof useTranslations<"servers">>;

export function driftWords(t: T, item: DriftItem): string {
    return t(`templates.drift.${item.code}`, {
        name: item.name,
        expected: item.expected ?? "",
        actual: item.actual ?? "-"
    });
}

export function ServerTemplatesPanel({
    hostId,
    serverName,
    root
}: {
    hostId: string;
    serverName: string;
    /** Whether Polaris reaches root here; a fix needs it. */
    root: boolean;
}) {
    const t = useTranslations("servers");
    const [confirm, confirmDialog] = useConfirm();
    const [assignments, setAssignments] = useState<AssignmentView[] | null>(null);
    const [templates, setTemplates] = useState<TemplateView[] | null>(null);
    const [picked, setPicked] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [managing, setManaging] = useState(false);

    const load = useCallback(async () => {
        const [mine, all] = await Promise.all([hostAssignmentsAction(hostId), listTemplatesAction()]);
        if (mine.ok) setAssignments(mine.value);
        else setError(mine.error);
        if (all.ok) setTemplates(all.value);
    }, [hostId]);

    useEffect(() => {
        void load();
    }, [load]);

    const replace = (next: AssignmentView) =>
        setAssignments((current) => {
            const list = current ?? [];
            return list.some((row) => row.id === next.id)
                ? list.map((row) => (row.id === next.id ? next : row))
                : [...list, next];
        });

    async function run<R>(key: string, work: () => Promise<{ ok: true; value: R } | { ok: false; error: string }>) {
        setBusy(key);
        setError(null);
        try {
            const result = await work();
            if (!result.ok) setError(result.error);
            return result.ok ? result.value : null;
        } finally {
            setBusy(null);
        }
    }

    const assigned = new Set((assignments ?? []).map((row) => row.templateId));
    const open = (templates ?? []).filter((template) => !assigned.has(template.id));

    async function assign() {
        if (!picked) return;
        const value = await run("assign", () => assignTemplateAction({ templateId: picked, hostId, autoFix: false }));
        if (value) {
            replace(value);
            setPicked("");
        }
    }

    async function fix(row: AssignmentView, item?: DriftItem) {
        const ok = await confirm(
            item
                ? {
                      title: t("templates.confirmFixOne.title", { server: serverName }),
                      description: driftWords(t, item),
                      confirmLabel: t("templates.confirmFixOne.confirm")
                  }
                : {
                      title: t("templates.confirmFixAll.title", { name: row.templateName }),
                      description: t("templates.confirmFixAll.body", { server: serverName }),
                      confirmLabel: t("templates.confirmFixAll.confirm")
                  }
        );
        if (!ok) return;
        const value = await run(`fix:${row.id}`, () =>
            fixAssignmentAction({ assignmentId: row.id, keys: item ? [item.key] : undefined })
        );
        if (value) replace(value);
    }

    async function unassign(row: AssignmentView) {
        const ok = await confirm({
            title: t("templates.confirmRemove.title", { name: row.templateName }),
            description: t("templates.confirmRemove.body"),
            confirmLabel: t("templates.confirmRemove.confirm"),
            danger: true
        });
        if (!ok) return;
        const removed = await run(`rm:${row.id}`, () => unassignTemplateAction(row.id));
        if (removed !== null) setAssignments((current) => (current ?? []).filter((entry) => entry.id !== row.id));
    }

    async function toggleAutoFix(row: AssignmentView, autoFix: boolean) {
        replace({ ...row, autoFix });
        const result = await setAutoFixAction(row.id, autoFix);
        if (!result.ok) {
            replace(row);
            setError(result.error);
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("templates.intro")}</p>
                <Button variant="secondary" size="sm" onClick={() => setManaging(true)}>
                    <Settings2 className="size-3.5" /> {t("templates.manage")}
                </Button>
            </div>

            {!root ? <p className="text-xs text-muted-foreground">{t("templates.noRoot")}</p> : null}

            {templates === null ? (
                <Skeleton className="h-8 w-72" />
            ) : open.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                    <div className="w-64 max-w-full">
                        <Select
                            value={picked}
                            onValueChange={setPicked}
                            placeholder={t("templates.pickTemplate")}
                            options={open.map((template) => ({ value: template.id, label: template.name }))}
                        />
                    </div>
                    <Button size="sm" disabled={!picked || busy !== null} onClick={assign}>
                        {t("templates.assign")}
                    </Button>
                </div>
            ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("templates.noTemplates")}</p>
            ) : null}

            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {t(`templates.errors.${error}` as Parameters<T>[0])}
                </p>
            ) : null}

            {assignments === null ? (
                <Skeleton className="h-24 w-full" />
            ) : assignments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("templates.none")}</p>
            ) : (
                <ul className="flex flex-col gap-3">
                    {assignments.map((row) => {
                        const fixable = row.drift.filter((item) => item.fixable);
                        const working = busy === `fix:${row.id}` || busy === `check:${row.id}`;
                        return (
                            <li key={row.id} className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-0 truncate font-medium" title={row.templateName}>
                                        {row.templateName}
                                    </span>
                                    <Badge
                                        variant={
                                            row.status === "compliant"
                                                ? "success"
                                                : row.status === "drifted" || row.status === "failed"
                                                  ? "warning"
                                                  : "neutral"
                                        }
                                    >
                                        {row.status === "drifted"
                                            ? t("templates.status.drifted", { count: row.drift.length })
                                            : t(`templates.status.${row.status}`)}
                                    </Badge>
                                    {row.checkedAt ? (
                                        <span className="text-xs text-muted-foreground">
                                            {t("templates.checkedAt", { when: new Date(row.checkedAt).toLocaleString() })}
                                        </span>
                                    ) : null}
                                    <div className="ml-auto flex items-center gap-1">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={working}
                                            onClick={async () => {
                                                const value = await run(`check:${row.id}`, () => checkAssignmentAction(row.id));
                                                if (value) replace(value);
                                            }}
                                        >
                                            <RefreshCw className={working ? "size-3.5 animate-spin" : "size-3.5"} />
                                            {t("templates.checkNow")}
                                        </Button>
                                        {fixable.length > 0 ? (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={!root || working}
                                                title={root ? undefined : t("templates.errors.noRoot")}
                                                onClick={() => fix(row)}
                                            >
                                                <Wrench className="size-3.5" /> {t("templates.fixAll")}
                                            </Button>
                                        ) : null}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={t("templates.remove")}
                                            title={t("templates.remove")}
                                            disabled={working}
                                            onClick={() => unassign(row)}
                                        >
                                            <X className="size-3.5" />
                                        </Button>
                                    </div>
                                </div>

                                {row.status === "failed" && row.error ? (
                                    <p className="text-xs text-destructive">
                                        {t(`templates.errors.${row.error}` as Parameters<T>[0])}
                                    </p>
                                ) : row.error === "partial" ? (
                                    <p className="text-xs text-destructive">{t("templates.errors.partial")}</p>
                                ) : null}

                                {row.drift.length > 0 ? (
                                    <ul className="flex flex-col divide-y divide-border/50 text-sm">
                                        {row.drift.map((item) => (
                                            <li key={`${item.key}:${item.code}`} className="flex items-center gap-2 py-1.5">
                                                <span className="min-w-0 flex-1 truncate" title={driftWords(t, item)}>
                                                    {driftWords(t, item)}
                                                </span>
                                                {item.fixable ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={!root || working}
                                                        title={root ? undefined : t("templates.errors.noRoot")}
                                                        onClick={() => fix(row, item)}
                                                    >
                                                        {t("templates.fix")}
                                                    </Button>
                                                ) : (
                                                    <span className="shrink-0 text-xs text-muted-foreground">
                                                        {t("templates.manual")}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}

                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Switch
                                        checked={row.autoFix}
                                        disabled={!root}
                                        onChange={(value: boolean) => toggleAutoFix(row, value)}
                                        aria-label={t("templates.autoFix")}
                                    />
                                    <span title={t("templates.autoFixHint")}>{t("templates.autoFix")}</span>
                                </label>
                            </li>
                        );
                    })}
                </ul>
            )}

            <TemplatesDialog
                open={managing}
                onClose={() => {
                    setManaging(false);
                    void load();
                }}
            />
            {confirmDialog}
        </div>
    );
}
