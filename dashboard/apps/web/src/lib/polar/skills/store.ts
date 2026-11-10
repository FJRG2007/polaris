/**
 * Polar skills in the database, always read and written for their owner, and
 * always bounded: at most `SKILL_LIMIT` per person, each field held to the
 * sizes in `shared.ts` before it is written.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { catalogSkill } from "@/lib/polar/skills/catalog";
import {
    SKILL_LIMIT,
    skillInputSchema,
    type SkillInput,
    type SkillView
} from "@/lib/polar/skills/shared";

const SELECT = {
    id: true,
    name: true,
    description: true,
    instructions: true,
    enabled: true,
    source: true
} as const;

const uuidSchema = z.string().uuid();

export type SkillRefusal = "invalid" | "limit" | "duplicate" | "not_found";

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: unknown })?.code === "P2002";
}

export async function listSkills(ownerId: string): Promise<SkillView[]> {
    return prisma.polarSkill.findMany({
        where: { ownerId },
        select: SELECT,
        orderBy: { createdAt: "asc" },
        take: SKILL_LIMIT
    });
}

/** What a chat turn lists: the enabled ones, without their ids. */
export async function enabledSkills(
    ownerId: string
): Promise<Pick<SkillInput, "name" | "description" | "instructions">[]> {
    return prisma.polarSkill.findMany({
        where: { ownerId, enabled: true },
        select: { name: true, description: true, instructions: true },
        orderBy: { createdAt: "asc" },
        take: SKILL_LIMIT
    });
}

/** Adds a skill, from the editor or the catalog. */
export async function createSkill(
    ownerId: string,
    raw: unknown,
    source = "custom"
): Promise<SkillView | SkillRefusal> {
    const input = skillInputSchema.safeParse(raw);
    if (!input.success) return "invalid";
    const held = await prisma.polarSkill.findMany({
        where: { ownerId },
        select: { name: true },
        take: SKILL_LIMIT
    });
    if (held.length >= SKILL_LIMIT) return "limit";
    if (held.some((entry) => entry.name === input.data.name)) return "duplicate";
    try {
        return await prisma.polarSkill.create({
            data: { ownerId, ...input.data, source },
            select: SELECT
        });
    } catch (error) {
        // Two adds of one name at the same moment: the index answers.
        if (isUniqueViolation(error)) return "duplicate";
        throw error;
    }
}

/** Adds a built-in skill as the person's own copy. */
export async function addCatalogSkill(
    ownerId: string,
    id: string
): Promise<SkillView | SkillRefusal> {
    const found = catalogSkill(id);
    if (!found) return "not_found";
    return createSkill(
        ownerId,
        { name: found.name, description: found.description, instructions: found.instructions },
        found.id
    );
}

export async function updateSkill(
    ownerId: string,
    id: string,
    raw: unknown
): Promise<SkillView | SkillRefusal> {
    if (!uuidSchema.safeParse(id).success) return "not_found";
    const input = skillInputSchema.safeParse(raw);
    if (!input.success) return "invalid";
    try {
        const { count } = await prisma.polarSkill.updateMany({
            where: { id, ownerId },
            data: input.data
        });
        if (count === 0) return "not_found";
    } catch (error) {
        if (isUniqueViolation(error)) return "duplicate";
        throw error;
    }
    const saved = await prisma.polarSkill.findFirst({ where: { id, ownerId }, select: SELECT });
    return saved ?? "not_found";
}

export async function setSkillEnabled(
    ownerId: string,
    id: string,
    enabled: boolean
): Promise<boolean> {
    if (!uuidSchema.safeParse(id).success) return false;
    const { count } = await prisma.polarSkill.updateMany({
        where: { id, ownerId },
        data: { enabled }
    });
    return count > 0;
}

export async function deleteSkill(ownerId: string, id: string): Promise<boolean> {
    if (!uuidSchema.safeParse(id).success) return false;
    const { count } = await prisma.polarSkill.deleteMany({ where: { id, ownerId } });
    return count > 0;
}
