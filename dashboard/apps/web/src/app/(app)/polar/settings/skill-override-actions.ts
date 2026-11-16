"use server";

/**
 * Reading and editing the built-in and Enigma skills: open one, store an edit
 * over it, reset it, keep an edit once upstream moved, and switch a built-in
 * on or off. A person writes only their own tier; the instance tier is for
 * administrators, checked here on every write with the same rule the screen
 * uses to show the choice (`canEditInstanceSkills`).
 */

import { z } from "zod";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { requireUser, type SessionUser } from "@/lib/session";
import * as overrides from "@/lib/polar/skills/override-store";
import { canEditInstanceSkills } from "@/lib/polar/skills/override-access";
import {
    builtinEnabledSchema,
    keepOverrideSchema,
    resetOverrideSchema,
    saveOverrideSchema,
    skillKeySchema,
    type OverrideTier
} from "@/lib/polar/skills/overrides";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface UpstreamSkillAnswer {
    readonly view: overrides.UpstreamSkillView;
    /** Whether this person may write the instance tier. */
    readonly canInstance: boolean;
}

async function reader(): Promise<SessionUser | { error: string }> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    if (!(await polarAccessFor(user.id)).use) return { error: t("settings.skills.errors.noAccess") };
    return user;
}

/** The caller, when they may write `tier`. */
async function writer(tier: OverrideTier): Promise<SessionUser | { error: string }> {
    const user = await reader();
    if ("error" in user) return user;
    const t = await getTranslations("polar");
    if (user.viewingAs) return { error: t("settings.skills.errors.viewingAs") };
    if (tier === "instance" && !canEditInstanceSkills(user))
        return { error: t("settings.skills.errors.adminOnly") };
    return user;
}

async function answered(
    user: SessionUser,
    view: overrides.UpstreamSkillView | overrides.OverrideRefusal | null
): Promise<Result<UpstreamSkillAnswer>> {
    const t = await getTranslations("polar");
    if (view === null || view === "not_found") return { ok: false, error: t("settings.skills.errors.not_found") };
    if (view === "moved") return { ok: false, error: t("settings.skills.errors.moved") };
    if (view === "invalid") return { ok: false, error: t("settings.skills.errors.failed") };
    return { ok: true, value: { view, canInstance: canEditInstanceSkills(user) } };
}

async function invalid<T>(): Promise<Result<T>> {
    const t = await getTranslations("polar");
    return { ok: false, error: t("settings.skills.errors.failed") };
}

/** One built-in or Enigma skill as the caller reads it, both tiers applied. */
export async function readUpstreamSkillAction(input: unknown): Promise<Result<UpstreamSkillAnswer>> {
    const user = await reader();
    if ("error" in user) return { ok: false, error: user.error };
    const parsed = z.object({ skill: skillKeySchema }).strict().safeParse(input);
    if (!parsed.success) return invalid();
    return answered(user, await overrides.upstreamSkillView(user.id, parsed.data.skill));
}

export async function saveSkillOverrideAction(input: unknown): Promise<Result<UpstreamSkillAnswer>> {
    const parsed = saveOverrideSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const user = await writer(parsed.data.tier);
    if ("error" in user) return { ok: false, error: user.error };
    return answered(user, await overrides.saveOverride(user.id, parsed.data));
}

export async function resetSkillOverrideAction(input: unknown): Promise<Result<UpstreamSkillAnswer>> {
    const parsed = resetOverrideSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const user = await writer(parsed.data.tier);
    if ("error" in user) return { ok: false, error: user.error };
    return answered(user, await overrides.resetOverride(user.id, parsed.data.skill, parsed.data.tier));
}

export async function keepSkillOverrideAction(input: unknown): Promise<Result<UpstreamSkillAnswer>> {
    const parsed = keepOverrideSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const user = await writer(parsed.data.tier);
    if ("error" in user) return { ok: false, error: user.error };
    return answered(user, await overrides.keepOverride(user.id, parsed.data.skill, parsed.data.tier));
}

export async function setBuiltinSkillEnabledAction(input: unknown): Promise<Result<null>> {
    const parsed = builtinEnabledSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const user = await writer("user");
    if ("error" in user) return { ok: false, error: user.error };
    return (await overrides.setBuiltinEnabled(user.id, parsed.data.skill, parsed.data.enabled))
        ? { ok: true, value: null }
        : invalid();
}
