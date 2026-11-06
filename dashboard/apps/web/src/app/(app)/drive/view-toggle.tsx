"use client";

/**
 * The list / grid (/ photos) switch, shared by Drive's explorer and the file
 * picker so the two offer the same choice in the same place.
 */

import { cn } from "@polaris/ui";
import type { DriveViewMode } from "./view-mode";
import { Images, LayoutGrid, List } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const ICONS: Readonly<Record<DriveViewMode, typeof List>> = {
    list: List,
    grid: LayoutGrid,
    photos: Images
};

export function ViewModeToggle({
    mode,
    modes,
    onChoose,
    className
}: {
    mode: DriveViewMode;
    /** The layouts offered, in order. */
    modes: readonly DriveViewMode[];
    onChoose: (mode: DriveViewMode) => void;
    className?: string;
}) {
    const t = useTranslations("components");
    return (
        <div
            className={cn(
                "flex shrink-0 items-center gap-1 rounded-md border border-border p-0.5",
                className
            )}
        >
            {modes.map((one) => {
                const Icon = ICONS[one];
                const label = t(`files.view.${one}`);
                return (
                    <button
                        key={one}
                        type="button"
                        onClick={() => onChoose(one)}
                        aria-label={label}
                        aria-pressed={mode === one}
                        title={label}
                        className={cn(
                            "rounded p-1 transition-colors hover:bg-muted",
                            mode === one ? "bg-muted text-foreground" : "text-muted-foreground"
                        )}
                    >
                        <Icon className="size-4 shrink-0" />
                    </button>
                );
            })}
        </div>
    );
}
