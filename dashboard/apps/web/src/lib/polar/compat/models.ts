/**
 * `GET /v1/models`: the ids an API key's owner can send as `model`. The
 * Claude tier ids come first, as free-claude-code lists them
 * (`api/model_catalog.py`), each landing on the tier route the person set;
 * then every `provider/model` they hold a key for. Each entry carries both
 * OpenAI's fields (`object`, `created`, `owned_by`) and Anthropic's (`type`,
 * `display_name`, `created_at`), and the list both pagers (`first_id`,
 * `last_id`, `has_more`), so either SDK's model listing reads it.
 */

import { compatCaller } from "@/lib/polar/compat/auth";
import { GATEWAY_PREFIX, NO_THINKING_PREFIX, TIER_MODEL_IDS } from "@/lib/polar/compat/route-model";
import { errorResponse, isCompatError } from "@/lib/polar/compat/errors";
import { polarModelOptions, type PolarProviderOption } from "@/lib/polar/models";

/** free-claude-code's placeholder date for models with no known release. */
const UNKNOWN_DATE = "1970-01-01T00:00:00Z";

function entry(id: string, name: string, owner: string, released: string | null) {
    const at = released && !Number.isNaN(Date.parse(released)) ? new Date(released) : null;
    return {
        id,
        object: "model",
        created: at ? Math.floor(at.getTime() / 1000) : 0,
        owned_by: owner,
        type: "model",
        display_name: name,
        created_at: at ? at.toISOString().replace(/\.\d{3}Z$/, "Z") : UNKNOWN_DATE
    };
}

/** The listing for these options. Pure. */
export function modelList(options: readonly PolarProviderOption[]) {
    const data = [
        ...TIER_MODEL_IDS.map((tier) => entry(tier.id, tier.name, "polaris", null)),
        ...options.flatMap((provider) =>
            provider.models.flatMap((model) => {
                const ref = `${provider.provider}/${model.model}`;
                const name = `${model.name} (${provider.name})`;
                const native = provider.provider === "anthropic";
                const ids = [];
                // The forms Claude Code discovers (free-claude-code
                // `_build_claude_models_response`): the gateway id for a model
                // that thinks or speaks Anthropic natively, and a no-thinking
                // id for every other one.
                if (native || model.reasoning) {
                    ids.push(entry(`${GATEWAY_PREFIX}${ref}`, name, provider.provider, model.releaseDate));
                }
                if (!native) {
                    ids.push(
                        entry(`${NO_THINKING_PREFIX}${ref}`, `${name} (no thinking)`, provider.provider, model.releaseDate)
                    );
                }
                // And the plain form OpenAI-compatible clients send.
                ids.push(entry(ref, name, provider.provider, model.releaseDate));
                return ids;
            })
        )
    ];
    return {
        object: "list",
        data,
        first_id: data[0]?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
        has_more: false
    };
}

export async function listModels(request: Request): Promise<Response> {
    const caller = await compatCaller(request);
    if (isCompatError(caller)) return errorResponse(caller, "anthropic");
    return Response.json(modelList(await polarModelOptions(caller.userId, caller.access)));
}
