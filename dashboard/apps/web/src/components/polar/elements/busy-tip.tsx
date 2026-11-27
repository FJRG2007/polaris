"use client";

/**
 * BusyTip: the line under Polar's busy line while it works, one tip per wait
 * naming a command the surface has (`lib/polar/tips.ts`), as Claude Code
 * shows one under its spinner. It stays put for the whole wait, so a screen
 * reader is not told something new while the answer is on its way.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import * as polarTips from "@/lib/polar/tips";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function BusyTip({ surface, className }: { surface: polarTips.TipSurface; className?: string }) {
    const t = useTranslations("polar");
    const [tip] = useState(() => polarTips.pickTip(surface));
    if (!tip) return null;
    return (
        <p className={cn("min-w-0 truncate text-xs text-muted-foreground", className)} title={t(`tips.${tip.id}`)}>
            {t("tips.label", { tip: t(`tips.${tip.id}`) })}
        </p>
    );
}
