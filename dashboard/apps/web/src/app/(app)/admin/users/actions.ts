"use server";

/** Admin-only user management: create and revoke invites. */

import { revalidatePath } from "next/cache";
import { createInviteSchema } from "@polaris/core";
import { requireAdmin } from "@/lib/session";
import { createInvite, revokeInvite } from "@/lib/invite-service";

export async function createInviteAction(input: unknown): Promise<{ token?: string; error?: string }> {
    const admin = await requireAdmin();
    const parsed = createInviteSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    const { token } = await createInvite(admin.id, parsed.data.email, parsed.data.role);
    revalidatePath("/admin/users");
    return { token };
}

export async function revokeInviteAction(id: string): Promise<void> {
    await requireAdmin();
    await revokeInvite(id);
    revalidatePath("/admin/users");
}
