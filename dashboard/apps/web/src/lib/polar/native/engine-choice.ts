/**
 * Which engine runs a Polar Code session: the person's setting ("Automatic",
 * Polaris native, or one of the coding CLIs), the composer's override for one
 * session, and what the pick can actually run on.
 *
 * Automatic keeps today's behaviour - `resolveCodeEngine()` in
 * code-sources.ts - until `NATIVE_SESSIONS_ENABLED` is turned on, after which
 * it sends API keys and Polar's own providers to the native engine and keeps
 * subscriptions and machine sign-ins on their vendor's CLI.
 *
 * An engine that cannot run the pick is listed with the reason, never offered
 * and then refused; and the server resolves the choice again on every start
 * (`engineFor`), falling back to Automatic when a stored choice no longer
 * fits. Pure and client-safe.
 */

import { z } from "zod";
import type { CodeSource } from "@/lib/polar/agents/code-sources";

/**
 * The rollout switch. Off: Automatic resolves exactly as before. Turn it on
 * only once the parity tests in docs/polar-native-sessions.md pass.
 */
export const NATIVE_SESSIONS_ENABLED = false;

/**
 * Whether the native engine can be started on a placement yet: its bundle,
 * catalogue row and launch are wired. While false, "Polaris native" is listed
 * but disabled with that reason.
 */
export const NATIVE_RUNTIME_READY = false;

/** The native engine's id, beside the catalogue's CLI ids. */
export const NATIVE_ENGINE = "polaris-native";
/** The stored value for Automatic is null; this is how the client names it. */
export const AUTO_ENGINE = "auto";

/** A stored or sent choice: Automatic, native, or a catalogue CLI id. */
export const sessionEngineSchema = z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/);

export type EngineDisabledReason = "notReady" | "cannotServe" | "notInstalled";

export interface EngineOption {
    readonly id: string;
    readonly disabled: EngineDisabledReason | null;
}

type SourceFacts = Pick<CodeSource, "key" | "kind" | "engines">;

/** Whether the native engine can run this source at all: a linked API key or
 *  Polar's own providers. Never a subscription or a machine's own sign-in,
 *  which only the vendor's tool can use, and never the deployment's
 *  environment (`server:<engine>`), whose credential may be either and lives
 *  only in that CLI's environment. */
export function nativeCanServe(source: SourceFacts): boolean {
    return source.kind === "apiKey" || source.kind === "polar";
}

/** The CLIs that can run this source, preferred first, without Polar's chat runtime. */
function cliEngines(source: SourceFacts): string[] {
    return source.engines.filter((engine) => engine !== "polar");
}

/**
 * Every engine the menu lists for a pick, each enabled or with the reason it
 * is not. `known` is every CLI id the catalogue knows; `installed` the ones
 * present on the placement, or null when that is not known (a fresh container
 * installs its CLI, so nothing is disabled for it).
 */
export function engineOptions(
    source: SourceFacts,
    known: readonly string[],
    installed: ReadonlySet<string> | null,
    nativeReady: boolean = NATIVE_RUNTIME_READY
): EngineOption[] {
    const serving = new Set(cliEngines(source));
    const native: EngineOption = {
        id: NATIVE_ENGINE,
        disabled: !nativeCanServe(source) ? "cannotServe" : !nativeReady ? "notReady" : null
    };
    const clis = [...new Set([...cliEngines(source), ...known])].map(
        (id): EngineOption => ({
            id,
            disabled: !serving.has(id) ? "cannotServe" : installed && !installed.has(id) ? "notInstalled" : null
        })
    );
    return [native, ...clis];
}

/**
 * The engine Automatic picks today, and after the switch. `fallback` is what
 * `resolveCodeEngine()` already chose.
 */
export function automaticEngine(
    source: SourceFacts,
    fallback: string,
    enabled: boolean = NATIVE_SESSIONS_ENABLED,
    nativeReady: boolean = NATIVE_RUNTIME_READY
): string {
    return enabled && nativeReady && nativeCanServe(source) ? NATIVE_ENGINE : fallback;
}

/**
 * The engine a start runs on: the session's override, else the person's
 * setting, when that engine is enabled for the pick; Automatic otherwise.
 */
export function engineFor(input: {
    readonly source: SourceFacts;
    /** What `resolveCodeEngine()` chose. */
    readonly fallback: string;
    readonly setting: string | null;
    readonly override: string | null;
    readonly known: readonly string[];
    readonly installed: ReadonlySet<string> | null;
    readonly enabled?: boolean;
    readonly nativeReady?: boolean;
}): string {
    const nativeReady = input.nativeReady ?? NATIVE_RUNTIME_READY;
    const options = engineOptions(input.source, input.known, input.installed, nativeReady);
    const usable = (id: string | null) =>
        id && id !== AUTO_ENGINE && options.some((option) => option.id === id && option.disabled === null) ? id : null;
    return (
        usable(input.override) ??
        usable(input.setting) ??
        automaticEngine(input.source, input.fallback, input.enabled ?? NATIVE_SESSIONS_ENABLED, nativeReady)
    );
}
