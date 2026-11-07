"use server";

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";

const PICK_LIMIT = 200;

/** The roles, groups and organizations an announcement can be sent to. */
export async function loadAnnouncementPicksAction() {
    await requireAdmin();
    const [roles, groups, orgs] = await Promise.all([
        prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: PICK_LIMIT }),
        prisma.group.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: PICK_LIMIT }),
        prisma.organization.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: PICK_LIMIT })
    ]);
    return { roles, groups, orgs };
}
