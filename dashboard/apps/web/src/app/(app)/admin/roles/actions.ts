"use server";

/**
 * Admin-only role management: what each role grants, and adding or removing the
 * ones this instance defines for itself. The rules about which roles may be
 * edited or deleted live in the service; this file validates input and refreshes
 * the screens a change is visible on.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { createRoleSchema, roleGrantsSchema } from "@polaris/core";
import { publishAccessChange } from "@/lib/access-live";
import { createRole, deleteRole, setRolePermissions } from "@/lib/role-service";

const idSchema = z.string().uuid();

/** A role change moves what people can do, so both screens that show it are
 *  stale afterwards - the roles editor and the people directory that assigns
 *  them. */
function refresh(): void {
    revalidatePath("/admin/roles");
    revalidatePath("/admin/users");
}

export async function createRoleAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = createRoleSchema.safeParse(input);
    const t = await getTranslations("admin");
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t("roles.errors.invalidRole") };

    const result = await createRole(admin.id, parsed.data);
    if (result.error) return { error: result.error };
    refresh();
    return {};
}

export async function setRolePermissionsAction(roleId: unknown, input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const id = idSchema.safeParse(roleId);
    const parsed = roleGrantsSchema.safeParse(input);
    const t = await getTranslations("admin");
    if (!id.success) return { error: t("roles.errors.unknownRole") };
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t("roles.errors.invalidPermissions") };

    const result = await setRolePermissions(admin.id, id.data, parsed.data.permissions);
    if (result.error) return result;
    // Everybody holding it, and working out who that is is a query and a chance
    // to be wrong - so nobody is named and every open tab redraws. A role is
    // rewritten a handful of times in an instance's life. See `access-live`.
    publishAccessChange();
    refresh();
    return {};
}

export async function deleteRoleAction(roleId: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const id = idSchema.safeParse(roleId);
    if (!id.success) return { error: (await getTranslations("admin"))("roles.errors.unknownRole") };

    const result = await deleteRole(admin.id, id.data);
    if (result.error) return result;
    publishAccessChange();
    refresh();
    return {};
}
