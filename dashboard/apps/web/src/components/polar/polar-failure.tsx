"use client";

/**
 * Why Polar could not answer, and what to do about it.
 *
 * The provider is named and the cause is put in plain words; the person who can
 * fix it gets a link to the key, and everybody else is told who to ask. When
 * another model can serve, one click retries the turn on it. A failure kept in
 * the conversation's history shows the same sentence; only the newest one
 * offers to try again.
 */

import Link from "next/link";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ModelSelectorProvider } from "./elements/model-selector";
import type { PolarFailure, StoredFailure } from "@/lib/polar/provider-failure";

type ModelEntry = ModelSelectorProvider["models"][number];

/**
 * A model that can stand in for the one that failed. A refused key, an empty
 * balance, a rate limit or an outage is the provider's, so the stand-in comes
 * from another one; a model the provider no longer serves can be replaced by
 * any other, its own provider's first. Pure.
 */
export function standIn(
    failure: PolarFailure,
    failedModel: string | null,
    providers: readonly ModelSelectorProvider[]
): ModelEntry | null {
    const models = providers.flatMap((entry) => entry.models);
    if (failure.kind === "model") {
        const others = models.filter((model) => model.model !== failedModel);
        return others.find((model) => model.provider === failure.slug) ?? others[0] ?? null;
    }
    if (failure.kind === "other") return null;
    return models.find((model) => model.provider !== failure.slug) ?? null;
}

export function PolarFailureNotice({
    failure: stored,
    isAdmin,
    providers,
    failedModel,
    onRetry,
    onTryWith
}: {
    /** Why the turn has no answer; null when nothing says why. */
    failure: StoredFailure | null;
    isAdmin: boolean;
    providers: readonly ModelSelectorProvider[];
    failedModel: string | null;
    /** Absent on an older failure in the history: it only says what happened. */
    onRetry?: () => void;
    onTryWith?: (model: ModelEntry) => void;
}) {
    const t = useTranslations("polar");
    const failure: PolarFailure | null = stored?.code === "provider" ? stored : null;
    const alternative = failure && onTryWith ? standIn(failure, failedModel, providers) : null;
    // Only a key problem is somebody's to fix: a limit or an outage passes.
    const keyProblem = failure?.kind === "key" || failure?.kind === "credit";
    const sentence =
        stored?.code === "usage_limit"
            ? t("errors.usageLimit", {
                  used: stored.used,
                  amount: stored.amount,
                  period: t(`usage.periods.${stored.period}`)
              })
            : stored?.code === "file_unreadable"
              ? t("errors.fileUnreadable", { name: stored.name })
              : failure
                ? t(`errors.provider.${failure.kind}`, { provider: failure.provider })
                : t("errors.failed");
    // A limit or a file is not fixed by asking again.
    const retry =
        stored?.code === "usage_limit" || stored?.code === "file_unreadable" ? undefined : onRetry;

    return (
        <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-danger-edge bg-danger-soft p-2 text-sm text-danger-ink"
        >
            <p>{sentence}</p>
            {failure && keyProblem && failure.payer === "instance" && !isAdmin ? (
                <p>{t("errors.provider.askAdmin", { provider: failure.provider })}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {failure && keyProblem && (failure.payer === "own" || isAdmin) ? (
                    <Link
                        href={
                            failure.payer === "own"
                                ? "/account/ai-keys"
                                : "/admin/integrations/models"
                        }
                        className="font-medium underline"
                    >
                        {failure.payer === "own"
                            ? t("errors.provider.ownKey")
                            : t("errors.provider.openKey")}
                    </Link>
                ) : null}
                {alternative && onTryWith ? (
                    <button
                        type="button"
                        className="font-medium underline"
                        onClick={() => onTryWith(alternative)}
                    >
                        {t("errors.provider.tryWith", { model: alternative.name })}
                    </button>
                ) : null}
                {retry ? (
                    <button type="button" className="font-medium underline" onClick={retry}>
                        {t("errors.provider.retry")}
                    </button>
                ) : null}
            </div>
        </div>
    );
}
