"use client";

/**
 * Where a service's image is built. Saved as it is picked, and put back if the
 * save is refused; the next deploy builds there.
 */

import { Select } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { BuildMachineView } from "@/lib/deploy/build-machine";
import { buildMachineAction, setBuildMachineAction } from "./source-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function BuildMachineSection({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const [view, setView] = useState<BuildMachineView | null>(null);
    const [error, setError] = useState<string | null>(null);

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
        }
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("buildMachine.title")}</h3>
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
                <Select
                    value={view.value}
                    onValueChange={(value) => void choose(value)}
                    options={view.options.map((option) => ({ value: option.value, label: option.label }))}
                    aria-label={t("buildMachine.title")}
                />
                <span className="text-xs text-muted-foreground">
                    {t("buildMachine.hint")}
                </span>
                {error && <p className="text-sm text-danger">{error}</p>}
            </div>
        </section>
    );
}
