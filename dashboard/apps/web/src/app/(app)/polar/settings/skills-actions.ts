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
import * as remote from "@/lib/polar/skills/remote";
import { enigmaCatalogue } from "@/lib/polar/skills/enigma-catalogue";
import { ownEnigma, saveOwnEnigma } from "@/lib/agents/agent-defaults-service";
import { applyEnigmaPrefs, enigmaPrefsSchema } from "@/lib/polar/enigma-prefs";
import {
    DIRECTORY_SOURCE,
    skillInputSchema,
    trialSkillSchema,
    type SkillView
} from "@/lib/polar/skills/shared";
import {
    markDuplicates,
    readSkillBundle,
    readSkillFile,
    type SkillCandidate
} from "@/lib/polar/skills/skill-file";

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

/** Searches and imports reach other servers; this bounds what one person makes them do. */
const REMOTE_LIMIT = 60;
const REMOTE_WINDOW_MS = 10 * 60 * 1000;

async function remoteCaller(): Promise<{ id: string } | { error: string }> {
    const caller = await writer();
    if ("error" in caller) return caller;
    const { rateLimit } = await import("@/lib/rate-limit-service");
    const allowed = await rateLimit(`polar-skills-remote:${caller.id}`, REMOTE_LIMIT, REMOTE_WINDOW_MS);
    if (allowed.ok) return caller;
    const t = await getTranslations("polar");
    return { error: t("settings.skills.errors.slowDown") };
}

const searchSchema = z.object({ query: z.string().trim().min(2).max(200) });

/** The public skills directory's matches for what the person typed. */
export async function searchSkillDirectoryAction(
    input: unknown
): Promise<Result<remote.DirectoryEntry[]>> {
    const caller = await remoteCaller();
    if ("error" in caller) return { ok: false, error: caller.error };
    const parsed = searchSchema.safeParse(input);
    const t = await getTranslations("polar");
    if (!parsed.success) return { ok: false, error: t("settings.skills.errors.failed") };
    const found = await remote.searchDirectory(parsed.data.query);
    return found ? { ok: true, value: found } : { ok: false, error: t("settings.skills.errors.unreachable") };
}

const previewSchema = z.union([
    z.object({ url: z.string().trim().min(1).max(2048) }).strict(),
    z.object({ directory: z.string().trim().min(1).max(400) }).strict(),
    z
        .object({
            files: z
                .array(
                    z.object({
                        name: z.string().trim().min(1).max(500),
                        text: z.string().max(300_000)
                    })
                )
                .min(1)
                .max(remote.IMPORT_MAX)
        })
        .strict()
]);

export interface SkillPreview {
    candidates: SkillCandidate[];
    /** For a directory skill: what its audits said. */
    audit: remote.DirectoryAudit | null;
}

/** What an address, a directory entry or chosen files hold, before anything is added. */
export async function previewSkillImportAction(input: unknown): Promise<Result<SkillPreview>> {
    const parsed = previewSchema.safeParse(input);
    const t = await getTranslations("polar");
    if (!parsed.success) return { ok: false, error: t("settings.skills.errors.address") };
    const request = parsed.data;
    // Files are read here and reach nobody else; only addresses are rate-limited.
    const caller = "files" in request ? await writer() : await remoteCaller();
    if ("error" in caller) return { ok: false, error: caller.error };

    let found: SkillCandidate[] | remote.RemoteRefusal;
    let audit: remote.DirectoryAudit | null = null;
    if ("files" in request) {
        found = request.files.flatMap(
            (file) =>
                (/\.json$/i.test(file.name) ? readSkillBundle(file.text, file.name) : null) ?? [
                    readSkillFile(file.text, skillNameFromPath(file.name), file.name)
                ]
        );
        if (found.length > remote.IMPORT_MAX) found = "too_many";
    } else if ("directory" in request) {
        const one = await remote.directorySkill(request.directory);
        found = typeof one === "string" ? one : [one];
        if (typeof one !== "string") audit = await remote.directoryAudit(request.directory);
    } else {
        found = await remote.skillsAt(request.url);
    }
    if (typeof found === "string") return { ok: false, error: t(`settings.skills.errors.${found}`) };
    const held = new Set((await store.listSkills(caller.id)).map((row) => row.name));
    return { ok: true, value: { candidates: markDuplicates(found, held), audit } };
}

/** The name a file's path gives a skill: its folder for a `SKILL.md`, else the file name. */
function skillNameFromPath(path: string): string {
    const parts = path.split(/[\/]/).filter(Boolean);
    const last = parts.at(-1) ?? "skill";
    return last.toLowerCase() === "skill.md" ? (parts.at(-2) ?? "skill") : last.replace(/\.[^.]+$/, "");
}

const importSchema = z.object({
    items: z
        .array(
            z.object({
                skill: skillInputSchema,
                directory: z.string().trim().max(400).nullable().default(null)
            })
        )
        .min(1)
        .max(remote.IMPORT_MAX)
});

/** Adds the skills an import found, each on its own: one refused never stops the rest. */
export async function importSkillsAction(
    input: unknown
): Promise<Result<({ ok: true; value: SkillView } | { ok: false; error: string })[]>> {
    const caller = await writer();
    if ("error" in caller) return { ok: false, error: caller.error };
    const parsed = importSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("polar");
        return { ok: false, error: t("settings.skills.errors.failed") };
    }
    const results: ({ ok: true; value: SkillView } | { ok: false; error: string })[] = [];
    for (const item of parsed.data.items) {
        const source =
            item.directory && remote.isDirectoryId(item.directory)
                ? `${DIRECTORY_SOURCE}${item.directory}`
                : "custom";
        results.push(await answer(await store.createSkill(caller.id, item.skill, source)));
    }
    return { ok: true, value: results };
}

/**
 * Store the caller's Enigma settings on their own general tier. A skill switched
 * off must be one the pinned version ships - or one already off, so a catalogue
 * that cannot be read right now never blocks the other settings.
 */
export async function saveEnigmaAction(input: unknown): Promise<Result<null>> {
    const caller = await writer();
    if ("error" in caller) return { ok: false, error: caller.error };
    const t = await getTranslations("polar");
    const [catalogue, current] = await Promise.all([enigmaCatalogue(), ownEnigma(caller.id)]);
    const known = new Set([
        ...catalogue.skills.map((skill) => skill.name),
        ...(current.own.skillsOff ?? [])
    ]);
    const parsed = enigmaPrefsSchema
        .refine((prefs) => prefs.skillsOff.every((name) => known.has(name)))
        .safeParse(input);
    if (!parsed.success) return { ok: false, error: t("settings.enigma.failed") };
    try {
        await saveOwnEnigma(caller.id, applyEnigmaPrefs(current.own, parsed.data, current.inherited));
    } catch (error) {
        console.error("polar: could not save the Enigma settings", error);
        return { ok: false, error: t("settings.enigma.failed") };
    }
    return { ok: true, value: null };
}
