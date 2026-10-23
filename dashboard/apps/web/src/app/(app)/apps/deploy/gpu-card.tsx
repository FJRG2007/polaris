"use client";

/**
 * Whether a service is handed its server's NVIDIA cards, and what it holds on
 * them now.
 *
 * Offered only where the server has a card Polaris has read; anywhere else the
 * switch stays off and says why. Turning it on or off saves at once and starts
 * the running release again, and the switch goes back if the save is refused.
 */

import { Switch } from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import { CardError, CardSkeleton, SettingsCard } from "./settings-kit";
import type { ServiceGpuView } from "@/lib/deploy/gpu-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useTransition } from "react";
import { saveServiceGpuAction, serviceGpuAction } from "./gpu-actions";

export function GpuCard({
    applicationId,
    canConfigure,
    onChanged
}: {
    applicationId: string;
    canConfigure: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const [view, setView] = useState<ServiceGpuView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        void serviceGpuAction(applicationId).then((result) => {
            if (!active) return;
            if (result.gpu) setView(result.gpu);
            else setError(result.error ?? null);
        });
        return () => {
            active = false;
        };
    }, [applicationId]);

    if (!view) {
        return error ? (
            <CardError entry="gpu" title={t("gpu.title")} message={error} />
        ) : (
            <CardSkeleton entry="gpu" title={t("gpu.title")} rows={1} />
        );
    }

    function toggle(enabled: boolean) {
        if (!view || pending) return;
        const before = view;
        // Shown as saved straight away; put back if the server refuses it.
        setView({ ...view, enabled });
        setNote(null);
        startTransition(async () => {
            const result = await saveServiceGpuAction(applicationId, enabled);
            if (result.error) {
                setView(before);
                setNote(result.error);
                return;
            }
            if (result.restartError) setNote(result.restartError);
            else if (result.redeployed) setNote(t("gpu.saved"));
            onChanged();
        });
    }

    return (
        <GpuCardBody
            view={view}
            canConfigure={canConfigure}
            pending={pending}
            note={note}
            onToggle={toggle}
            t={t}
        />
    );
}

/** The card without its reads, for tests. */
export function GpuCardBody({
    view,
    canConfigure,
    pending,
    note,
    onToggle,
    t
}: {
    view: ServiceGpuView;
    canConfigure: boolean;
    pending: boolean;
    note: string | null;
    onToggle: (enabled: boolean) => void;
    t: NamespaceTranslator<"deployService">;
}) {
    // Turning it off is always allowed, so a service moved to a machine with no
    // card can still be put right.
    const blocked = !view.enabled && view.refusal !== null;
    const why = !canConfigure
        ? t("gpu.noConfigure")
        : blocked && view.refusal
          ? t(`gpu.${view.refusal}`)
          : null;
    return (
        <SettingsCard entry="gpu" title={t("gpu.title")} description={t("gpu.hint")}>
            <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-start justify-between gap-3 rounded-md bg-surface p-3">
                    <span className="min-w-0">
                        <span className="text-xs font-medium">{t("gpu.use")}</span>
                        {why ? (
                            <span className="block text-xs text-muted-foreground">{why}</span>
                        ) : null}
                        {view.cards.length > 0 ? (
                            <span
                                className="block truncate text-xs text-muted-foreground"
                                title={view.cards.map((card) => card.name).join(", ")}
                            >
                                {t("gpu.cards", {
                                    list: view.cards
                                        .map((card) => `${card.index}: ${card.name}`)
                                        .join(", ")
                                })}
                            </span>
                        ) : null}
                    </span>
                    <Switch
                        checked={view.enabled}
                        disabled={!canConfigure || blocked || pending}
                        onChange={onToggle}
                        aria-label={t("gpu.use")}
                    />
                </div>
                {view.enabled ? (
                    <p className="text-xs text-muted-foreground">
                        {view.memoryUsedBytes
                            ? t("gpu.using", { used: formatBytes(view.memoryUsedBytes) })
                            : t("gpu.notUsing")}
                    </p>
                ) : null}
                {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
            </div>
        </SettingsCard>
    );
}
