/**
 * Where a scope's words are in the `mcp` catalog. Client-safe: the consent
 * screen and the connected-apps list both render these.
 *
 * A permission key has a dot in it, which the catalog reads as nesting, so the
 * key is written with an underscore instead.
 */

import type { Permission } from "@polaris/core";
import type { NamespaceKey } from "@/lib/i18n/types";

export function scopeLabelKey(scope: Permission | string): NamespaceKey<"mcp"> {
    return `scopes.${scope.replace(".", "_")}` as NamespaceKey<"mcp">;
}
