"use client";

/**
 * The one line that installs Polaris, for the server that will host it.
 *
 * Always opens on the Linux line, never on the reader's own system: the command
 * runs on a server, and the page is almost always read from another computer.
 * Picking Windows shows why it is not the recommended host.
 */

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { CopyButton, SegmentedControl, cn } from "@polaris/ui";

export type InstallSystem = "unix" | "windows";

export function InstallCommand({
    commands,
    painted,
    labels,
    requirementsHref,
    className
}: {
    commands: Readonly<Record<InstallSystem, string>>;
    /** The same lines highlighted at build time; empty falls back to plain text. */
    painted: Readonly<Record<InstallSystem, string>>;
    labels: {
        unix: string;
        windows: string;
        system: string;
        copy: string;
        windowsWarning: string;
        requirements: string;
    };
    /** Where the host requirements are explained. */
    requirementsHref: string;
    className?: string;
}) {
    const [system, setSystem] = useState<InstallSystem>("unix");
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
            <div className="code-block flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2.5">
                <span
                    aria-hidden="true"
                    className="select-none font-mono text-sm text-muted-foreground"
                >
                    {system === "windows" ? ">" : "$"}
                </span>
                {painted[system] ? (
                    <code
                        className="shiki min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm [scrollbar-width:none]"
                        title={command}
                        // Shiki's own markup: it escaped the line, and the only
                        // elements in it are the spans it added.
                        dangerouslySetInnerHTML={{ __html: painted[system] }}
                    />
                ) : (
                    <code
                        className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm [scrollbar-width:none]"
                        title={command}
                    >
                        {command}
                    </code>
                )}
                <CopyButton value={command} label={labels.copy} />
            </div>
            {system === "windows" && (
                <p
                    role="note"
                    className="flex min-w-0 items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
                >
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0">
                        {labels.windowsWarning}{" "}
                        <a
                            href={requirementsHref}
                            className="font-medium underline underline-offset-2"
                        >
                            {labels.requirements}
                        </a>
                    </span>
                </p>
            )}
        </div>
    );
}
