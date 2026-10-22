/**
 * Which kinds of service a reader is offered, from the same grants the actions
 * check: creating anything at all is `deploy.manage` (the trigger is only shown
 * with it), and starting a database is `databases.manage` on top of it.
 */

import type { ProjectCapability } from "@polaris/core";

/** The kinds this reader may start, in the order given. */
export function offeredServiceTypes<T extends { readonly id: string }>(
    types: readonly T[],
    can: (capability: ProjectCapability) => boolean
): T[] {
    return types.filter((type) => type.id !== "database" || can("databases.manage"));
}

/** Whether the database form may be used, and the reason when it may not. */
export function databaseFormAccess(
    canManage: boolean,
    can: (capability: ProjectCapability) => boolean
): { allowed: true } | { allowed: false; reason: "deployManage" | "databasesManage" } {
    if (!canManage) return { allowed: false, reason: "deployManage" };
    if (!can("databases.manage")) return { allowed: false, reason: "databasesManage" };
    return { allowed: true };
}
