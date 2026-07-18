/**
 * Role and permission model. Authorization is permission-based rather than
 * role-name-based so call sites ask "can this actor do X" instead of "is this
 * actor an admin", which keeps checks stable as roles evolve. Roles are just
 * named bundles of permissions; the seeded set covers the common cases and admin
 * additionally implies every permission.
 */

/** Every discrete capability a user can be granted. */
export const PERMISSIONS = [
    "drive.read",
    "drive.write",
    "drive.delete",
    "connections.manage",
    "shares.create",
    "shares.manage",
    "requests.create",
    "requests.manage",
    "users.manage",
    "settings.manage",
    "system.manage"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** A wildcard a role may hold to mean "all current and future permissions". */
export const ALL_PERMISSIONS = "*" as const;

export type GrantedPermission = Permission | typeof ALL_PERMISSIONS;

/** The built-in roles seeded on first run. */
export const DEFAULT_ROLES: Record<string, readonly GrantedPermission[]> = {
    admin: [ALL_PERMISSIONS],
    member: [
        "drive.read",
        "drive.write",
        "drive.delete",
        "connections.manage",
        "shares.create",
        "requests.create"
    ],
    viewer: ["drive.read"]
};

/**
 * Resolve whether a set of granted permissions satisfies a required one. The
 * wildcard grant short-circuits to true, which is how the admin role implies
 * everything without enumerating each key.
 */
export function hasPermission(
    granted: Iterable<GrantedPermission>,
    required: Permission
): boolean {
    for (const grant of granted) {
        if (grant === ALL_PERMISSIONS || grant === required) return true;
    }
    return false;
}

/** Merge the permissions of several roles into one deduplicated set. */
export function mergeRolePermissions(
    roles: Iterable<readonly GrantedPermission[]>
): Set<GrantedPermission> {
    const merged = new Set<GrantedPermission>();
    for (const role of roles) {
        for (const grant of role) merged.add(grant);
    }
    return merged;
}
