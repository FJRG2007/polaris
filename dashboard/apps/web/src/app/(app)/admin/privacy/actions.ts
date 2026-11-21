"use server";

/**
 * The instance-wide privacy settings (/admin/privacy). Administrators only, each
 * re-checked here - a server action is a public endpoint, whatever rendered it -
 * and every change lands in the audit log.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { setDiscoveryPolicy } from "@/lib/people-search";
import { setProfilesPublic } from "@/lib/profile-service";
import { LINK_PREVIEWS_KEY, setInstancePreviews } from "@/lib/chat/link-preview-policy";
import { DISCOVERY_POLICY_KEY, discoveryPolicySchema } from "@/lib/discovery-policy";
import * as core from "@polaris/core";
import {
    privacyDefaultKey,
    privacyLockKey,
    setDefaultAudience,
    setPrivacyLock
} from "@/lib/privacy-service";

/**
 * Whether somebody's page may be read without signing in.
 *
 * Audited, because it changes what leaves
 * the deployment: turning it on makes an address readable by anybody who has it,
 * and whoever asks later deserves to be able to see when that was decided and by
 * whom.
 */
export async function setPublicProfilesAction(allowed: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const on = allowed === true;
    await setProfilesPublic(on);
    await recordAudit({
        actorId: admin.id,
        action: "settings.public-profiles",
        targetType: "setting",
        targetId: "profiles.public",
        metadata: { enabled: on }
    });
    revalidatePath("/admin/privacy");
    return {};
}

/**
 * What one privacy field starts on for every account that never chose it -
 * existing accounts included. Somebody who set the field keeps theirs.
 *
 * Only audiences that name nobody in particular, and only those the field
 * offers: a list belongs to an account, and there is none yet to have one.
 */
export async function setPrivacyDefaultAction(
    field: unknown,
    audience: unknown
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsedField = z.enum(core.PRIVACY_FIELDS).safeParse(field);
    const parsedAudience = z.enum(core.PRIVACY_AUDIENCES).safeParse(audience);
    if (
        !parsedField.success ||
        !parsedAudience.success ||
        !core.defaultAudiencesFor(parsedField.data).includes(parsedAudience.data)
    ) {
        return { error: (await getTranslations("admin"))("privacy.errors.audience") };
    }
    await setDefaultAudience(parsedField.data, parsedAudience.data);
    await recordAudit({
        actorId: admin.id,
        action: "settings.privacy-default",
        targetType: "setting",
        targetId: privacyDefaultKey(parsedField.data),
        metadata: { field: parsedField.data, audience: parsedAudience.data }
    });
    revalidatePath("/admin/privacy");
    return {};
}

/**
 * Whether Chat may look up posted links and draw them as cards, for the whole
 * instance (ledger row 4). Audited: turning it off stops addresses leaving the
 * deployment, and whoever asks later should see who decided and when.
 */
export async function setLinkPreviewsAction(allowed: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.boolean().safeParse(allowed);
    if (!parsed.success) {
        return { error: (await getTranslations("admin"))("privacy.errors.checkSettings") };
    }
    await setInstancePreviews(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "settings.chat-link-previews",
        targetType: "setting",
        targetId: LINK_PREVIEWS_KEY,
        metadata: { enabled: parsed.data }
    });
    revalidatePath("/admin/privacy");
    return {};
}

/**
 * Hold one privacy field to its default for every account, or hand it back.
 * While locked, each account's own choice is kept but not read, and the account
 * screen greys the row out; the lock is enforced where the field is resolved,
 * so no client can save its way past it.
 */
export async function setPrivacyLockAction(
    field: unknown,
    locked: unknown
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsedField = z.enum(core.PRIVACY_FIELDS).safeParse(field);
    const parsedLocked = z.boolean().safeParse(locked);
    if (!parsedField.success || !parsedLocked.success) {
        return { error: (await getTranslations("admin"))("privacy.errors.checkSettings") };
    }
    await setPrivacyLock(parsedField.data, parsedLocked.data);
    await recordAudit({
        actorId: admin.id,
        action: "settings.privacy-lock",
        targetType: "setting",
        targetId: privacyLockKey(parsedField.data),
        metadata: { field: parsedField.data, locked: parsedLocked.data }
    });
    revalidatePath("/admin/privacy");
    return {};
}

/**
 * Which identifiers find somebody who is not a friend or a colleague. Each
 * account's own "who can find me" still applies on top of whatever this says.
 */
export async function setDiscoveryPolicyAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = discoveryPolicySchema.safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("privacy.errors.checkSettings") };
    await setDiscoveryPolicy(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "settings.people-discovery",
        targetType: "setting",
        targetId: DISCOVERY_POLICY_KEY,
        metadata: parsed.data
    });
    revalidatePath("/admin/privacy");
    return {};
}
