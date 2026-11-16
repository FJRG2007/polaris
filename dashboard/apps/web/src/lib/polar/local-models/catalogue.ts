/**
 * The models a person's own computers serve (Ollama, LM Studio, vLLM,
 * llama.cpp), as Polar's picker offers them while that computer is online.
 *
 * Polaris never dials those servers: the runner on the computer found them on
 * its own loopback (or a private address the person added there) and runs the
 * turn itself (`chat.turn` with `local`). So there is no address here to guard,
 * only which runner, which server and which model to name.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { isOnline } from "@/lib/computers/computer-service";
import type { PolarProviderOption } from "@/lib/polar/models";

export const LOCAL_MODELS_PROVIDER = "computer-models";

/** The context window assumed for a local model, which no listing reports. */
const LOCAL_CONTEXT_TOKENS = 32_000;

const SERVER_NAMES: Record<core.LocalModelServer, string> = {
    ollama: "Ollama",
    lmstudio: "LM Studio",
    vllm: "vLLM",
    llamacpp: "llama.cpp"
};

export interface LocalModelRef {
    readonly runnerId: string;
    readonly server: core.LocalModelServer;
    readonly host: string;
    readonly model: string;
}

/** One model's id in the picker: the runner, server and host, then the model's
 *  own id, which may itself hold `:` or `/`. Pure. */
export function localModelId(ref: LocalModelRef): string {
    return `${ref.runnerId}:${ref.server}:${encodeURIComponent(ref.host)}:${ref.model}`;
}

/** The parts of a picker id, or null when it is not one. Pure. */
export function readLocalModelId(id: string): LocalModelRef | null {
    const first = id.indexOf(":");
    const second = id.indexOf(":", first + 1);
    const third = id.indexOf(":", second + 1);
    if (first < 1 || second < 0 || third < 0) return null;
    const server = id.slice(first + 1, second);
    if (!(core.LOCAL_MODEL_SERVERS as readonly string[]).includes(server)) return null;
    let host: string;
    try {
        host = decodeURIComponent(id.slice(second + 1, third));
    } catch {
        return null;
    }
    const model = id.slice(third + 1);
    if (!host || !model) return null;
    return { runnerId: id.slice(0, first), server: server as core.LocalModelServer, host, model };
}

interface RunnerRow {
    id: string;
    name: string;
    capabilities: unknown;
}

/** What a runner's stored capabilities say it serves, or nothing. Pure. */
export function servedBy(capabilities: unknown): NonNullable<core.RunnerCapabilities["localModels"]> {
    if (!core.runnerHasFeature(capabilities as { features?: string[] } | null, "local-models")) return [];
    const parsed = core.runnerCapabilitiesSchema.shape.localModels.safeParse((capabilities as { localModels?: unknown } | null)?.localModels);
    return parsed.success ? (parsed.data ?? []) : [];
}

/** The picker's provider for these online computers, or null when none of
 *  them serves a model. `name` is the reader's word for it. Pure. */
export function localModelsProvider(rows: readonly RunnerRow[], name: string): PolarProviderOption | null {
    const models: PolarProviderOption["models"] = [];
    for (const row of rows) {
        for (const served of servedBy(row.capabilities)) {
            const where = served.host === "loopback" ? row.name : `${row.name} (${served.host})`;
            for (const entry of served.models) {
                models.push({
                    provider: LOCAL_MODELS_PROVIDER,
                    providerName: `${SERVER_NAMES[served.server]} - ${where}`,
                    model: localModelId({ runnerId: row.id, server: served.server, host: served.host, model: entry.id }),
                    name: `${entry.name ?? entry.id} - ${where}`,
                    reasoning: false,
                    attachment: false,
                    contextTokens: LOCAL_CONTEXT_TOKENS,
                    providerContextTokens: null,
                    costInput: null,
                    costOutput: null,
                    inputs: [],
                    releaseDate: null
                });
            }
        }
    }
    return models.length > 0 ? { provider: LOCAL_MODELS_PROVIDER, name, payers: ["own"], models } : null;
}

/** This person's online computers announcing local models. */
export async function localModelRunners(userId: string, now = Date.now()): Promise<RunnerRow[]> {
    const rows = await prisma.agentRunner.findMany({
        where: { userId, relayNode: { not: null } },
        select: { id: true, name: true, relayNode: true, lastSeenAt: true, capabilities: true },
        orderBy: { lastSeenAt: "desc" },
        take: 20
    });
    return rows.filter((row) => isOnline(row, now) && servedBy(row.capabilities).length > 0);
}

/** The server's display name. Pure. */
export function localServerName(server: core.LocalModelServer): string {
    return SERVER_NAMES[server];
}

/** Whether `ref` names a model one of this person's online computers still
 *  announces: a stale pick fails here, before a frame is sent - `offline`
 *  when that computer is not connected, `unreachable` when it no longer finds
 *  that server, `model-missing` when the server no longer lists the model. */
export async function localModelState(userId: string, ref: LocalModelRef, now = Date.now()): Promise<"ready" | "offline" | "unreachable" | "model-missing"> {
    const row = await prisma.agentRunner.findFirst({
        where: { id: ref.runnerId, userId, relayNode: { not: null } },
        select: { relayNode: true, lastSeenAt: true, capabilities: true }
    });
    if (!row || !isOnline(row, now)) return "offline";
    const server = servedBy(row.capabilities).find((served) => served.server === ref.server && served.host === ref.host);
    if (!server) return "unreachable";
    return server.models.some((entry) => entry.id === ref.model) ? "ready" : "model-missing";
}
