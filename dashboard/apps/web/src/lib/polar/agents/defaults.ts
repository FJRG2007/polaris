/**
 * A person's settings for the agents that come with Polaris - Polar itself,
 * Claude Code, Codex and the other coding tools: the account each signs in
 * with and the models it may use. No row is the defaults: the first account
 * that works and every model it offers.
 *
 * Server-only.
 */

import { Prisma, prisma } from "@polaris/db";
import { agentWorkSchema, POLAR_ENGINE, type AgentWork } from "@/lib/polar/agents/shared";
import { isAgentEngine, modelsOf, policyOf } from "@/lib/polar/agents/store";

/** The defaults for an engine nobody has set anything for. */
export function blankWork(engine: string): AgentWork {
    return { engine, account: null, models: [], modelPolicy: "preferred" };
}

/** Every engine's settings this person has saved, by engine. */
export async function agentDefaultsFor(userId: string): Promise<Map<string, AgentWork>> {
    const rows = await prisma.polarAgentDefault.findMany({
        where: { userId },
        select: { engine: true, account: true, models: true, modelPolicy: true },
        take: 100
    });
    return new Map(
        rows
            .filter((row) => isAgentEngine(row.engine))
            .map((row) => [
                row.engine,
                {
                    engine: row.engine,
                    account: row.account,
                    models: modelsOf(row.models),
                    modelPolicy: policyOf(row.modelPolicy)
                }
            ])
    );
}

/** Polar's own settings as an agent, or null when none are saved or they
 *  cannot be read: a chat still answers on what it picked. */
export async function polarAgentDefault(userId: string): Promise<AgentWork | null> {
    let row: { models: Prisma.JsonValue; modelPolicy: string } | null = null;
    try {
        row = await prisma.polarAgentDefault.findUnique({
            where: { userId_engine: { userId, engine: POLAR_ENGINE } },
            select: { models: true, modelPolicy: true }
        });
    } catch (error) {
        console.error("polar: could not read Polar's own agent settings", error);
    }
    return row
        ? {
              engine: POLAR_ENGINE,
              account: null,
              models: modelsOf(row.models),
              modelPolicy: policyOf(row.modelPolicy)
          }
        : null;
}

/** Saves one engine's settings; null when the input does not read. */
export async function setAgentDefault(userId: string, raw: unknown): Promise<AgentWork | null> {
    const parsed = agentWorkSchema.safeParse(raw);
    if (!parsed.success || !isAgentEngine(parsed.data.engine)) return null;
    const { engine, account, models, modelPolicy } = parsed.data;
    const data = {
        account,
        models: models as unknown as Prisma.InputJsonValue,
        modelPolicy
    };
    await prisma.polarAgentDefault.upsert({
        where: { userId_engine: { userId, engine } },
        create: { userId, engine, ...data },
        update: data
    });
    return parsed.data;
}
