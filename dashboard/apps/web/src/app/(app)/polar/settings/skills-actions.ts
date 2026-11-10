"use server";

/**
 * The Skills section of Polar's settings, and the Add button of a chat that
 * is trying a skill. Every action establishes the signed-in person and their
 * Polar access, validates its input with the same schema the editor uses, and
 * touches only that person's own skills. Somebody viewing as another account
 * reads, and never writes.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import * as store from "@/lib/polar/skills/store";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { skillInputSchema, trialSkillSchema, type SkillView } from "@/lib/polar/skills/shared";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function writer(): Promise<{ id: string } | { error: string }> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) return { error: t("settings.skills.errors.noAccess") };
    if (user.viewingAs) return { error: t("settings.skills.errors.viewingAs") };
    return { id: user.id };
}

async function answer(result: SkillView | store.SkillRefusal): Promise<Result<SkillView>> {
    if (typeof result !== "string") return { ok: true, value: result };
    const t = await getTranslations("polar");
    const code = result === "invalid" ? "failed" : result;
    return { ok: false, error: t(`settings.skills.errors.${code}`) };
}

export async function listSkillsAction(): Promise<Result<SkillView[]>> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) return { ok: false, error: t("settings.skills.errors.noAccess") };
    return { ok: true, value: await store.listSkills(user.id) };
}

const saveSchema = z.object({
    id: z.string().uuid().nullable().default(null),
    skill: skillInputSchema
});

/** Creates a skill, or saves one being edited. */
export async function saveSkillAction(input: unknown): Promise<Result<SkillView>> {
    const caller = await writer();
    if ("error" in caller) return { ok: false, error: caller.error };
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return answer("invalid");
    const { id, skill } = parsed.data;
    return answer(
        id ? await store.updateSkill(caller.id, id, skill) : await store.createSkill(caller.id, skill)
    );
}

/** Adds what a chat tried: a catalog skill by id, or the draft it was given. */
export async function addTrialSkillAction(input: unknown): Promise<Result<SkillView>> {
    const caller = await writer();
    if ("error" in caller) return { ok: false, error: caller.error };
    const parsed = trialSkillSchema.safeParse(input);
    if (!parsed.success) return answer("invalid");
    return answer(
        "catalog" in parsed.data
            ? await store.addCatalogSkill(caller.id, parsed.data.catalog)
            : await store.createSkill(caller.id, parsed.data.draft)
    );
}

const toggleSchema = z.object({ id: z.string().uuid(), enabled: z.boolean() });

export async function setSkillEnabledAction(input: unknown): Promise<Result<null>> {
    const caller = await writer();
    if ("error" in caller) return { ok: false, error: caller.error };
    const parsed = toggleSchema.safeParse(input);
    const t = await getTranslations("polar");
    if (!parsed.success) return { ok: false, error: t("settings.skills.errors.failed") };
    return (await store.setSkillEnabled(caller.id, parsed.data.id, parsed.data.enabled))
        ? { ok: true, value: null }
        : { ok: false, error: t("settings.skills.errors.not_found") };
}

export async function deleteSkillAction(input: unknown): Promise<Result<null>> {
    const caller = await writer();
    if ("error" in caller) return { ok: false, error: caller.error };
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    const t = await getTranslations("polar");
    if (!parsed.success) return { ok: false, error: t("settings.skills.errors.failed") };
    // Already gone is what was asked for.
    await store.deleteSkill(caller.id, parsed.data.id);
    return { ok: true, value: null };
}
