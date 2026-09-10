"use client";

/**
 * What a repository's own deploy files set, shown before the service is created,
 * with the switch that decides whether they are used. Nothing is set that the
 * reader did not see listed here.
 */

import { Switch } from "@polaris/ui";
import type { ImportedConfig, PickedSetting } from "@polaris/deploy";

const LABELS: Record<PickedSetting["setting"], string> = {
    installCommand: "Install",
    buildCommand: "Build",
    startCommand: "Start",
    outputDirectory: "Output directory",
    rootDirectory: "Root directory",
    dockerfilePath: "Dockerfile",
    healthPath: "Health check",
    replicas: "Copies"
};

export function RepoConfigPreview({
    imported,
    use,
    onUse
}: {
    imported: ImportedConfig;
    use: boolean;
    onUse: (value: boolean) => void;
}) {
    const variables = Object.keys(imported.variables);
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
                <span>
                    <span className="font-medium">Settings from the repository</span>
                    <span className="block text-xs text-muted-foreground">
                        Read from its own deploy files. Anything typed above still wins.
                    </span>
                </span>
                <Switch checked={use} onChange={onUse} aria-label="Use the repository's settings" />
            </div>
            {use && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    {imported.settings.map((entry) => (
                        <div key={entry.setting} className="contents">
                            <dt className="text-muted-foreground">{LABELS[entry.setting]}</dt>
                            <dd className="min-w-0 truncate font-mono" title={`${entry.value} - from ${entry.from}`}>
                                {entry.value} <span className="font-sans text-muted-foreground">({entry.from})</span>
                            </dd>
                        </div>
                    ))}
                    {variables.length > 0 && (
                        <div className="contents">
                            <dt className="text-muted-foreground">Variables</dt>
                            <dd className="min-w-0 truncate font-mono" title={variables.join(", ")}>
                                {variables.join(", ")}
                            </dd>
                        </div>
                    )}
                    {imported.generate.length > 0 && (
                        <div className="contents">
                            <dt className="text-muted-foreground">Generated</dt>
                            <dd className="min-w-0 truncate font-mono" title={imported.generate.join(", ")}>
                                {imported.generate.join(", ")}
                            </dd>
                        </div>
                    )}
                    {imported.needs.length > 0 && (
                        <div className="contents">
                            <dt className="text-warning-ink">Needs a value</dt>
                            <dd className="min-w-0 text-warning-ink">
                                <span className="font-mono">{imported.needs.join(", ")}</span> - add under Variables
                                once it is created.
                            </dd>
                        </div>
                    )}
                </dl>
            )}
        </div>
    );
}
