"use client";

/**
 * A server software's own mark, where the project publishes one.
 *
 * The marks are the projects' own files (see `logo` in `minecraft-software`),
 * drawn as they ship: no tint and no background of ours, each of them legible
 * on both themes as it is. Software without a published mark gets a neutral
 * box and is told apart by its name, which sits beside it anyway.
 */

import { cn } from "@polaris/ui";
import { Box } from "lucide-react";
import { findSoftware } from "@polaris/core";

export function SoftwareLogo({ type, className }: { type: string; className?: string }) {
    const logo = findSoftware(type)?.logo;
    if (!logo) {
        return (
            <Box aria-hidden className={cn("size-5 shrink-0 text-muted-foreground", className)} />
        );
    }
    return (
        // A fixed few kilobytes from the dashboard's own public folder: nothing an
        // image optimizer would improve, and the app is not where its config is.
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={logo}
            alt=""
            aria-hidden
            width={20}
            height={20}
            loading="lazy"
            className={cn("size-5 shrink-0 rounded-sm object-contain", className)}
        />
    );
}
