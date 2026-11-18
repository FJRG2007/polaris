"use server";

import { prisma } from "@polaris/db";
import { listedPermissions } from "@polaris/core";
import { requireAdmin } from "@/lib/session";
import { listRoles } from "@/lib/role-service";
import { installedPermissionApps } from "@/lib/permission-presence";
import { polarAudiencesSchema, readPolarPolicy } from "@/lib/polar/access";

/** How many groups the Polar card offers as chips; past that it searches. */
const GROUP_CHIPS = 200;

/** The roles and the permissions they can be given, asked for after the paint. */
export async function loadRolesAdminAction() {
    await requireAdmin();
    const [roles, installed, polarPolicy, groups] = await Promise.all([
        listRoles(),
        installedPermissionApps(),
        readPolarPolicy(),
        prisma.group.findMany({
            select: { id: true, name: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: GROUP_CHIPS + 1
        })
    ]);
    const polar = polarAudiencesSchema.parse(polarPolicy);
    const [chosenGroups, people] = await Promise.all([
        prisma.group.findMany({
            where: { id: { in: [...polar.use.groupIds, ...polar.spend.groupIds] } },
            select: { id: true, name: true }
        }),
        prisma.user.findMany({
            where: { id: { in: [...polar.use.userIds, ...polar.spend.userIds] } },
            select: { id: true, name: true }
        })
    ]);
    return {
        roles,
        listed: listedPermissions(installed),
        // Polar's default, drawn only while Polar's permissions are listed.
        polar: {
            policy: polar,
            groups: groups.slice(0, GROUP_CHIPS),
            moreGroups: groups.length > GROUP_CHIPS,
            chosenGroups,
            people
        }
    };
}
