"use server";

/**
 * What the project frame and the deployments list say without being asked: the
 * glance over each environment, and whether a service's live release is behind
 * its branch. Both are reading the project, so they ask for no more than that.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { deployFreshness, type DeployFreshness } from "@/lib/deploy/freshness";
import { imageUpdateOf } from "@/lib/deploy/update-scan";
import { readerProjectGlance, type EnvironmentGlance } from "@/lib/deploy/project-glance";

const idSchema = z.string().trim().min(1).max(100);

export async function deployFreshnessAction(applicationId: string): Promise<DeployFreshness | null> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(applicationId);
    if (!parsed.success) return null;
    try {
        await requireApplicationAccess(parsed.data, user.id, "project.read");
        return await deployFreshness(parsed.data);
    } catch {
        return null;
    }
}

/** A newer image published behind the tag a service runs, as the last updates
 *  scan found it. */
export async function imageUpdateAction(
    applicationId: string
): Promise<{ image: string; checkedAt: string } | null> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(applicationId);
    if (!parsed.success) return null;
    try {
        await requireApplicationAccess(parsed.data, user.id, "project.read");
        return await imageUpdateOf(parsed.data);
    } catch {
        return null;
    }
}

/** The project frame's glance, re-read after something in it changed. */
export async function projectGlanceAction(projectId: string): Promise<Record<string, EnvironmentGlance> | null> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(projectId);
    if (!parsed.success) return null;
    try {
        return await readerProjectGlance(parsed.data, user.id);
    } catch {
        return null;
    }
}
