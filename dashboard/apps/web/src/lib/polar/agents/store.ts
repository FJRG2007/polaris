/**
 * Custom Polar agents in the database, always read and written for their
 * owner, and always bounded: at most `AGENT_LIMIT` per person, each field held
 * to the sizes in `shared.ts` before it is written.
 *
 * Server-only.
 */

import { z } from "zod";
import { Prisma, prisma } from "@polaris/db";
import { modelChoiceSchema } from "@/lib/polar/shared";
import { AGENT_LIMIT, agentInputSchema, type AgentView } from "@/lib/polar/agents/shared";

const SELECT = {
    id: true,
    name: true,
    description: true,
    instructions: true,
    skills: true,
    connectorIds: true,
    web: true,
    choice: true
} as const;

const uuidSchema = z.string().uuid();

export type AgentRefusal = "invalid" | "limit" | "duplicate" | "not_found";

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: unknown })?.code === "P2002";
}

function viewOf(row: Prisma.PolarAgentGetPayload<{ select: typeof SELECT }>): AgentView {
    return {
        ...row,
        choice: modelChoiceSchema
            .nullable()
            .catch(null)
            .parse(row.choice ?? null)
    };
}

export async function listAgents(ownerId: string): Promise<AgentView[]> {
    const rows = await prisma.polarAgent.findMany({
        where: { ownerId },
        select: SELECT,
        orderBy: { createdAt: "asc" },
        take: AGENT_LIMIT
    });
    return rows.map(viewOf);
}

/** One of the person's agents, or null when it is not theirs or is gone. */
export async function agentFor(ownerId: string, id: string): Promise<AgentView | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const row = await prisma.polarAgent.findFirst({ where: { id, ownerId }, select: SELECT });
    return row ? viewOf(row) : null;
}

/**
 * The agent a chat answers as: the one a stored chat was started with, or for a
 * chat not stored yet the one its first turn names. Null for plain Polar, and
 * for an agent deleted since.
 */
export async function polarThreadAgent(
    ownerId: string,
    threadId: string,
    asked: string | null
): Promise<AgentView | null> {
    const thread = await prisma.polarThread.findFirst({
        where: { id: threadId, userId: ownerId },
        select: { agentId: true }
    });
    const id = thread ? thread.agentId : asked;
    return id ? agentFor(ownerId, id) : null;
}

function dataOf(input: z.infer<typeof agentInputSchema>) {
    return {
        ...input,
        choice: input.choice ? (input.choice as unknown as Prisma.InputJsonValue) : Prisma.DbNull
    };
}

export async function createAgent(
    ownerId: string,
    raw: unknown
): Promise<AgentView | AgentRefusal> {
    const input = agentInputSchema.safeParse(raw);
    if (!input.success) return "invalid";
    const held = await prisma.polarAgent.count({ where: { ownerId } });
    if (held >= AGENT_LIMIT) return "limit";
    try {
        return viewOf(
            await prisma.polarAgent.create({
                data: { ownerId, ...dataOf(input.data) },
                select: SELECT
            })
        );
    } catch (error) {
        if (isUniqueViolation(error)) return "duplicate";
        throw error;
    }
}

export async function updateAgent(
    ownerId: string,
    id: string,
    raw: unknown
): Promise<AgentView | AgentRefusal> {
    if (!uuidSchema.safeParse(id).success) return "not_found";
    const input = agentInputSchema.safeParse(raw);
    if (!input.success) return "invalid";
    try {
        const { count } = await prisma.polarAgent.updateMany({
            where: { id, ownerId },
            data: dataOf(input.data)
        });
        if (count === 0) return "not_found";
    } catch (error) {
        if (isUniqueViolation(error)) return "duplicate";
        throw error;
    }
    return (await agentFor(ownerId, id)) ?? "not_found";
}

export async function deleteAgent(ownerId: string, id: string): Promise<boolean> {
    if (!uuidSchema.safeParse(id).success) return false;
    const { count } = await prisma.polarAgent.deleteMany({ where: { id, ownerId } });
    return count > 0;
}
