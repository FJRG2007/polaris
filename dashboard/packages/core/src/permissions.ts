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
    "deploy.read",
    "deploy.manage",
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
        "requests.create",
        "deploy.read",
        "deploy.manage"
    ],
    viewer: ["drive.read", "deploy.read"]
};

/**
 * Permissions that another one cannot sensibly be held without. Writing a file
 * you cannot read back, or managing shares you cannot create, is a grant that
 * only looks narrower than it is - so picking the broader permission carries the
 * narrower one with it.
 *
 * This is composition, not evaluation: grants are expanded when they are built
 * (see expandPermissions), and hasPermission still matches exactly, so what a
 * key or a role actually holds is always written out in full.
 */
export const IMPLIED_PERMISSIONS: Readonly<Partial<Record<Permission, readonly Permission[]>>> = {
    "drive.write": ["drive.read"],
    "drive.delete": ["drive.read"],
    "shares.manage": ["shares.create"],
    "requests.manage": ["requests.create"],
    "deploy.manage": ["deploy.read"]
};

/** The permissions one grant carries with it, itself excluded. */
export function impliedBy(permission: Permission): readonly Permission[] {
    return IMPLIED_PERMISSIONS[permission] ?? [];
}

/**
 * Complete a set of permissions with everything its members imply, in the
 * canonical PERMISSIONS order so a stored grant reads the same however it was
 * picked.
 */
export function expandPermissions(granted: Iterable<Permission>): Permission[] {
    const expanded = new Set<Permission>();
    for (const permission of granted) {
        expanded.add(permission);
        for (const implied of impliedBy(permission)) expanded.add(implied);
    }
    return PERMISSIONS.filter((permission) => expanded.has(permission));
}

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
