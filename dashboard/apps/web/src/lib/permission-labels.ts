/**
 * What a permission and its area are called in the reader's language, for every
 * screen that lists the instance's permissions (the roles editor, one person's
 * capabilities).
 */

import { PERMISSION_META, type Permission } from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type Translate = NamespaceTranslator<"admin">;

/** An area's name in the reader's language. Keyed by the English name made
 *  camelCase ("Game servers" -> "gameServers"); an area added to the core list
 *  before the catalog knows it keeps its English name rather than a key. */
export function areaLabel(t: Translate, area: string): string {
    const key = `roles.areas.${area.toLowerCase().replace(/\s+(\w)/g, (_, next: string) => next.toUpperCase())}`;
    return t.has(key) ? t(key) : area;
}

/** A permission's name in the reader's language, falling back to the core's
 *  English for one the catalog does not know yet. */
export function permissionLabel(t: Translate, permission: Permission): string {
    const key = `roles.permissions.${permission}`;
    return t.has(key) ? t(key) : PERMISSION_META[permission].label;
}

/**
 * The app each area belongs to, by the id the app switcher draws it under, so a
 * permission list shows the logo people already know the app by. `null` is an
 * area with no logo of its own (Inbox is part of Management and alert topics of
 * the account, not apps; Family has no app yet), and an area missing here - one
 * an organization or a later version adds - draws none.
 */
export const AREA_APPS: Readonly<Record<string, string | null>> = {
    Drive: "drive",
    Vault: "vault",
    Notes: "notes",
    Office: "office",
    VPN: "vpn",
    Mail: "mail",
    Calendar: "calendar",
    CRM: "crm",
    Translate: "translate",
    Automations: "automations",
    Alerts: null,
    "Status pages": "status-pages",
    Chat: "chat",
    Games: "arcade",
    Polar: "polar",
    Apps: "apps",
    "Game servers": "games",
    Home: "home",
    Tools: "tools",
    Tasks: "tasks",
    Inbox: null,
    Family: null,
    Management: "admin"
};

/** The app id whose logo stands beside an area, or null for none. */
export function areaApp(area: string): string | null {
    return Object.hasOwn(AREA_APPS, area) ? AREA_APPS[area]! : null;
}
