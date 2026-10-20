/**
 * Polar's projects: folders of chats, each with instructions that are added to
 * the system context of every chat filed under it. Every query names the owner.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { POLAR_PROJECT_MOST, type PolarProjectRow } from "@/lib/polar/shared";

const SELECT = { id: true, name: true, instructions: true } as const;

/** The new project, or null once the person already keeps the most allowed. */
export async function createPolarProject(
    ownerId: string,
    input: { name: string; instructions: string }
): Promise<PolarProjectRow | null> {
    if ((await prisma.polarProject.count({ where: { ownerId } })) >= POLAR_PROJECT_MOST) {
        return null;
    }
    return prisma.polarProject.create({
        data: { ownerId, name: input.name, instructions: input.instructions },
        select: SELECT
    });
}

export async function updatePolarProject(
    ownerId: string,
    id: string,
    input: { name?: string; instructions?: string }
): Promise<boolean> {
    const { count } = await prisma.polarProject.updateMany({ where: { id, ownerId }, data: input });
    return count > 0;
}

/** Deletes the folder; its chats are kept and go back to Recents. */
export async function deletePolarProject(ownerId: string, id: string): Promise<boolean> {
    const { count } = await prisma.polarProject.deleteMany({ where: { id, ownerId } });
    return count > 0;
}
