/**
 * Client-safe shapes for the Drive access dialog. Kept out of the "use server"
 * actions module (which may only export async functions) so both the server
 * actions and the client component can share them.
 */

import type { DriveAclRow } from "@/lib/drive-acl-service";
import type { LockInfo } from "@/lib/access-lock-service";

/** A principal choosable in the ACL editor. */
export interface AccessPrincipal {
    type: "user" | "group";
    id: string;
    label: string;
    sublabel?: string;
}

/** Everything the access dialog needs for one connection. */
export interface AccessSettings {
    acls: DriveAclRow[];
    locks: LockInfo[];
    principals: AccessPrincipal[];
}
