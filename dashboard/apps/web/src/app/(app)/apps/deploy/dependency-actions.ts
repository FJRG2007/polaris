"use server";

/**
 * A service's dependency findings, for its page. Reading them asks what
 * seeing the project asks: findings are only shown to who can see the service.
 */

import { z } from "zod";
import { reply } from "./reply";
import { requirePermission } from "@/lib/session";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import {
    serviceDependencies,
    type DependencyFinding,
    type DependencyScanView
} from "@/lib/security/dependency-findings";

export async function serviceDependenciesAction(applicationId: unknown): Promise<{
    error?: string;
    scan?: DependencyScanView | null;
    findings?: DependencyFinding[];
}> {
    const user = await requirePermission("deploy.read");
    const id = z.string().uuid().safeParse(applicationId);
    if (!id.success) return { error: await reply("dependencies.loadFailed") };
    try {
        await requireApplicationAccess(id.data, user.id, "project.read");
        return await serviceDependencies(id.data);
    } catch (caught) {
        console.error("polaris: a service's dependency findings could not be read:", caught);
        return { error: await reply("dependencies.loadFailed") };
    }
}
