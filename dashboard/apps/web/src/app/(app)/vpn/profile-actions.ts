"use server";

/** A person's own VPNs. Every read and change is scoped to the signed-in user. */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import * as service from "@/lib/vpn/profile-service";
import { MAX_PROFILE_BYTES, MAX_PROFILES } from "@/lib/vpn/profile-limits";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

const filesSchema = z
    .array(z.object({ name: z.string().min(1).max(255), text: z.string().max(MAX_PROFILE_BYTES) }))
    .min(1)
    .max(MAX_PROFILES);

const idSchema = z.string().uuid();

async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("vpn");
    if (error instanceof service.ProfileRefusal) {
        return { error: t(`connect.own.errors.${error.code}`, { limit: MAX_PROFILES }) };
    }
    if (error instanceof z.ZodError) return { error: t("connect.own.errors.unreadable") };
    console.error("polaris: a VPN profile action failed:", error instanceof Error ? error.name : "unknown");
    return { error: t("errors.generic") };
}

export async function importProfilesAction(
    input: unknown
): Promise<Result<{ added: number; rejected: string[] }>> {
    const user = await requireUser();
    try {
        const answer = await service.importProfiles(user.id, filesSchema.parse(input));
        if (answer.added > 0) {
            await recordAudit({
                actorId: user.id,
                action: "vpn.profile.import",
                targetType: "vpn",
                targetId: user.id
            });
        }
        return answer;
    } catch (error) {
        return failed(error);
    }
}

export async function removeProfileAction(input: unknown): Promise<Result> {
    const user = await requireUser();
    try {
        const id = idSchema.parse(input);
        await service.removeProfile(user.id, id);
        await recordAudit({
            actorId: user.id,
            action: "vpn.profile.remove",
            targetType: "vpn",
            targetId: id
        });
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** Hands the tunnel, private key included, to its owner's app at the moment of connecting. */
export async function openProfileAction(
    input: unknown
): Promise<Result<{ profile: Awaited<ReturnType<typeof service.openProfile>> }>> {
    const user = await requireUser();
    try {
        return { profile: await service.openProfile(user.id, idSchema.parse(input)) };
    } catch (error) {
        return failed(error);
    }
}
