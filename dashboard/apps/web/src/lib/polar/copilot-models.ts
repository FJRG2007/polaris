/**
 * The models one GitHub Copilot login can actually call, in Copilot's own
 * words. The catalogue (models.dev) lists every model Copilot has ever
 * offered on any plan, so a login on a plan without one of them answered
 * `400 model_not_supported` on every turn Automatic sent there.
 *
 * `GET {copilot api}/models`, with the login's GitHub token as the bearer,
 * lists `{ data: [{ id, name, policy: { state }, capabilities: { limits,
 * supports } }] }` for that account. A model whose `policy.state` is
 * `disabled` is one the plan or the organisation's policy has not enabled
 * (GitHub Docs, "Configuring access to AI models in GitHub Copilot" - models
 * available depend on the plan, and owners turn models on or off by policy:
 * https://docs.github.com/en/copilot/how-tos/use-ai-models/configure-access-to-ai-models).
 * The read and the filter follow OpenCode's provider
 * (`packages/core/src/github-copilot/models.ts`, `load` and `usable`): a
 * model is offered only when it is not disabled and states its prompt and
 * output limits and whether it calls tools - which leaves embedding and
 * completion-only entries out.
 *
 * Kept per login (a hash of its token) in memory, stale-while-revalidate: a
 * remembered list answers at once and a fresh one is read in the background
 * once it is older than `KEPT_MS`. With nothing remembered the first read is
 * waited for, bounded by `TIMEOUT_MS`. A read that fails is remembered as
 * unknown for `FAILED_KEPT_MS`, and unknown means "the catalogue's list", so
 * a Copilot hiccup never empties the picker. Server-only.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import type { ChatCredential } from "@/lib/agents/model-keys";
import { copilotBaseUrl, copilotChatHeaders } from "@/lib/agents/signin-copilot";

const KEPT_MS = 30 * 60_000;
const FAILED_KEPT_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
/** Logins remembered at most, so a busy instance's memory stays bounded. */
const KEPT_MOST = 500;
/** Models read from one answer at most. */
const MODELS_MOST = 500;

/** One model the login can call. */
export interface CopilotModel {
    readonly id: string;
    readonly name: string;
    /** The prompt window Copilot reports; null when it reports none. */
    readonly contextTokens: number | null;
}

const remoteModel = z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
    policy: z.object({ state: z.string().optional() }).passthrough().optional(),
    capabilities: z
        .object({
            limits: z
                .object({
                    max_context_window_tokens: z.number().optional(),
                    max_prompt_tokens: z.number().optional(),
                    max_output_tokens: z.number().optional()
                })
                .passthrough()
                .optional(),
            supports: z.object({ tool_calls: z.boolean().optional() }).passthrough().optional()
        })
        .passthrough()
});

const listing = z.object({ data: z.array(z.unknown()).max(MODELS_MOST * 4) });

/**
 * The callable models in a `/models` answer, or null when the answer is not
 * a listing at all. Pure.
 */
export function copilotModelsIn(body: unknown): CopilotModel[] | null {
    const parsed = listing.safeParse(body);
    if (!parsed.success) return null;
    const models: CopilotModel[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.data.data) {
        const entry = remoteModel.safeParse(raw);
        if (!entry.success) continue;
        const { id, name, policy, capabilities } = entry.data;
        if (policy?.state === "disabled") continue;
        const limits = capabilities.limits;
        if (limits?.max_output_tokens === undefined || limits.max_prompt_tokens === undefined) continue;
        if (capabilities.supports?.tool_calls === undefined) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const window = limits.max_context_window_tokens ?? limits.max_prompt_tokens;
        models.push({ id, name: name?.trim() || id, contextTokens: window > 0 ? window : null });
        if (models.length >= MODELS_MOST) break;
    }
    return models;
}

type Listed = readonly CopilotModel[] | null;

const kept = new Map<string, { models: Listed; until: number }>();
/** Lists being read now, so one login is never asked twice at once. */
const reading = new Map<string, Promise<Listed>>();

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function readModels(credential: CopilotCredential, fetchImpl: Fetch): Promise<Listed> {
    const base = copilotBaseUrl(credential.oauth?.apiEndpoint, credential.oauth?.enterpriseUrl);
    const response = await fetchImpl(`${base}/models`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.secret}`,
            ...copilotChatHeaders()
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`copilot models answered ${response.status}`);
    return copilotModelsIn(await response.json());
}

async function refresh(key: string, credential: CopilotCredential, fetchImpl: Fetch): Promise<Listed> {
    let models: Listed;
    let until: number;
    try {
        models = await readModels(credential, fetchImpl);
        until = Date.now() + (models ? KEPT_MS : FAILED_KEPT_MS);
    } catch {
        // A remembered list outlives a failed refresh: the plan did not change
        // because GitHub did not answer once.
        models = kept.get(key)?.models ?? null;
        until = Date.now() + FAILED_KEPT_MS;
    }
    kept.delete(key);
    if (kept.size >= KEPT_MOST) {
        const oldest = kept.keys().next().value;
        if (oldest !== undefined) kept.delete(oldest);
    }
    kept.set(key, { models, until });
    return models;
}

type CopilotCredential = Pick<ChatCredential, "secret" | "oauth">;

/**
 * The models this Copilot login can call, or null when Copilot could not be
 * asked - the caller then keeps the catalogue's list. Never throws.
 */
export async function copilotModels(
    credential: CopilotCredential | null,
    options: { now?: number; fetch?: Fetch } = {}
): Promise<Listed> {
    if (!credential?.secret) return null;
    const now = options.now ?? Date.now();
    const key = createHash("sha256").update(credential.secret).digest("hex");
    const hit = kept.get(key);
    if (hit && hit.until > now) return hit.models;
    let pending = reading.get(key);
    if (!pending) {
        pending = refresh(key, credential, options.fetch ?? fetch).finally(() => reading.delete(key));
        reading.set(key, pending);
    }
    return hit ? hit.models : pending;
}

/**
 * The models every one of these logins reaches, merged by id; null when none
 * of them could be asked. Never throws.
 */
export async function copilotModelsFor(
    credentials: readonly CopilotCredential[],
    options: { now?: number; fetch?: Fetch } = {}
): Promise<Listed> {
    const lists = await Promise.all(credentials.map((credential) => copilotModels(credential, options)));
    const known = lists.filter((list): list is readonly CopilotModel[] => list !== null);
    if (known.length === 0) return null;
    const merged = new Map<string, CopilotModel>();
    for (const list of known) for (const model of list) if (!merged.has(model.id)) merged.set(model.id, model);
    return [...merged.values()];
}

/** Test seam: forget every remembered list. */
export function forgetCopilotModels(): void {
    kept.clear();
    reading.clear();
}
