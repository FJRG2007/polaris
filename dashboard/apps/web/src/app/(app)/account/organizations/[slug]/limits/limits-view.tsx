"use client";

/**
 * Each thing an organization may be capped on: how much is in use, the cap, and
 * a bar between them. A platform administrator gets a field per row and one Save;
 * everybody else reads the same rows and is told who can change them.
 *
 * The rows are drawn from the last reading this tab saw while a fresh one is
 * fetched, so coming back to the screen does not flash a skeleton. Fields are
 * checked as they are typed against the schema the server saves with; an empty
 * one is "no limit", never an error. Saving shows the new caps at once and puts
 * the old ones back if the server refuses them.
 */

import * as quotas from "@/lib/orgs/quotas";
import { runAction } from "@/lib/run-action";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Input, Skeleton, cn, useToast } from "@polaris/ui";
import { loadOrgQuotaAction, saveOrgQuotaAction, type OrgQuotaView } from "./actions";

type Drafts = Record<quotas.OrgQuotaDimension, string>;

const cacheKey = (orgId: string) => `org.limits:${orgId}`;

function readCache(orgId: string): OrgQuotaView | null {
    try {
        const raw = sessionStorage.getItem(cacheKey(orgId));
        return raw ? (JSON.parse(raw) as OrgQuotaView) : null;
    } catch {
        return null;
    }
}

function writeCache(orgId: string, view: OrgQuotaView): void {
    try {
        sessionStorage.setItem(cacheKey(orgId), JSON.stringify(view));
    } catch {
        // Storage is a convenience; the screen works without it.
    }
}

function draftsOf(limits: quotas.OrgQuotaLimits): Drafts {
    return Object.fromEntries(
        quotas.ORG_QUOTA_DIMENSIONS.map((dimension) => [
            dimension,
            limits[dimension] === null ? "" : String(limits[dimension])
        ])
    ) as Drafts;
}

