"use client";

/**
 * A Polaris app's mark beside its name, wherever a list, menu, picker or table
 * names one of Polaris's own apps.
 *
 * The one component those sites draw, so the logo, its size and its fallback
 * are decided here and not at each site:
 *
 * - an app with a logo wears its `AppLogo`;
 * - an app in the registry without one wears its own icon on a tile tinted from
 *   its id, the fallback `AppMark` uses for the store;
 * - anything else that has a `label` (a heading that groups several apps, say)
 *   wears its initial on a tile tinted the same way, so a row of them stays
 *   aligned;
 * - with neither, nothing is drawn.
 *
 * Every branch keeps its box at `size` and never shrinks in a flex row (see
 * `icons-never-shrink`): the name beside it is what truncates. Decorative, as
 * the name is always written next to it.
 */

import { POLARIS_APPS } from "@/lib/apps";
import { initialsInk, tintFor } from "@polaris/core";
import { AppLogo, cn, hasAppLogo } from "@polaris/ui";

const REGISTRY = new Map(POLARIS_APPS.map((app) => [app.id, app]));

/** Whether this id names a Polaris app the icon can draw as itself. */
export function isPolarisApp(appId: string): boolean {
    return hasAppLogo(appId) || REGISTRY.has(appId);
}

export function PolarisAppIcon({
    appId,
    label,
    size = 16,
    className
}: {
    /** The app registry id (`home` is Places, `games` is Game servers). */
    appId: string | null | undefined;
    /** What the row is called, for the initial drawn when `appId` is no app. */
    label?: string;
    /** Width and height in pixels: 16 in dense rows and menus, more on cards. */
    size?: number;
    className?: string;
}) {
    if (appId && hasAppLogo(appId)) {
        return <AppLogo appId={appId} size={size} className={cn("shrink-0", className)} />;
    }

    const entry = appId ? REGISTRY.get(appId) : undefined;
    const initial = label?.trim().charAt(0).toUpperCase();
    if (!entry && !initial) return null;

    const tint = tintFor(entry?.id ?? appId ?? label ?? "");
    const Icon = entry?.icon;
    return (
        <span
            aria-hidden="true"
            data-app-icon={entry?.id ?? "initial"}
            className={cn(
                "inline-grid shrink-0 place-items-center rounded-[4px] font-semibold leading-none",
                className
            )}
            style={{
                width: size,
                height: size,
                fontSize: Math.round(size * 0.6),
                backgroundColor: tint,
                color: initialsInk(tint)
            }}
        >
            {Icon ? <Icon style={{ width: size * 0.65, height: size * 0.65 }} /> : initial}
        </span>
    );
}
