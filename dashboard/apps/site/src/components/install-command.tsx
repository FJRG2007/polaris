"use client";

/**
 * The one line that installs Polaris, for the visitor's system.
 *
 * The page is static, so the first paint shows the macOS and Linux line and the
 * browser swaps in the PowerShell one on Windows. The switch beside it is for
 * the visitor who is reading on one machine and installing on another.
 */

import { useEffect, useState } from "react";
import { CopyButton, SegmentedControl, cn } from "@polaris/ui";

export type InstallSystem = "unix" | "windows";

export function InstallCommand({
    commands,
    labels,
    className
}: {
    commands: Readonly<Record<InstallSystem, string>>;
    labels: { unix: string; windows: string; system: string; copy: string };
    className?: string;
}) {
    const [system, setSystem] = useState<InstallSystem>("unix");
    useEffect(() => {
        if (/windows/i.test(navigator.userAgent)) setSystem("windows");
    }, []);
    const command = commands[system];
    return (
        <div
            className={cn(
                "flex w-full min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-2 shadow-sm",
                className
            )}
        >
            <div className="flex min-w-0 items-center gap-2 px-1">
                <SegmentedControl
                    size="sm"
                    aria-label={labels.system}
                    value={system}
                    onValueChange={setSystem}
                    options={[
                        { value: "unix", label: labels.unix },
                        { value: "windows", label: labels.windows }
                    ]}
                />
            </div>
            <div className="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2.5">
                <span
                    aria-hidden="true"
                    className="select-none font-mono text-sm text-muted-foreground"
                >
                    {system === "windows" ? ">" : "$"}
                </span>
                <code
                    className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm [scrollbar-width:none]"
                    title={command}
                >
                    {command}
                </code>
                <CopyButton value={command} label={labels.copy} />
            </div>
        </div>
    );
}
