/**
 * The "/" commands each person writes for Polar. Every query names the owner,
 * and a person keeps at most `POLAR_COMMAND_MOST`.
 *
 * Server-only.
 */

import { prisma, type Prisma } from "@polaris/db";
import { polarModelOptions } from "@/lib/polar/models";
import {
    automaticChoice,
    isAutomatic,
    modelChoiceSchema,
    POLAR_COMMAND_MOST,
    type ModelChoice,
    type PolarCommandRow
} from "@/lib/polar/shared";

const SELECT = { id: true, shortcut: true, prompt: true, choice: true } as const;

type Stored = { id: string; shortcut: string; prompt: string; choice: unknown };

/** A stored row as the screen reads it. A choice that no longer parses (a row
 *  older than the schema) reads as Automatic rather than failing the list. */
function toRow(row: Stored): PolarCommandRow {
    const choice = modelChoiceSchema.safeParse(row.choice);
    return {
        id: row.id,
        shortcut: row.shortcut,
        prompt: row.prompt,
        choice: choice.success ? choice.data : automaticChoice()
    };
}

export async function listPolarCommands(userId: string): Promise<PolarCommandRow[]> {
    const rows = await prisma.polarCommand.findMany({
        where: { userId },
        select: SELECT,
        orderBy: { shortcut: "asc" },
        take: POLAR_COMMAND_MOST
    });
    return rows.map(toRow);
}

/** Why a write is refused. */
export type CommandRefusal = "too_many" | "taken" | "unknown_model" | "not_found";

/** Whether the choice is Automatic or a model this person can use now. */
async function usableChoice(userId: string, choice: ModelChoice): Promise<boolean> {
    if (isAutomatic(choice)) return true;
    const provider = (await polarModelOptions(userId)).find(
        (entry) => entry.provider === choice.provider
    );
    if (!provider?.models.some((model) => model.model === choice.model)) return false;
    return !choice.payer || provider.payers.includes(choice.payer);
}

function isTaken(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as Prisma.PrismaClientKnownRequestError).code === "P2002"
    );
}

type Input = { shortcut: string; prompt: string; choice: ModelChoice };

export async function createPolarCommand(
    userId: string,
    input: Input
): Promise<PolarCommandRow | CommandRefusal> {
    if ((await prisma.polarCommand.count({ where: { userId } })) >= POLAR_COMMAND_MOST) {
        return "too_many";
    }
    if (!(await usableChoice(userId, input.choice))) return "unknown_model";
    try {
        return toRow(
            await prisma.polarCommand.create({
                data: {
                    userId,
                    shortcut: input.shortcut,
                    prompt: input.prompt,
                    choice: input.choice as unknown as Prisma.InputJsonValue
                },
                select: SELECT
            })
        );
    } catch (error) {
        if (isTaken(error)) return "taken";
        throw error;
    }
}

export async function updatePolarCommand(
    userId: string,
    id: string,
    input: Input
): Promise<PolarCommandRow | CommandRefusal> {
    if (!(await usableChoice(userId, input.choice))) return "unknown_model";
    try {
        const { count } = await prisma.polarCommand.updateMany({
            where: { id, userId },
            data: {
                shortcut: input.shortcut,
                prompt: input.prompt,
                choice: input.choice as unknown as Prisma.InputJsonValue
            }
        });
        return count > 0 ? { id, ...input } : "not_found";
    } catch (error) {
        if (isTaken(error)) return "taken";
        throw error;
    }
}

export async function deletePolarCommand(userId: string, id: string): Promise<boolean> {
    const { count } = await prisma.polarCommand.deleteMany({ where: { id, userId } });
    return count > 0;
}
