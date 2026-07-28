/**
 * Human labels for the permission scopes an API key can carry. Client-safe on
 * purpose: the key dialog renders these, so this module must not reach for
 * anything that drags the database layer into the browser bundle. Resolving
 * which scopes a user may actually pick lives server-side, in @polaris/auth.
 */

import type { Permission } from "@polaris/core";

export const SCOPE_LABELS: Readonly<Record<Permission, string>> = {
    "drive.read": "Read files",
    "drive.write": "Write files",
    "drive.delete": "Delete files",
    "connections.manage": "Manage storage connections",
    "shares.create": "Create share links",
    "shares.manage": "Manage all share links",
    "requests.create": "Create drop points",
    "requests.manage": "Manage all drop points",
    "deploy.read": "Read deployments",
    "deploy.manage": "Manage deployments",
    "users.manage": "Manage users",
    "settings.manage": "Manage settings",
    "system.manage": "Manage the system"
};
