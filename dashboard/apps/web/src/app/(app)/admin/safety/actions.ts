"use server";

/** Settling a case about a person, or about an account that shut itself down.
 *  Reported messages keep their own actions: what "removed" means for a message
 *  is a moderation decision with a message behind it, and none of that applies
 *  to a person. */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { settleCaseSchema } from "@polaris/core";
import { settleSafetyCase } from "@/lib/safety-queue";

export async function settleSafetyCaseAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = settleCaseSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That could not be read." };

    const result = await settleSafetyCase(admin.id, parsed.data);
    if (result.error) return result;
    revalidatePath("/admin/safety");
    return {};
}
