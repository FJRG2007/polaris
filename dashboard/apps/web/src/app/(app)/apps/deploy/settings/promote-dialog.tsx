"use client";

/**
 * Promoting one environment into another, and the history of promotions.
 *
 * The dialog asks the server what would be overwritten before anything runs -
 * the same plan the promotion follows - and only offers what the reader is
 * allowed to do. Replacing data, or promoting into production, takes typing the
 * target's name, because neither can be taken back from this screen.
 */

import { useRouter } from "next/navigation";
import { SettingsCard } from "../project-settings";
import { useEffect, useState, useTransition } from "react";
import * as polls from "../deploy-polls";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ProjectEnvironmentView } from "@/lib/deploy-project-service";
import type { PromotionPreview, PromotionView } from "@/lib/deploy/promotion";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Checkbox
} from "@polaris/ui";
import { promoteEnvironmentAction } from "../project-actions";

export function PromoteDialog({
    environments,
    canCopyData,
    source,
    onClose
}: {
    /** Whether the reader may replace data, as the page was told. */
    canCopyData: boolean;
    environments: readonly ProjectEnvironmentView[];
    /** The environment to promote from; null keeps the dialog closed. */
    source: ProjectEnvironmentView | null;
    onClose: () => void;
}) {
    const t = useTranslations("deploySettings");
    const router = useRouter();
    const [targetId, setTargetId] = useState("");
    const [includeData, setIncludeData] = useState(false);
    const [typed, setTyped] = useState("");
    const [preview, setPreview] = useState<{
        preview: PromotionPreview;
        canDeploy: boolean;
        canCopyData: boolean;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const targets = environments.filter((environment) => environment.id !== source?.id);

    // Open on the environment this one usually moves to: development into
    // staging, staging into production, anything else into the default one.
    useEffect(() => {
        if (!source) return;
        const next =
            source.stage === "development"
                ? "staging"
                : source.stage === "staging"
                  ? "production"
                  : null;
        const pick =
            targets.find((environment) => next !== null && environment.stage === next) ??
            targets.find((environment) => environment.isDefault) ??
            targets[0];
        setTargetId(pick?.id ?? "");
        setIncludeData(false);
        setTyped("");
        setError(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [source?.id]);

    useEffect(() => {
        if (!source || !targetId) return;
        let current = true;
        setPreview(null);
        void polls
            .promotionPreview({
                sourceEnvironmentId: source.id,
                targetEnvironmentId: targetId
            })
            .then(
                (result) => {
                    if (!current) return;
                    if (result.error || !result.preview)
                        setError(result.error ?? t("promotion.loadFailed"));
                    else {
                        setError(null);
                        setPreview({
                            preview: result.preview,
                            canDeploy: result.canDeploy ?? false,
                            canCopyData: result.canCopyData ?? false
                        });
                    }
                },
                () => current && setError(t("promotion.loadFailed"))
            );
        return () => {
            current = false;
        };
    }, [source, targetId, t]);

    const target = targets.find((environment) => environment.id === targetId) ?? null;
    const plan = preview?.preview.plan ?? null;
    const needsName = includeData || target?.stage === "production";
    const nothing =
        plan !== null &&
        plan.services.length === 0 &&
        (!includeData || plan.databases.length === 0);
    const blocked = !preview?.canDeploy
        ? t("promotion.cannotDeploy")
        : includeData && !preview.canCopyData
          ? t("promotion.cannotCopyData")
          : preview.preview.running
            ? t("promotion.running", { name: preview.preview.targetName })
            : nothing
              ? t("promotion.nothing")
              : null;
    const ready =
        preview !== null && blocked === null && (!needsName || typed.trim() === target?.name);

    function submit() {
        if (!source || !target || !ready) return;
        setError(null);
        startTransition(async () => {
            const result = await promoteEnvironmentAction({
                sourceEnvironmentId: source.id,
                targetEnvironmentId: target.id,
                includeData
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onClose();
            router.refresh();
        });
    }

    return (
        <Dialog open={source !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("promotion.title", { name: source?.name ?? "" })}</DialogTitle>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("promotion.into")}
                        </span>
                        <Select
                            value={targetId}
                            onValueChange={(value) => {
                                setTargetId(value);
                                setTyped("");
                            }}
                            aria-label={t("promotion.into")}
                            options={targets.map((environment) => ({
                                value: environment.id,
                                label: environment.stage
                                    ? `${environment.name} (${t(`environments.stages.${environment.stage}`)})`
                                    : environment.name
                            }))}
                        />
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                            checked={includeData}
                            disabled={!canCopyData || (preview !== null && !preview.canCopyData)}
                            onChange={(event) => {
                                setIncludeData(event.target.checked);
                                setTyped("");
                            }}
                            className="mt-0.5"
                        />
                        <span className="min-w-0">
                            {t("promotion.includeData")}
                            <span className="block text-xs text-muted-foreground">
                                {!canCopyData || (preview !== null && !preview.canCopyData)
                                    ? t("promotion.cannotCopyData")
                                    : t("promotion.includeDataHint")}
                            </span>
                        </span>
                    </label>

                    {plan === null && !error ? (
                        <div className="h-20 animate-pulse rounded-md bg-muted" aria-hidden />
                    ) : plan ? (
                        <div className="flex max-h-64 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain rounded-md border border-border/60 p-3 text-sm">
                            <p className="font-medium">
                                {t("promotion.overwrites", { name: target?.name ?? "" })}
                            </p>
                            {plan.services.length === 0 &&
                            (!includeData || plan.databases.length === 0) ? (
                                <p className="text-muted-foreground">{t("promotion.nothing")}</p>
                            ) : (
                                <ul className="flex flex-col gap-1">
                                    {plan.services.map((pair) => (
                                        <li
                                            key={pair.targetId}
                                            className="truncate"
                                            title={pair.name}
                                        >
                                            {t("promotion.serviceLine", { name: pair.name })}
                                        </li>
                                    ))}
                                    {includeData &&
                                        plan.databases.map((pair) => (
                                            <li
                                                key={pair.targetId}
                                                className="truncate text-danger"
                                                title={pair.name}
                                            >
                                                {t("promotion.databaseLine", { name: pair.name })}
                                            </li>
                                        ))}
                                </ul>
                            )}
                            {plan.skipped.length > 0 && (
                                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    {plan.skipped.map((skip) => (
                                        <li
                                            key={`${skip.kind}:${skip.name}`}
                                            className="truncate"
                                            title={skip.name}
                                        >
                                            {t("promotion.skippedLine", {
                                                name: skip.name,
                                                reason: t(`promotion.reasons.${skip.reason}`)
                                            })}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {t("promotion.noDowntime")}
                            </p>
                        </div>
                    ) : null}

                    {needsName && blocked === null && preview && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("promotion.typeName", { name: target?.name ?? "" })}{" "}
                                <span aria-hidden>*</span>
                            </span>
                            <Input
                                value={typed}
                                onChange={(event) => setTyped(event.target.value)}
                                spellCheck={false}
                                autoComplete="off"
                                onKeyDown={(event) => event.key === "Enter" && submit()}
                            />
                        </label>
                    )}
                    {blocked && preview && (
                        <p className="text-sm text-muted-foreground">{blocked}</p>
                    )}
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            {t("environments.cancel")}
                        </Button>
                        <Button
                            variant={includeData ? "danger" : "primary"}
                            onClick={submit}
                            disabled={pending || !ready}
                            aria-disabled={!ready}
                        >
                            {t("promotion.confirm", { name: target?.name ?? "" })}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The latest promotions in the project, with how each service went. */
export function PromotionHistory({ projectId, version }: { projectId: string; version: number }) {
    const t = useTranslations("deploySettings");
    const display = useDisplayFormat();
    const [promotions, setPromotions] = useState<PromotionView[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let current = true;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = () => {
            void polls.promotions(projectId, controller.signal).then(
                (result) => {
                    if (!current) return;
                    if (result.error) {
                        setError(result.error);
                        return;
                    }
                    const rows = result.promotions ?? [];
                    setPromotions(rows);
                    // Follow one that is still running, and stop once none is.
                    if (rows.some((row) => row.status === "running"))
                        timer = setTimeout(load, 5000);
                },
                () => {
                    if (current) timer = setTimeout(load, 5000);
                }
            );
        };
        load();
        return () => {
            current = false;
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [projectId, version]);

    return (
        <SettingsCard
            title={t("promotion.historyTitle")}
            description={t("promotion.historyDescription")}
        >
            {error && <p className="text-sm text-danger">{error}</p>}
            {promotions === null && !error ? (
                <div className="h-16 animate-pulse rounded-md bg-muted" aria-hidden />
            ) : promotions && promotions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("promotion.historyEmpty")}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-border/40 rounded-md border border-border/60">
                    {(promotions ?? []).map((row) => (
                        <li
                            key={row.id}
                            className="flex min-w-0 flex-col gap-1 px-3 py-2.5 text-sm"
                        >
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                                <span className="min-w-0 truncate font-medium">
                                    {t("promotion.historyLine", {
                                        from: row.sourceName,
                                        to: row.targetName
                                    })}
                                    {row.includeData ? t("promotion.withData") : ""}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {t(`promotion.status.${row.status}`)} -{" "}
                                    {display.date(row.createdAt)}
                                </span>
                            </div>
                            {row.steps.length > 0 && (
                                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                                    {row.steps.map((step, index) => (
                                        <li
                                            key={`${step.kind}:${step.name}:${index}`}
                                            className="truncate"
                                            title={step.detail ?? step.name}
                                        >
                                            {t(`promotion.outcome.${step.outcome}`, {
                                                name: step.name
                                            })}
                                            {step.reason
                                                ? ` - ${t(`promotion.reasons.${step.reason}`)}`
                                                : ""}
                                            {step.note
                                                ? ` - ${t(`promotion.notes.${step.note}`)}`
                                                : ""}
                                            {step.detail ? ` - ${step.detail}` : ""}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </SettingsCard>
    );
}
