"use server";

/**
 * Moving a domain to another service of the same project. Every action asks for
 * `domains.manage` on the project the domain is in, the same as editing the domain
 * itself, and the service (lib/deploy/dns-cutover-service.ts) does the rest.
 */

import { z } from "zod";
import { reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import * as cutovers from "@/lib/deploy/dns-cutover-service";
import { requireDomainAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

const domainIdSchema = z.string().uuid();
const startSchema = z.object({
    domainId: z.string().uuid(),
    targetApplicationId: z.string().uuid()
});

export type CutoverPanel = Awaited<ReturnType<typeof cutovers.cutoverPanel>>;
export type CutoverReply = { panel?: CutoverPanel; error?: string };

/** The caller's access to the domain, or null when they may not move it. */
async function access(domainId: string) {
    const user = await requirePermission("deploy.manage");
    try {
        const granted = await requireDomainAccess(domainId, user.id, "domains.manage");
        return { userId: user.id, environmentIds: granted.environmentIds };
    } catch {
        return null;
    }
}

/** Run one step and answer with the panel as it stands after it. */
async function step(
    domainId: unknown,
    run: (caller: { userId: string; environmentIds: readonly string[] | null }, id: string) => Promise<unknown>
): Promise<CutoverReply> {
    const parsed = domainIdSchema.safeParse(domainId);
    if (!parsed.success) return { error: await reply("cutover.notAllowed") };
    const caller = await access(parsed.data);
    if (!caller) return { error: await reply("cutover.notAllowed") };
    try {
        await run(caller, parsed.data);
    } catch (caught) {
        if (caught instanceof cutovers.CutoverRefusedError) {
            return { error: await reply(`cutover.refused.${caught.reason}`) };
        }
        console.error("polaris: a DNS cutover step failed:", caught);
        return { error: await reply("cutover.failed") };
    }
    return { panel: await cutovers.cutoverPanel(parsed.data, caller.environmentIds) };
}

/** The domain's latest cutover and where it may move, checked again if stale. */
export async function cutoverPanelAction(domainId: string): Promise<CutoverReply> {
    return step(domainId, async () => undefined);
}

/** Check the target and open a cutover of the domain to it. */
export async function startCutoverAction(input: {
    domainId: string;
    targetApplicationId: string;
}): Promise<CutoverReply> {
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("cutover.chooseTarget") };
    return step(parsed.data.domainId, async (caller, domainId) => {
        await cutovers.startCutover({
            domainId,
            targetApplicationId: parsed.data.targetApplicationId,
            actorId: caller.userId,
            environmentIds: caller.environmentIds
        });
    });
}

/** Point the domain at the target of its open cutover. */
export async function switchCutoverAction(domainId: string): Promise<CutoverReply> {
    const result = await step(domainId, async (caller, id) => {
        await cutovers.switchCutover(await cutovers.openCutoverId(id), caller.userId);
    });
    revalidatePath(DEPLOY_PATH);
    return result;
}

/** Put the domain back the way it was before its open cutover. */
export async function rollbackCutoverAction(domainId: string): Promise<CutoverReply> {
    const result = await step(domainId, async (caller, id) => {
        await cutovers.rollbackCutover(await cutovers.openCutoverId(id), caller.userId);
    });
    revalidatePath(DEPLOY_PATH);
    return result;
}
