/**
 * Edits over built-in and Enigma skills in the database: a person's own, and
 * the instance-wide ones an administrator writes. Every read is the caller's
 * own rows plus the instance's, bounded; every write is checked against the
 * schemas in `overrides.ts`. Who may write the instance tier is the caller's
 * to decide (`skill-override-actions.ts`); this module only stores.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { SKILL_CATALOG, catalogSkill } from "@/lib/polar/skills/catalog";
import { enigmaCatalogue, type EnigmaSkill } from "@/lib/polar/skills/enigma-catalogue";
import * as layers from "@/lib/polar/skills/overrides";
import type { OverrideRow, OverrideTier, ResolvedSkill, SkillText } from "@/lib/polar/skills/overrides";
import type { ChatSkill } from "@/lib/polar/skills/tools";

/** Two tiers over every built-in, Enigma skill and command there could be. */
const ROWS_MOST = 600;

const SELECT = {
    owner: true,
    skill: true,
    description: true,
    instructions: true,
    baseDescription: true,
    baseInstructions: true,
    enabled: true
} as const;

interface StoredRow extends OverrideRow {
    owner: string;
    skill: string;
    enabled: boolean | null;
}

export interface OverrideTiers {
    readonly instance: StoredRow | null;
    readonly user: StoredRow | null;
}

export type OverrideRefusal = "not_found" | "moved" | "invalid";

/** The caller's rows and the instance's, by skill key. */
export async function overrideTiers(userId: string, keys?: readonly string[]): Promise<Map<string, OverrideTiers>> {
    const rows: StoredRow[] = await prisma.polarSkillOverride.findMany({
        where: {
            owner: { in: [userId, layers.INSTANCE_OWNER] },
            ...(keys ? { skill: { in: [...keys] } } : {})
        },
        select: SELECT,
        take: ROWS_MOST
    });
    const tiers = new Map<string, OverrideTiers>();
    for (const row of rows) {
        const entry = tiers.get(row.skill) ?? { instance: null, user: null };
        tiers.set(row.skill, row.owner === layers.INSTANCE_OWNER ? { ...entry, instance: row } : { ...entry, user: row });
    }
    return tiers;
}

/** The shipped text of a skill key, or null when nothing ships it. */
export async function upstreamOf(key: string): Promise<SkillText | null> {
    const parsed = layers.parseSkillKey(key);
    if (!parsed) return null;
    if (parsed.kind === "builtin") {
        const found = catalogSkill(parsed.name);
        return found ? { description: found.description, instructions: found.instructions } : null;
    }
    const found = (await enigmaCatalogue()).skills.find((skill) => skill.name === parsed.name);
    return found ? { description: found.description, instructions: found.instructions } : null;
}

export interface UpstreamSkillView {
    readonly key: string;
    readonly name: string;
    readonly resolved: ResolvedSkill;
    /** A built-in's own switch; null for Enigma's, which its settings switch. */
    readonly enabled: boolean | null;
}

/** One built-in or Enigma skill, as this person reads it. */
export async function upstreamSkillView(userId: string, key: string): Promise<UpstreamSkillView | null> {
    const parsed = layers.parseSkillKey(key);
    const upstream = await upstreamOf(key);
    if (!parsed || !upstream) return null;
    const tiers = (await overrideTiers(userId, [key])).get(key);
    return {
        key,
        name: parsed.name,
        resolved: layers.resolveSkill(upstream, tiers?.instance, tiers?.user),
        enabled: parsed.kind === "builtin" ? tiers?.user?.enabled === true : null
    };
}

function ownerOf(userId: string, tier: OverrideTier): { owner: string; userId: string | null } {
    return tier === "instance" ? { owner: layers.INSTANCE_OWNER, userId: null } : { owner: userId, userId };
}

/**
 * Stores an edit on one tier. `against` is the fingerprint of the text below
 * it as the editor saw it: when that text has changed since, nothing is stored
 * and the editor is told to look again.
 */
export async function saveOverride(
    userId: string,
    input: { skill: string; tier: OverrideTier; against: string } & SkillText
): Promise<UpstreamSkillView | OverrideRefusal> {
    const view = await upstreamSkillView(userId, input.skill);
    if (!view) return "not_found";
    const below = layers.belowTier(view.resolved, input.tier);
    if (layers.textHash(below) !== input.against) return "moved";
    const { owner, userId: rowUser } = ownerOf(userId, input.tier);
    const text = { description: input.description, instructions: input.instructions };
    const unchanged = text.description === below.description && text.instructions === below.instructions;
    // Saving the upstream text back is the same as resetting.
    if (unchanged) return (await resetOverride(userId, input.skill, input.tier)) ?? "not_found";
    await prisma.polarSkillOverride.upsert({
        where: { owner_skill: { owner, skill: input.skill } },
        create: {
            owner,
            userId: rowUser,
            skill: input.skill,
            ...text,
            baseDescription: below.description,
            baseInstructions: below.instructions
        },
        update: { ...text, baseDescription: below.description, baseInstructions: below.instructions },
        select: { id: true }
    });
    return (await upstreamSkillView(userId, input.skill)) ?? "not_found";
}

