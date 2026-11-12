/**
 * A session start's engine, resolved on the server from the (source, model)
 * the person picked - never a tool the client named. Shared by Polar Code and
 * Tasks' "give to an agent", so both refuse a pick that is not theirs alike.
 */

import * as core from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import type { SessionUser } from "@/lib/session";
import { agentOptionsFor } from "@/lib/agents/agent-readiness";
import {
    codePickSchema,
    codeSourcesFor,
    isPolarSource,
    POLAR_KEYS_ENGINE,
    POLAR_RUNTIME,
    resolveCodeEngine,
    sourceForWork,
    accountSourceKey,
    machineSourceKey,
    polarSourceKey,
    type CodePick
} from "@/lib/polar/agents/code-sources";

/** A start sent before Code was model-first named the tool and account; it is
 *  read as the source they meant, and the engine is resolved again. */
function legacyPick(body: Record<string, unknown>): CodePick | null {
    const cli = typeof body.cli === "string" ? body.cli : null;
    if (!cli) return null;
    const choice = core.sessionModelChoiceSchema.nullable().safeParse(body.modelChoice ?? null);
    const model = choice.success && choice.data ? choice.data : null;
    const source =
        typeof body.accountId === "string"
            ? accountSourceKey(body.accountId)
            : body.useMachineLogin === true
              ? machineSourceKey(cli)
              : cli === POLAR_KEYS_ENGINE && model
                ? polarSourceKey(model.provider)
                : `tool:${cli}`;
    return { source, provider: model?.provider ?? "", model: model?.model ?? null };
}

/**
 * The start body with the engine the pick resolves to, from this person's own
 * sources - never a tool the client named. An error when the pick is not one
 * of theirs any more.
 */
export async function resolvedStart(
    user: SessionUser,
    raw: Record<string, unknown>
): Promise<{ input: Record<string, unknown> } | { error: string }> {
    const { pick: rawPick, cli: _cli, accountId: _account, useMachineLogin: _machine, modelChoice: _model, ...rest } = raw;
    let pick: CodePick | null = null;
    if (rawPick !== undefined && rawPick !== null) {
        const parsed = codePickSchema.safeParse(rawPick);
        if (!parsed.success) return { error: (await getTranslations("polar"))("code.noSource") };
        pick = parsed.data;
    } else {
        pick = legacyPick(raw);
    }
    // Nothing picked: the start action says what is missing.
    if (!pick) return { input: raw };
    const options = await agentOptionsFor(user.id);
    const sources = codeSourcesFor(options);
    const offered = new Set(options.map((option) => option.cli));
    const source = isPolarSource(pick.source)
        ? {
              key: pick.source,
              engines: [POLAR_RUNTIME, POLAR_KEYS_ENGINE].filter(
                  (engine) => engine === POLAR_RUNTIME || offered.has(engine)
              ),
              accountId: null,
              machine: false,
              payer: null,
              polarProvider: pick.source.slice("polar:".length)
          }
        : pick.source.startsWith("tool:")
          ? sourceForWork(sources, pick.source.slice("tool:".length), null)
          : (sources.find((entry) => entry.key === pick.source) ?? null);
    const resolved = source
        ? resolveCodeEngine(source, { provider: pick.provider, model: pick.model }, { needsSession: true })
        : null;
    if (!resolved) return { error: (await getTranslations("polar"))("code.noSource") };
    return {
        input: {
            ...rest,
            cli: resolved.cli,
            accountId: resolved.accountId,
            useMachineLogin: resolved.useMachineLogin,
            modelChoice: resolved.modelChoice
        }
    };
}
