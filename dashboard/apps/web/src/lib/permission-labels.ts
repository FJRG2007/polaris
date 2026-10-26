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
