/**
 * The icon a pinned link is drawn with.
 *
 * Read off the navigation registries rather than stored with the shortcut: the
 * icon is presentation, and storing one would freeze whatever Polaris used on
 * the day it was pinned. A link to something with no fixed screen behind it -
 * one deploy project, one game server - falls back to the nearest section it
 * lives under, which is still more use than a generic chain link.
 */

import type { LucideIcon } from "lucide-react";
import { APP_SECTIONS, APP_SUBAPPS, POLARIS_APPS } from "@/lib/apps";

const ICONS: { href: string; icon: LucideIcon }[] = [
    ...POLARIS_APPS.map((app) => ({ href: app.href, icon: app.icon })),
    ...Object.values(APP_SECTIONS).flatMap((sections) =>
        sections.map((section) => ({ href: section.href, icon: section.icon }))
    ),
    ...APP_SUBAPPS.flatMap((subapp) => subapp.sections.map((section) => ({ href: section.href, icon: section.icon })))
].sort((left, right) => right.href.length - left.href.length);

export function shortcutIcon(href: string): LucideIcon | null {
    const match = ICONS.find((entry) => entry.href === href || href.startsWith(`${entry.href}/`));
    return match?.icon ?? null;
}