/** Drops a tier's edit; a built-in's own switch survives it. */
export async function resetOverride(
    userId: string,
    key: string,
    tier: OverrideTier
): Promise<UpstreamSkillView | null> {
    const { owner } = ownerOf(userId, tier);
    await prisma.polarSkillOverride.deleteMany({ where: { owner, skill: key, enabled: null } });
    await prisma.polarSkillOverride.updateMany({
        where: { owner, skill: key },
        data: { description: null, instructions: null, baseDescription: null, baseInstructions: null }
    });
    return upstreamSkillView(userId, key);
}

/** Keeps a tier's edit and records the upstream it now sits on, so it stops being flagged. */
export async function keepOverride(
    userId: string,
    key: string,
    tier: OverrideTier
): Promise<UpstreamSkillView | null> {
    const view = await upstreamSkillView(userId, key);
    if (!view || !view.resolved[tier]) return view;
    const below = layers.belowTier(view.resolved, tier);
    const { owner } = ownerOf(userId, tier);
    await prisma.polarSkillOverride.updateMany({
        where: { owner, skill: key },
        data: { baseDescription: below.description, baseInstructions: below.instructions }
    });
    return upstreamSkillView(userId, key);
}

/** A person's switch for one built-in skill. */
export async function setBuiltinEnabled(userId: string, key: string, enabled: boolean): Promise<boolean> {
    const parsed = layers.parseSkillKey(key);
    if (parsed?.kind !== "builtin" || !catalogSkill(parsed.name)) return false;
    await prisma.polarSkillOverride.upsert({
        where: { owner_skill: { owner: userId, skill: key } },
        create: { owner: userId, userId, skill: key, enabled },
        update: { enabled },
        select: { id: true }
    });
    return true;
}

export interface OverrideSummary {
    /** The tier whose edit is in effect, if any. */
    readonly edited: OverrideTier | null;
    /** Any edit in effect sits on an upstream that has changed since. */
    readonly upstreamChanged: boolean;
    readonly enabled: boolean;
}

function summarize(resolved: ResolvedSkill, enabled: boolean): OverrideSummary {
    const top = resolved.user ? "user" : resolved.instance ? "instance" : null;
    return {
        edited: top,
        upstreamChanged: Boolean(resolved.user?.upstreamChanged || resolved.instance?.upstreamChanged),
        enabled
    };
}

/** What the lists show for every built-in and Enigma skill: edited, outdated, on. */
export async function overrideSummaries(
    userId: string,
    enigma: readonly EnigmaSkill[]
): Promise<Record<string, OverrideSummary>> {
    const tiers = await overrideTiers(userId);
    const out: Record<string, OverrideSummary> = {};
    for (const skill of SKILL_CATALOG) {
        const key = layers.skillKey("builtin", skill.id);
        const entry = tiers.get(key);
        out[key] = summarize(layers.resolveSkill(skill, entry?.instance, entry?.user), entry?.user?.enabled === true);
    }
    for (const skill of enigma) {
        const key = layers.skillKey("enigma", skill.name);
        const entry = tiers.get(key);
        out[key] = summarize(layers.resolveSkill(skill, entry?.instance, entry?.user), true);
    }
    return out;
}

/**
 * The built-in and Enigma skills a chat loads for this person, with every
 * edit applied: the built-ins they switched on, and the Enigma skills given
 * (already filtered to the ones switched on). One read.
 */
export async function effectiveUpstreamSkills(
    userId: string,
    enigma: readonly EnigmaSkill[]
): Promise<{ builtins: ChatSkill[]; enigma: ChatSkill[] }> {
    const tiers = await overrideTiers(userId);
    const builtins = SKILL_CATALOG.flatMap((skill) => {
        const entry = tiers.get(layers.skillKey("builtin", skill.id));
        if (entry?.user?.enabled !== true) return [];
        const resolved = layers.resolveSkill(skill, entry.instance, entry.user);
        return [{ name: skill.name, description: resolved.description, instructions: resolved.instructions }];
    });
    const edited = enigma.map((skill) => {
        const entry = tiers.get(layers.skillKey("enigma", skill.name));
        const resolved = layers.resolveSkill(skill, entry?.instance, entry?.user);
        return { name: skill.name, description: resolved.description, instructions: resolved.instructions };
    });
    return { builtins, enigma: edited };
}
