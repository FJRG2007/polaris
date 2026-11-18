"use server";

/**
 * Cloud accounts on AI provider keys: add one from its form, or sign in to
 * DigitalOcean and paste back the address it returned to. Every account is the
 * signed-in person's own.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { cloudCredentialSchema } from "@/lib/agents/cloud-credentials";
import {
    addCloudAccount,
    finishDigitaloceanLogin,
    startDigitaloceanLogin,
    type DigitaloceanFinish
} from "@/lib/agents/cloud-accounts";

export type CloudAddResult = { ok: true } | { ok: false; reason: string };

function settled(result: DigitaloceanFinish): CloudAddResult {
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/account/ai-keys");
    return { ok: true };
}

export async function addCloudAccountAction(input: unknown): Promise<CloudAddResult> {
    const user = await requireUser();
    const parsed = cloudCredentialSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    try {
        return settled(await addCloudAccount(user.id, parsed.data));
    } catch (caught) {
        console.warn("[cloud-account] add failed:", caught instanceof Error ? caught.name : "error");
        return { ok: false, reason: "unreachable" };
    }
}

export async function startDigitaloceanLoginAction(): Promise<{ id: string; url: string }> {
    const user = await requireUser();
    return startDigitaloceanLogin(user.id);
}

export async function finishDigitaloceanLoginAction(input: unknown): Promise<CloudAddResult> {
    const user = await requireUser();
    const parsed = z
        .object({ id: z.string().uuid(), pasted: z.string().trim().min(1).max(8192) })
        .safeParse(input);
    if (!parsed.success) return { ok: false, reason: "bad-paste" };
    try {
        return settled(await finishDigitaloceanLogin(user.id, parsed.data.id, parsed.data.pasted));
    } catch (caught) {
        console.warn("[cloud-account] DigitalOcean failed:", caught instanceof Error ? caught.name : "error");
        return { ok: false, reason: "unreachable" };
    }
}
