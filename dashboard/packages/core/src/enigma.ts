/**
 * Enigma, as something an operator configures rather than something Polaris just
 * does.
 *
 * Every agent Polaris starts works to the operator's standards rather than to the
 * model's defaults: Enigma's policy skills, its operating contract, its slash
 * commands and its post-edit guardrails are installed into the agent's home
 * before it is given anything to do. That is on by default, and it is the right
 * default - a run without it is a run that will format code the way its vendor
 * likes and commit in whatever style its training suggested.
 *
 * It is nonetheless a choice, and Enigma has choices of its own inside it, so all
 * of them live here as one value that can be stored at any tier and resolved
 * down. Three things people actually want to change:
 *
 *   - Turning it off for one session, because they are debugging Enigma itself or
 *     working in a repository whose conventions are not theirs.
 *   - Which parts get installed. The full set is right for a repository the
 *     operator owns; a smaller one is right for a quick session where the install
 *     costs more than the standards buy.
 *   - What the gate does before a push, which is the setting with an actual
 *     minutes-per-run cost attached to it.
 *
 * Null means inherit, everywhere, at every tier. A resolved value is never stored
 * - the moment it is, changing the instance default stops reaching the sessions
 * that were meant to follow it.
 */

import { AGENT_GATE_MODES, type AgentGateMode } from "./agents.js";

/**
 * Which of Enigma's parts an install lands.
 *
 * `all` is what the CLI does with `--all`, and is the default. `policies` is the
 * skills and the operating contract without the slash commands or the memory
 * scaffolding - the parts that change how work is done, none of the parts that
 * change how it is driven. `none` installs nothing and is only reachable by
 * switching Enigma off, which is a different setting and reads better on a
 * screen.
 */
export const ENIGMA_SCOPES = ["all", "policies"] as const;
export type EnigmaScope = (typeof ENIGMA_SCOPES)[number];

export const ENIGMA_SCOPE_LABELS: Record<EnigmaScope, string> = {
    all: "Everything",
    policies: "Policies only"
};

export const ENIGMA_SCOPE_NOTES: Record<EnigmaScope, string> = {
    all: "Skills, the operating contract, the slash commands and the post-edit guardrails.",
    policies: "The skills and the operating contract. Faster to install, and enough to change how the work is done."
};

/**
 * How Enigma is set up for one session or one repository.
 *
 * Every field is nullable and null means "ask the tier above". A stored value of
 * `false` for `enabled` is a deliberate refusal and is honoured; a stored null is
 * a question.
 */
export interface EnigmaSettings {
    readonly enabled: boolean | null;
    readonly scope: EnigmaScope | null;
    readonly gate: AgentGateMode | null;
    /**
     * The npm version spec installs are pinned to. Null takes whatever Polaris
     * ships against, which is the answer for almost everybody; an operator pins
     * one when they need two runs months apart to have worked to the same rules.
     */
    readonly version: string | null;
    /**
     * Extra `enigma config` keys to set before the agent starts, as the CLI names
     * them. This is the escape hatch that stops this file needing an entry per
     * Enigma setting: anything Enigma can be told, it can be told here.
     */
    readonly config: Readonly<Record<string, string>> | null;
}

/** Nothing decided at this tier. */
export const INHERIT_ENIGMA: EnigmaSettings = {
    enabled: null,
    scope: null,
    gate: null,
    version: null,
    config: null
};

/** Everything decided, and every default it is decided to. On rather than off:
 *  see the module comment. */
export const DEFAULT_ENIGMA: Required<{
    [K in keyof EnigmaSettings]: NonNullable<EnigmaSettings[K]>;
}> = {
    enabled: true,
    scope: "all",
    gate: "checks",
    version: "",
    config: {}
};

/** A fully decided setup, with nothing left to ask anybody. */
export type ResolvedEnigma = typeof DEFAULT_ENIGMA;

/**
 * Fold a chain of tiers into one answer, nearest first.
 *
 * The caller passes the tiers in priority order - the session, then the
 * repository, then the owner, then the instance - and the first tier with an
 * opinion about a field wins it. `config` is the one exception and is MERGED from
 * the far tier inwards, because an instance-wide key and a per-session key are
 * different settings rather than competing answers to one, and taking only the
 * nearest would silently drop the operator's instance-wide policy the moment
 * somebody set anything at all on a session.
 */
