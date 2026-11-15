/**
 * A session start's engine, resolved on the server from the (source, model)
 * the person picked - never a tool the client named. Shared by Polar Code and
 * Tasks' "give to an agent", so both refuse a pick that is not theirs alike.
 */

import * as core from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import type { SessionUser } from "@/lib/session";
import { polarPreferences } from "@/lib/polar/preferences";
import { agentOptionsFor } from "@/lib/agents/agent-readiness";
import { engineFor, NATIVE_ENGINE, sessionEngineSchema } from "@/lib/polar/native/engine-choice";
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

/** Every CLI id the catalogue knows, for the engine choice. */
const KNOWN_ENGINES = core.AGENT_CLIS.map((cli) => cli.id);

/** The person's stored engine; Automatic when it cannot be read, so a start
 *  never fails over a setting. */
async function engineSetting(userId: string): Promise<string | null> {
    try {
        return (await polarPreferences(userId)).sessionEngine;
    } catch (error) {
        console.error("[polar] session engine setting unreadable", error);
        return null;
    }
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
    const {
        pick: rawPick,
        engine: rawEngine,
        cli: _cli,
        accountId: _account,
        useMachineLogin: _machine,
        modelChoice: _model,
        ...rest
    } = raw;
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
              kind: "polar" as const,
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
    if (!source || !resolved) return { error: (await getTranslations("polar"))("code.noSource") };
    // The person's engine, or this session's override from the composer;
    // either is honoured only where it can run the pick, else Automatic.
    const override = sessionEngineSchema.safeParse(rawEngine);
    const engine = engineFor({
        source,
        fallback: resolved.cli,
        setting: await engineSetting(user.id),
        override: override.success ? override.data : null,
        known: KNOWN_ENGINES,
        installed: null
    });
    // Another CLI that serves the source resolves its own model and sign-in.
    const chosen =
        engine === resolved.cli || engine === NATIVE_ENGINE
            ? resolved
            : (resolveCodeEngine(
                  { ...source, engines: [engine, ...source.engines.filter((entry) => entry !== engine)] },
                  { provider: pick.provider, model: pick.model },
                  { needsSession: true }
              ) ?? resolved);
    return {
        input: {
            ...rest,
            cli: engine === NATIVE_ENGINE ? NATIVE_ENGINE : chosen.cli,
            accountId: chosen.accountId,
            useMachineLogin: chosen.useMachineLogin,
            modelChoice: chosen.modelChoice
        }
    };
}
