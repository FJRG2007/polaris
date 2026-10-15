"use client";

/**
 * Which registry login an image service pulls with.
 *
 * "Automatic" keeps the behaviour every service had before: the login whose
 * host matches the image. Picking one pins it. Only the logins this project may
 * use are offered - the organization's for an organization's project, the
 * owner's own otherwise - and the server checks that again.
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Select, Skeleton } from "@polaris/ui";
import { SettingsCard } from "../settings-kit";
import { RegistryKindIcon } from "./registry-kind-icon";
import { useCallback, useState, useTransition } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ServiceRegistryChoice } from "@/lib/registry-credential-service";
import { serviceRegistriesAction, setServiceRegistryAction } from "../registry-actions";

const AUTOMATIC = "auto";

export function RegistryPickCard({
    applicationId,
    canConfigure
}: {
    applicationId: string;
    canConfigure: boolean;
}) {
    const t = useTranslations("deployRegistries");
    const load = useCallback(async (): Promise<ServiceRegistryChoice> => {
        const answer = await serviceRegistriesAction(applicationId);
        if ("error" in answer) throw new Error(answer.error);
        return answer;
    }, [applicationId]);
    const { data, error, replace } = useLiveRead<ServiceRegistryChoice>({
        load,
        cacheKey: `deploy.service-registry.${applicationId}`
    });
    const [saveError, setSaveError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function pick(value: string) {
        if (!data) return;
        const next = value === AUTOMATIC ? null : value;
        if (next === data.selected) return;
        const before = data;
        setSaveError(null);
        // Shown at once; put back if the server says no.
        replace({ ...data, selected: next });
        startTransition(async () => {
            const answer = await setServiceRegistryAction(applicationId, next);
            if (answer.error) {
                replace(before);
                setSaveError(answer.error);
            }
        });
    }

    const options = [
        { value: AUTOMATIC, label: t("pick.automatic") },
        ...(data?.registries ?? []).map((registry) => ({
            value: registry.id,
            label: `${registry.name} (${registry.username})`,
            icon: <RegistryKindIcon kind={registry.kind} />
        }))
    ];

    return (
        <SettingsCard
            title={t("pick.title")}
            description={t("pick.description")}
            badge={
                pending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-label={t("pick.saving")} />
                ) : null
            }
        >
            {!data && error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : !data ? (
                <Skeleton className="h-9 w-full max-w-sm" />
            ) : (
                <div className="flex min-w-0 flex-col gap-2">
                    <Select
                        className="w-full max-w-sm"
                        value={data.selected ?? AUTOMATIC}
                        onValueChange={pick}
                        options={options}
                        disabled={!canConfigure || pending}
                        aria-label={t("pick.title")}
                    />
                    {data.registries.length === 0 && (
                        <p className="text-xs text-muted-foreground">{t("pick.none")}</p>
                    )}
                    {saveError && (
                        <p role="alert" className="text-sm text-danger">
                            {saveError}
                        </p>
                    )}
                    <Link
                        href="/apps/deploy/registries"
                        className="w-fit text-xs text-primary hover:underline"
                    >
                        {t("pick.manage")}
                    </Link>
                </div>
            )}
        </SettingsCard>
    );
}
