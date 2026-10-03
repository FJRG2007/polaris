"use client";

/**
 * Where a service's image is built. Saved as it is picked, and put back if the
 * save is refused; the next deploy builds there.
 */

import { Badge, Select } from "@polaris/ui";
import { SettingsCard, useSavedFlash } from "./settings-kit";
import { useEffect, useState } from "react";
import type { BuildMachineView } from "@/lib/deploy/build-machine";
import { buildMachineAction, setBuildMachineAction } from "./source-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function BuildMachineSection({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const [view, setView] = useState<BuildMachineView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saved, markSaved] = useSavedFlash();

    useEffect(() => {
        let active = true;
        void buildMachineAction(applicationId).then((result) => {
            if (active && result.view) setView(result.view);
        });
        return () => {
            active = false;
        };
    }, [applicationId]);

    // A service that pulls an image builds nothing, and a single machine is no choice.
    if (!view?.applies || view.options.length < 2) return null;

    async function choose(value: string) {
        if (!view || value === view.value) return;
        const before = view;
        setError(null);
        setView({ ...view, value: value as BuildMachineView["value"] });
        const result = await setBuildMachineAction(applicationId, value);
        if (result.error) {
            setView(before);
            setError(result.error);
        } else markSaved();
    }

    return (
        <SettingsCard
            title={t("buildMachine.title")}
            description={t("buildMachine.hint")}
            badge={saved ? <Badge variant="success">{t("kit.saved")}</Badge> : undefined}
        >
            <Select
                value={view.value}
                onValueChange={(value) => void choose(value)}
                options={view.options.map((option) => ({
                    value: option.value,
                    label: option.label
                }))}
                aria-label={t("buildMachine.title")}
            />
            {error && <p className="text-xs text-danger-ink">{error}</p>}
        </SettingsCard>
    );
}