export function LimitsView({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
    const t = useTranslations("accountOrgs");
    const locale = useLocale();
    const toast = useToast();
    const [view, setView] = useState<OrgQuotaView | null>(null);
    const [drafts, setDrafts] = useState<Drafts | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const number = useMemo(
        () => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
        [locale]
    );

    const load = useCallback(async () => {
        setLoading(true);
        const result = await runAction(() => loadOrgQuotaAction(orgId), setError);
        setLoading(false);
        if (!result) return;
        if (result.error || !result.view) {
            setError(result.error ?? t("quotas.loadFailed"));
            return;
        }
        const fresh = result.view;
        setError("");
        setView(fresh);
        setDrafts((current) => current ?? draftsOf(fresh.limits));
        writeCache(orgId, fresh);
    }, [orgId, t]);

    useEffect(() => {
        const cached = readCache(orgId);
        if (cached) {
            setView(cached);
            setDrafts(draftsOf(cached.limits));
        }
        void load();
    }, [orgId, load]);

    const parsed = useMemo(
        () => (drafts ? quotas.orgQuotaInputSchema.safeParse(drafts) : null),
        [drafts]
    );
    const problems = useMemo(() => {
        const found: Partial<Record<quotas.OrgQuotaDimension, string>> = {};
        if (parsed && !parsed.success) {
            for (const issue of parsed.error.issues) {
                const dimension = issue.path[0] as quotas.OrgQuotaDimension;
                if (!found[dimension])
                    found[dimension] = t(issue.message as "quotas.issues.number");
            }
        }
        return found;
    }, [parsed, t]);
    const unchanged =
        parsed?.success === true &&
        view !== null &&
        quotas.ORG_QUOTA_DIMENSIONS.every(
            (dimension) => parsed.data[dimension] === view.limits[dimension]
        );

    const save = async () => {
        if (!view || !parsed?.success || unchanged) return;
        const previous = view;
        const next = { ...view, limits: parsed.data };
        setView(next);
        setBusy(true);
        setError("");
        const result = await runAction(() => saveOrgQuotaAction(orgId, drafts), setError);
        setBusy(false);
        if (!result || result.error || !result.limits) {
            setView(previous);
            if (result?.error) setError(result.error);
            return;
        }
        const saved = { ...previous, limits: result.limits };
        setView(saved);
        setDrafts(draftsOf(result.limits));
        writeCache(orgId, saved);
        toast.show({ title: t("quotas.saved") });
    };

    const amount = (dimension: quotas.OrgQuotaDimension, value: number) =>
        dimension === "cpus" || dimension === "memoryMb"
            ? t(`quotas.units.${dimension}`, { value: number.format(value) })
            : number.format(value);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                    <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                        {canEdit ? t("quotas.blankHint") : t("quotas.adminsOnly")}
                    </p>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void load()}
                        disabled={loading}
                        aria-label={t("quotas.refresh")}
                        title={t("quotas.refresh")}
                    >
                        <RefreshCw
                            className={loading ? "size-4 animate-spin" : "size-4"}
                            aria-hidden
                        />
                    </Button>
                </div>

                <ul className="flex flex-col gap-4" aria-busy={view === null}>
                    {quotas.ORG_QUOTA_DIMENSIONS.map((dimension) => {
                        const label = t(`quotas.dimensions.${dimension}`);
                        if (!view) {
                            return (
                                <li key={dimension} className="flex flex-col gap-1.5">
                                    <span className="text-sm font-medium">{label}</span>
                                    <Skeleton className="h-2 w-full rounded-full" />
                                </li>
                            );
                        }
                        const used = view.usage[dimension];
                        const limit = view.limits[dimension];
                        const share =
                            limit === null
                                ? null
                                : limit === 0
                                  ? used > 0
                                      ? 100
                                      : 0
                                  : (used / limit) * 100;
                        const over = limit !== null && used > limit;
                        const full = limit !== null && used >= limit;
                        const fieldId = `org-limit-${dimension}`;
                        const problem = problems[dimension];
                        return (
                            <li key={dimension} className="flex flex-col gap-1.5">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                    <span className="text-sm font-medium">{label}</span>
                                    <span
                                        className={cn(
                                            "min-w-0 text-sm tabular-nums",
                                            over
                                                ? "text-danger"
                                                : full
                                                  ? "text-warning-ink"
                                                  : "text-muted-foreground"
                                        )}
                                    >
                                        {limit === null
                                            ? `${t("quotas.inUse", { used: amount(dimension, used) })} - ${t("quotas.noLimit")}`
                                            : t("quotas.usedOf", {
                                                  used: amount(dimension, used),
                                                  limit: amount(dimension, limit)
                                              })}
                                        {over ? ` - ${t("quotas.over")}` : ""}
                                    </span>
                                </div>
                                {share !== null ? (
                                    <div
                                        className="bg-muted h-2 overflow-hidden rounded-full"
                                        role="progressbar"
                                        aria-label={label}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={Math.min(100, Math.round(share))}
                                    >
                                        <div
                                            className={cn(
                                                "h-full rounded-full",
                                                over || share >= 100
                                                    ? "bg-danger"
                                                    : share >= 80
                                                      ? "bg-warning"
                                                      : "bg-primary"
                                            )}
                                            style={{ width: `${Math.min(100, share)}%` }}
                                        />
                                    </div>
                                ) : null}
                                {canEdit && drafts ? (
                                    <div className="flex flex-col gap-1">
                                        <label htmlFor={fieldId} className="sr-only">
                                            {t("quotas.fieldLabel", { dimension: label })}
                                        </label>
                                        <Input
                                            id={fieldId}
                                            className="w-40"
                                            inputMode={dimension === "cpus" ? "decimal" : "numeric"}
                                            autoComplete="off"
                                            placeholder={t("quotas.noLimit")}
                                            value={drafts[dimension]}
                                            aria-invalid={problem ? true : undefined}
                                            aria-describedby={
                                                problem ? `${fieldId}-error` : undefined
                                            }
                                            onChange={(event) =>
                                                setDrafts((current) =>
                                                    current
                                                        ? {
                                                              ...current,
                                                              [dimension]: event.target.value
                                                          }
                                                        : current
                                                )
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") void save();
                                            }}
                                        />
                                        {problem ? (
                                            <p
                                                id={`${fieldId}-error`}
                                                className="text-danger text-xs"
                                            >
                                                {problem}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>

                {canEdit ? (
                    <div>
                        <Button
                            size="sm"
                            onClick={() => void save()}
                            disabled={busy || !view || !parsed?.success || unchanged}
                            aria-disabled={busy || !view || !parsed?.success || unchanged}
                        >
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("quotas.save")}
                        </Button>
                    </div>
                ) : null}

                {error ? <p className="text-danger text-sm">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
