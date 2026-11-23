"use server";

/**
 * A service's Dockerfile build options: the target stage and the ARG values.
 * Reading asks for seeing the project; changing them changes what gets built, so
 * it asks for `service.configure`. The next deploy builds with them.
 */

import { reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { readBuildOptions, setBuildOptions } from "@/lib/deploy/build-options";
import {
    buildOptionsShape,
    buildOptionsSchema,
    normalizeBuildOptions,
    type BuildOptionsInput
} from "@/lib/deploy/build-options-schema";

export async function buildOptionsAction(
    applicationId: string
): Promise<{ error?: string; options?: BuildOptionsInput }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        const { targetStage, args } = await readBuildOptions(applicationId, access.ownerId);
        return { options: { targetStage, args } };
    } catch (caught) {
        console.error("polaris: reading build options failed:", caught);
        return { error: await reply("behaviour.loadFailed") };
    }
}

export async function setBuildOptionsAction(applicationId: string, value: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const shaped = buildOptionsShape.safeParse(value);
    const parsed = shaped.success ? buildOptionsSchema.safeParse(normalizeBuildOptions(shaped.data)) : shaped;
    if (!parsed.success) return { error: await reply("behaviour.saveFailed") };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        if (!(await setBuildOptions(applicationId, access.ownerId, parsed.data))) return {};
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.buildOptions",
            targetType: "application",
            targetId: applicationId,
            // Names only: a value can be anything the operator typed.
            metadata: { targetStage: parsed.data.targetStage, args: parsed.data.args.map((row) => row.key) }
        });
        revalidatePath("/apps/deploy");
        return {};
    } catch (caught) {
        console.error("polaris: saving build options failed:", caught);
        return { error: await reply("behaviour.saveFailed") };
    }
}