export function resolveEnigma(...tiers: readonly (EnigmaSettings | null | undefined)[]): ResolvedEnigma {
    const present = tiers.filter((tier): tier is EnigmaSettings => Boolean(tier));
    const first = <K extends keyof EnigmaSettings>(key: K): NonNullable<EnigmaSettings[K]> | null => {
        for (const tier of present) {
            const value = tier[key];
            if (value !== null && value !== undefined) return value as NonNullable<EnigmaSettings[K]>;
        }
        return null;
    };
    const config: Record<string, string> = {};
    for (const tier of [...present].reverse()) {
        for (const [key, value] of Object.entries(tier.config ?? {})) config[key] = value;
    }
    return {
        enabled: first("enabled") ?? DEFAULT_ENIGMA.enabled,
        scope: first("scope") ?? DEFAULT_ENIGMA.scope,
        gate: first("gate") ?? DEFAULT_ENIGMA.gate,
        version: first("version") ?? DEFAULT_ENIGMA.version,
        config
    };
}

/**
 * The install command a resolved setup means, as argv.
 *
 * `--yes` is not optional and is not a setting: without it the CLI opens its
 * picker, and a picker in a session nobody is watching is a process that hangs
 * until something reaps it. The version spec is appended to the package name
 * rather than passed as a flag because that is how npx selects a version.
 */
export function enigmaInstallArgv(settings: ResolvedEnigma): string[] {
    const parts = settings.scope === "all" ? ["--all"] : ["--policies"];
    return ["-y", enigmaPackageSpec(settings), "install", ...parts, "--yes"];
}

/** The npm spec a resolved setup names, pinned or not. One place, so an install
 *  and the config calls that follow it can never reach two different versions. */
export function enigmaPackageSpec(settings: ResolvedEnigma): string {
    return settings.version ? `enigma-cli@${settings.version}` : "enigma-cli";
}

/**
 * The `enigma config` calls a resolved setup means, as one argv per call.
 *
 * Keys are checked here rather than at the form, because they also arrive from a
 * stored row that an older build wrote and from the API. A key that is not a
 * plain setting name is dropped rather than escaped: these become a command line
 * on somebody else's machine, and there is no version of "sanitise it and run it
 * anyway" that is better than not running it.
 */
export function enigmaConfigArgv(settings: ResolvedEnigma): string[][] {
    const safeKey = /^[a-z][a-z0-9-]*$/;
    const safeValue = /^[A-Za-z0-9][A-Za-z0-9._@/:-]*$/;
    return Object.entries(settings.config)
        .filter(([key, value]) => safeKey.test(key) && safeValue.test(value))
        .map(([key, value]) => ["config", key, value]);
}

/**
 * The `enigma config` call that puts the resolved gate mode on the machine.
 *
 * The gate is a first-class field here and a plain on/off to the CLI, so a mode
 * of `off` refuses it and every other mode asks for it. Emitted after the config
 * map so this setting, which has a screen of its own, wins over a stale key
 * somebody left in the escape hatch.
 */
export function enigmaGateArgv(settings: ResolvedEnigma): string[] {
    return ["config", "gate", settings.gate === "off" ? "off" : "on"];
}

/** Whether a gate mode is one this build knows. A stored column is not a type,
 *  and a newer Polaris could have written one this one has never heard of. */
export function isEnigmaGateMode(value: string): value is AgentGateMode {
    return (AGENT_GATE_MODES as readonly string[]).includes(value);
}

/**
 * Read a stored settings column back.
 *
 * Anything unrecognised becomes null - inherit - rather than a default, because a
 * value this build cannot read is a question it has no business answering on the
 * operator's behalf.
 */
export function parseEnigmaSettings(raw: string | null | undefined): EnigmaSettings {
    if (!raw) return INHERIT_ENIGMA;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return INHERIT_ENIGMA;
    }
    if (!parsed || typeof parsed !== "object") return INHERIT_ENIGMA;
    const record = parsed as Record<string, unknown>;
    const config: Record<string, string> = {};
    if (record.config && typeof record.config === "object") {
        for (const [key, value] of Object.entries(record.config as Record<string, unknown>)) {
            if (typeof value === "string") config[key] = value;
        }
    }
    return {
        enabled: typeof record.enabled === "boolean" ? record.enabled : null,
        scope:
            typeof record.scope === "string" && (ENIGMA_SCOPES as readonly string[]).includes(record.scope)
                ? (record.scope as EnigmaScope)
                : null,
        gate: typeof record.gate === "string" && isEnigmaGateMode(record.gate) ? record.gate : null,
        version: typeof record.version === "string" && record.version.trim() ? record.version.trim() : null,
        config: Object.keys(config).length > 0 ? config : null
    };
}
