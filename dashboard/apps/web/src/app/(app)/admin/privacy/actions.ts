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
import { DISCOVERY_POLICY_KEY, discoveryPolicySchema } from "@/lib/discovery-policy";
import * as core from "@polaris/core";
import { privacyDefaultKey, setDefaultAudience } from "@/lib/privacy-service";

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
