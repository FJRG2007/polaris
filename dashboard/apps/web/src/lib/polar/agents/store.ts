/**
 * Custom Polar agents in the database, always read and written for their
 * owner, and always bounded: at most `AGENT_LIMIT` per person, each field held
 * to the sizes in `shared.ts` before it is written.
 *
 * Server-only.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { Prisma, prisma } from "@polaris/db";
import { modelChoiceSchema, type ModelChoice } from "@/lib/polar/shared";
import { rulesOf } from "@/lib/polar/agents/permissions";
import {
    AGENT_LIMIT,
    agentInputSchema,
    agentModelSchema,
    AGENT_MODES,
    MODEL_POLICIES,
    POLAR_ENGINE,
    type AgentModel,
    type AgentView
} from "@/lib/polar/agents/shared";

const SELECT = {
    id: true,
    name: true,
    description: true,
    instructions: true,
    skills: true,
    connectorIds: true,
    web: true,
    choice: true,
    engine: true,
    account: true,
    models: true,
    modelPolicy: true,
    permission: true,
    mode: true,
    shared: true,
    ownerId: true
} as const;

const uuidSchema = z.string().uuid();

export type AgentRefusal = "invalid" | "limit" | "duplicate" | "not_found";

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: unknown })?.code === "P2002";
}

/** A stored models list, read whole: an entry that no longer reads is left
 *  out rather than failing the agent. */
export function modelsOf(raw: unknown): AgentModel[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        const parsed = agentModelSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

export function policyOf(raw: unknown): AgentView["modelPolicy"] {
    return MODEL_POLICIES.includes(raw as AgentView["modelPolicy"])
        ? (raw as AgentView["modelPolicy"])
        : "preferred";
}

/** Whether an engine is one an agent can run on: Polar, or a coding tool the
 *  catalogue knows (a custom command is not one). */
export function isAgentEngine(engine: string): boolean {
    return engine === POLAR_ENGINE || (engine !== core.CUSTOM_AGENT_CLI && core.isKnownAgentCli(engine));
}

function viewOf(
    { ownerId, permission, mode, ...row }: Prisma.PolarAgentGetPayload<{ select: typeof SELECT }>,
    viewer: string
): AgentView {
    const choice = modelChoiceSchema
        .nullable()
        .catch(null)
        .parse(row.choice ?? null);
    const models = modelsOf(row.models);
    return {
        ...row,
        choice,
        engine: isAgentEngine(row.engine) ? row.engine : POLAR_ENGINE,
        // An agent saved before it had a list answered on its one model.
        models:
            models.length > 0 || !choice ? models : [{ provider: choice.provider, model: choice.model }],
        modelPolicy: policyOf(row.modelPolicy),
        permission: rulesOf(permission),
        mode: AGENT_MODES.includes(mode as AgentView["mode"]) ? (mode as AgentView["mode"]) : "all",
        mine: ownerId === viewer
    };
}

/** The agents a person may use: their own, and the instance-wide ones. */
function visibleTo(viewer: string): Prisma.PolarAgentWhereInput {
    return { OR: [{ ownerId: viewer }, { shared: true }] };
}

export async function listAgents(ownerId: string): Promise<AgentView[]> {
    const rows = await prisma.polarAgent.findMany({
        where: visibleTo(ownerId),
        select: SELECT,
        // Their own first, then the instance's.
        orderBy: [{ shared: "asc" }, { createdAt: "asc" }],
        take: AGENT_LIMIT * 2
    });
    return rows.map((row) => viewOf(row, ownerId));
}

/** An agent the person may use (their own or an instance-wide one), or null
 *  when it is neither or is gone. */
export async function agentFor(ownerId: string, id: string): Promise<AgentView | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const row = await prisma.polarAgent.findFirst({
        where: { id, ...visibleTo(ownerId) },
        select: SELECT
    });
    return row ? viewOf(row, ownerId) : null;
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

function dataOf(input: z.infer<typeof agentInputSchema>, admin: boolean) {
    // What reads an agent's one model reads the first of the list, on Polar.
    const first = input.models[0];
    // An emptied list is "any model", not the one it had before.
    const choice: ModelChoice | null =
        input.engine === POLAR_ENGINE && first
            ? { kind: "language", ...first, intelligence: "balanced", payer: null }
            : null;
    return {
        ...input,
        choice: choice ? (choice as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        models: input.models as unknown as Prisma.InputJsonValue,
        permission: input.permission as unknown as Prisma.InputJsonValue,
        // Only an administrator offers an agent to the whole instance.
        shared: admin && input.shared
    };
}

export async function createAgent(
    ownerId: string,
    raw: unknown,
    admin = false
): Promise<AgentView | AgentRefusal> {
    const input = agentInputSchema.safeParse(raw);
    if (!input.success || !isAgentEngine(input.data.engine)) return "invalid";
    const held = await prisma.polarAgent.count({ where: { ownerId } });
    if (held >= AGENT_LIMIT) return "limit";
    try {
        return viewOf(
            await prisma.polarAgent.create({
                data: { ownerId, ...dataOf(input.data, admin) },
                select: SELECT
            }),
            ownerId
        );
    } catch (error) {
        if (isUniqueViolation(error)) return "duplicate";
        throw error;
    }
}

export async function updateAgent(
    ownerId: string,
    id: string,
    raw: unknown,
    admin = false
): Promise<AgentView | AgentRefusal> {
    if (!uuidSchema.safeParse(id).success) return "not_found";
    const input = agentInputSchema.safeParse(raw);
    if (!input.success || !isAgentEngine(input.data.engine)) return "invalid";
    try {
        const { count } = await prisma.polarAgent.updateMany({
            where: { id, ownerId },
            data: dataOf(input.data, admin)
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
