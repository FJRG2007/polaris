"use server";

/**
 * The one-time offer to close the environments made before private networking
 * (see `lib/deploy/network-isolation.ts`). Owner-scoped: only projects the
 * reader owns are listed or touched.
 */

import { z } from "zod";
import { reply } from "./reply";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as isolation from "@/lib/deploy/network-isolation";

type Result<T extends object = Record<never, never>> = { error?: string } & Partial<T>;

const applySchema = z.object({
    environmentIds: z.array(z.string().trim().uuid()).min(1).max(isolation.ISOLATION_ENVIRONMENT_LIMIT)
});

export async function applyNetworkIsolationAction(input: {
    environmentIds: string[];
}): Promise<Result<{ isolated: number; restarting: number }>> {
    const user = await requirePermission("deploy.manage");
    const parsed = applySchema.safeParse(input);
    if (!parsed.success) return { error: await reply("isolation.nothingChosen") };
    let plans: isolation.IsolationPlan[] | null;
    try {
        plans = await isolation.applyNetworkIsolation(user.id, parsed.data.environmentIds);
    } catch (caught) {
        console.error("polaris: could not isolate environments:", caught);
        return { error: await reply("isolation.failed") };
    }
    if (!plans) return { error: await reply("isolation.alreadyDone") };
    for (const plan of plans) {
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.env.network",
            targetType: "environment",
            targetId: plan.environmentId,
            metadata: {
                from: plan.from,
                to: plan.change === "isolate" ? "environment" : plan.from,
                applied: true,
                reason: "isolation",
                restarts: plan.databaseIds.length + plan.applicationIds.length
            }
        });
    }
    // Restarting takes as long as the databases take to come back, so it runs
    // once this answer has gone out; each restart shows in its service's history.
    after(() =>
        isolation
            .restartForIsolation(plans, user.id, user.id)
            .catch((error) => console.error("polaris: isolation restarts stopped:", error))
    );
    revalidatePath("/apps/deploy", "layout");
    return {
        isolated: plans.filter((plan) => plan.change === "isolate").length,
        restarting: plans.reduce(
            (sum, plan) => sum + plan.databaseIds.length + plan.applicationIds.length,
            0
        )
    };
}

export async function keepNetworksAction(): Promise<Result> {
    const user = await requirePermission("deploy.manage");
    try {
        await isolation.keepNetworksAsTheyAre(user.id);
    } catch (caught) {
        console.error("polaris: could not record the network choice:", caught);
        return { error: await reply("isolation.failed") };
    }
    revalidatePath("/apps/deploy/settings");
    return {};
}
