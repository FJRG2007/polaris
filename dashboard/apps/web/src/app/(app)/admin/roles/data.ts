"use server";

import { listedPermissions } from "@polaris/core";
import { requireAdmin } from "@/lib/session";
import { listRoles } from "@/lib/role-service";
import { installedPermissionApps } from "@/lib/permission-presence";

/** The roles and the permissions they can be given, asked for after the paint. */
export async function loadRolesAdminAction() {
    await requireAdmin();
    const [roles, installed] = await Promise.all([listRoles(), installedPermissionApps()]);
    return { roles, listed: listedPermissions(installed) };
}
