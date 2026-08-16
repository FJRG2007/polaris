"use client";

/**
 * One ARK item's picture, at whatever size the caller draws its slot.
 *
 * The set is named after the item's class, so there is no lookup - but it is a set
 * of one game version's items, and a server can run a mod whose items were never
 * in it. Those resolve to a URL that is not there, and a broken image reads as a
 * bug in the panel rather than as an item nobody drew yet, so a failed load falls
 * back to a neutral box.
 */

import { cn } from "@polaris/ui";
import { useState } from "react";
import { Package } from "lucide-react";
import { arkItemIconUrl } from "@/lib/apps/ark/items";

export function ArkItemIcon({ id, className }: { id: string; className?: string }) {
    // Keyed by id rather than a bare boolean: the same icon element is reused as
    // a picker's results change under it, and a flag left over from the previous
    // item would blank out the next one.
    const [failed, setFailed] = useState<string | null>(null);
    const url = arkItemIconUrl(id);

    if (url === null || failed === id) {
        return <Package className={cn("text-muted-foreground/70", className)} aria-hidden />;
    }

    return (
        <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(id)}
            className={cn("select-none object-contain", className)}
        />
    );
}
