"use client";

/**
 * What a repository's own deploy files set, shown before the service is created,
 * with the switch that decides whether they are used. Nothing is set that the
 * reader did not see listed here.
 */

import { Switch } from "@polaris/ui";
import type { ImportedConfig, PickedSetting } from "@polaris/deploy";
import { useTranslations } from "@/components/i18n/i18n-provider";

const LABELS = {
    installCommand: "repoConfig.labels.install",
    buildCommand: "repoConfig.labels.build",
    startCommand: "repoConfig.labels.start",
    outputDirectory: "repoConfig.labels.output",
    rootDirectory: "repoConfig.labels.root",
    dockerfilePath: "repoConfig.labels.dockerfile",
    healthPath: "repoConfig.labels.health",
    replicas: "repoConfig.labels.copies"
} as const satisfies Record<PickedSetting["setting"], string>;

export function RepoConfigPreview({
    imported,
    use,
    onUse
}: {
    imported: ImportedConfig;
    use: boolean;
    onUse: (value: boolean) => void;
}) {
    const t = useTranslations("deploy");
    const variables = Object.keys(imported.variables);
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
                <span>
                    <span className="font-medium">{t("repoConfig.title")}</span>
                    <span className="block text-xs text-muted-foreground">{t("repoConfig.hint")}</span>
                </span>
                <Switch checked={use} onChange={onUse} aria-label={t("repoConfig.use")} />
            </div>
            {use && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    {imported.settings.map((entry) => (
                        <div key={entry.setting} className="contents">
                            <dt className="text-muted-foreground">{t(LABELS[entry.setting])}</dt>
                            <dd className="min-w-0 truncate font-mono" title={t("repoConfig.from", { value: entry.value, file: entry.from })}>
                                {entry.value} <span className="font-sans text-muted-foreground">({entry.from})</span>
                            </dd>
                        </div>
                    ))}
                    {variables.length > 0 && (
                        <div className="contents">
                            <dt className="text-muted-foreground">{t("repoConfig.variables")}</dt>
                            <dd className="min-w-0 truncate font-mono" title={variables.join(", ")}>
                                {variables.join(", ")}
                            </dd>
                        </div>
                    )}
                    {imported.generate.length > 0 && (
                        <div className="contents">
                            <dt className="text-muted-foreground">{t("repoConfig.generated")}</dt>
                            <dd className="min-w-0 truncate font-mono" title={imported.generate.join(", ")}>
                                {imported.generate.join(", ")}
                            </dd>
                        </div>
                    )}
                    {imported.needs.length > 0 && (
                        <div className="contents">
                            <dt className="text-warning-ink">{t("repoConfig.needs")}</dt>
                            <dd className="min-w-0 text-warning-ink">
                                {t.rich("repoConfig.needsHint", {
                                    names: imported.needs.join(", "),
                                    mono: (chunks) => (
                                        <span key="names" className="font-mono">
                                            {chunks}
                                        </span>
                                    )
                                })}
                            </dd>
                        </div>
                    )}
                </dl>
            )}
        </div>
    );
}
