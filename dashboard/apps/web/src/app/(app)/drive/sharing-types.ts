/**
 * Client-safe shapes for the sharing dialog. Kept out of the "use server"
 * actions module, which may only export async functions, so the actions and the
 * client component can share one definition.
 */

import type { DriveShareRole } from "@/lib/drive-sharing";

/** One principal who currently holds an item, as the dialog lists them. */
export interface ItemShare {
    readonly grantId: string;
    readonly type: "user" | "group";
    readonly id: string;
    readonly name: string;
    readonly role: DriveShareRole | "custom";
    /** ISO string, or null when the share does not lapse. */
    readonly expiresAt: string | null;
}
