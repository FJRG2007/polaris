"use client";

/**
 * One install line on the downloads screen: a title, the system it is for, the
 * line with its copy button, and what happens once it is pasted.
 *
 * Shared by every app with a one-line install (the extension, the Stream Deck
 * plugin), so they read the same and a fix to one is a fix to all. The line
 * itself is built by each app's own module; this only draws it.
 */

import { CopyButton } from "@/components/copy-button";
import { PlatformSelect } from "@/components/platform-select";
import type { InstallPlatform } from "@/lib/install-platform";

export function InstallLine({
    title,
    systemLabel,
    platform,
    platforms,
    onPlatformChange,
    command,
    hint
}: {
    title: string;
    /** What the system picker is for, for a screen reader. */
    systemLabel: string;
    platform: InstallPlatform;
    /** The systems a line exists for; every one when left out. */
    platforms?: readonly InstallPlatform[];
    onPlatformChange: (platform: InstallPlatform) => void;
    command: string;
    hint: string;
}) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 font-medium">{title}</p>
                <PlatformSelect
                    className="w-44"
                    value={platform}
                    platforms={platforms}
                    label={systemLabel}
                    onChange={onPlatformChange}
                />
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-foreground">
                    {command}
                </code>
                <CopyButton value={command} />
            </div>

            <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
    );
}
