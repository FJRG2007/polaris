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
 * The version of Enigma every session and every runner run installs, unless a
 * tier pins another.
 *
 * One constant for both, so a session and the gate that checks its push work to
 * the same rules, and so anything read from the package - its skills catalogue -
 * can be cached once per version instead of once per request.
 */
export const ENIGMA_VERSION = "1.73.0";

/**
 * Enigma's own installer, read from the tag of the version above, and the hash
 * it has there.
 *
 * Releases from 1.73.0 on are published to GitHub only, not to npm, so this is
 * the install path rather than an alternative to one. The script is checked
 * against the hash before it runs: a tag can be moved, and whatever is at that
 * address runs on somebody else's machine. The script itself checks every file
 * it downloads against the release's SHA256SUMS.
 */
export const ENIGMA_INSTALLER_URL = `https://raw.githubusercontent.com/FJRG2007/enigma/v${ENIGMA_VERSION}/scripts/install.sh`;
export const ENIGMA_INSTALLER_SHA256 = "6d965c35d17e5217d77adeb0fcede23f7a2f4dab1ad61394dac48ee3151c176f";

/** A version the release installer can fetch. Anything else is an npm spec. */
const EXACT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** The first version with the host commands: `config set`, batched `skills
 *  disable` and `install --skip`. */
const HOST_CLI_SINCE = [1, 73, 0] as const;

/** A skill name as Enigma ships them, and as `enigma skills disable` takes it. */
export const ENIGMA_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** More skills switched off than the package has ever shipped. */
export const ENIGMA_SKILLS_OFF_MOST = 100;

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
    policies:
        "The skills and the operating contract. Faster to install, and enough to change how the work is done."
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
    /**
     * Enigma skills this tier switches off, by name. The nearest tier with a list
     * decides the whole list: a list is one answer, not several settings.
     */
    readonly skillsOff?: readonly string[] | null;
}

/** Nothing decided at this tier. */
export const INHERIT_ENIGMA: EnigmaSettings = {
    enabled: null,
    scope: null,
    gate: null,
    version: null,
    config: null,
    skillsOff: null
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
    config: {},
    skillsOff: []
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
export function resolveEnigma(
    ...tiers: readonly (EnigmaSettings | null | undefined)[]
): ResolvedEnigma {
    const present = tiers.filter((tier): tier is EnigmaSettings => Boolean(tier));
    const first = <K extends keyof EnigmaSettings>(
        key: K
    ): NonNullable<EnigmaSettings[K]> | null => {
        for (const tier of present) {
            const value = tier[key];
            if (value !== null && value !== undefined)
                return value as NonNullable<EnigmaSettings[K]>;
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
        config,
        skillsOff: first("skillsOff") ?? DEFAULT_ENIGMA.skillsOff
    };
}

/** The version a resolved setup installs, pinned or not. */
export function enigmaVersionOf(settings: ResolvedEnigma): string {
    return settings.version || ENIGMA_VERSION;
}

/** Whether a version spec names a release with the host commands. A spec that
 *  is not an exact version could resolve to anything, so it is treated as older. */
export function enigmaHasHostCli(version: string): boolean {
    if (!EXACT_VERSION.test(version)) return false;
    const parts = version.split(".").map(Number);
    for (const [i, since] of HOST_CLI_SINCE.entries()) {
        const part = parts[i] ?? 0;
        if (part !== since) return part > since;
    }
    return true;
}

/**
 * The `enigma install` arguments a resolved setup means.
 *
 * `--yes` is not optional and is not a setting: without it the CLI opens its
 * picker, and a picker in a session nobody is watching is a process that hangs
 * until something reaps it. `policies` is the skills, the memory file and the
 * approval bypass: the CLI dropped its `--policies` flag, so it is spelled as
 * the parts left out. `skip` names further parts for this run only, and is
 * dropped for a version that predates `--skip` rather than failing its install.
 */
export function enigmaInstallArgv(settings: ResolvedEnigma, skip: readonly string[] = []): string[] {
    const hostCli = enigmaHasHostCli(enigmaVersionOf(settings));
    const parts = settings.scope === "policies" ? ["commands", "dashboard", "statusline", "mcp", ...skip] : [...skip];
    const argv = ["install", "--all", "--yes"];
    if (settings.scope === "policies") argv.push("--no-hooks");
    if (hostCli && parts.length > 0) argv.push("--skip", [...new Set(parts)].join(","));
    return argv;
}

/** The npm spec a resolved setup names, pinned or not. One place, so an install
 *  and the config calls that follow it can never reach two different versions. */
export function enigmaPackageSpec(settings: ResolvedEnigma): string {
    return `enigma-cli@${enigmaVersionOf(settings)}`;
}

/**
 * Shell that installs one exact Enigma release from GitHub into the given
 * directories, and exits non-zero when it did not.
 *
 * `prefix` and `bin` are shell expressions this codebase writes (such as
 * `$HOME/.enigma/cli`), never operator input; `version` must be exact, which
 * the caller checks. Needs curl or wget, as the installer itself does.
 */
export function enigmaReleaseInstallScript(version: string, prefix: string, bin: string): string {
    if (!EXACT_VERSION.test(version)) throw new Error(`not an exact Enigma version: ${version}`);
    return [
        'f="$(mktemp)" || exit 1',
        `curl -fsSL --proto '=https' --proto-redir '=https' -o "$f" ${ENIGMA_INSTALLER_URL} 2>/dev/null || wget -q --https-only -O "$f" ${ENIGMA_INSTALLER_URL} || { rm -f "$f"; exit 1; }`,
        'sum="$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null) | cut -d" " -f1)"',
        `[ "$sum" = "${ENIGMA_INSTALLER_SHA256}" ] || { echo "polaris: Enigma's installer did not match its checksum"; rm -f "$f"; exit 1; }`,
        `ENIGMA_NO_SETUP=1 ENIGMA_INSTALL_VERSION=${version} ENIGMA_PREFIX="${prefix}" ENIGMA_BIN_DIR="${bin}" sh "$f"`,
        'rc=$?',
        'rm -f "$f"',
        "exit $rc"
    ].join("\n");
}

/**
 * The `enigma skills disable` calls a resolved setup means, one argv per skill.
 * A name that is not a plain skill name is dropped, for the same reason a config
 * key is: these become a command line on somebody else's machine.
 */
export function enigmaSkillsArgv(settings: ResolvedEnigma): string[][] {
    return [...new Set(settings.skillsOff)]
        .filter((name) => ENIGMA_SKILL_NAME.test(name))
        .slice(0, ENIGMA_SKILLS_OFF_MOST)
        .map((name) => ["skills", "disable", name]);
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
            typeof record.scope === "string" &&
            (ENIGMA_SCOPES as readonly string[]).includes(record.scope)
                ? (record.scope as EnigmaScope)
                : null,
        gate: typeof record.gate === "string" && isEnigmaGateMode(record.gate) ? record.gate : null,
        version:
            typeof record.version === "string" && record.version.trim()
                ? record.version.trim()
                : null,
        config: Object.keys(config).length > 0 ? config : null,
        skillsOff: Array.isArray(record.skillsOff)
            ? record.skillsOff
                  .filter((name): name is string => typeof name === "string" && ENIGMA_SKILL_NAME.test(name))
                  .slice(0, ENIGMA_SKILLS_OFF_MOST)
            : null
    };
}

/**
 * The whole of what putting Enigma on a machine means, as one shell script.
 *
 * Three things, and only the first was ever happening. `npx enigma-cli install`
 * downloads the package, runs its installer and throws the download away - so
 * the policies landed, `enigma` was not on the PATH afterwards, and the agent
 * that went looking for the command could not find it. And the `enigma config`
 * calls a resolved setup means were computed and never run at all, so an
 * account's gate mode and its own settings reached nothing.
 *
 * Installed globally rather than run through npx for exactly that reason: the
 * agent is meant to be able to invoke it, which is most of the point of putting
 * it there.
 *
 * Returns an empty string when Enigma is off, which is what the boot script
 * tests for. Every line is built from values this module owns - a version is a
 * package spec, and the config keys and values were filtered by
 * `enigmaConfigArgv` before they got here - so nothing an operator typed reaches
 * a shell unchecked.
 */
export function enigmaSetupScript(settings: ResolvedEnigma): string {
    if (!settings.enabled) return "";
    const spec = enigmaPackageSpec(settings);
    const pkg = spec.split("@")[0] || spec;
    // No `set -e`. Every line below is best effort on purpose: a session without
    // Enigma works to weaker standards, and one that died because a registry was
    // slow works to none - and this runs inside the window the session's terminal
    // IS, so a non-zero exit here closed it and took tmux with it.
    //
    // Two halves, and the split matters. Installing the PACKAGE is a global npm
    // install and needs root. Everything after it writes into a home directory -
    // the skills, the memory file, the commands, the trust and bypass settings -
    // and it has to be the home of whoever will actually run the agent. Doing it
    // all as root put ninety-three files in /root while the agent read
    // /home/node, so the session came up with none of them.
    //
    // `--allow-scripts` because the npm package's own postinstall is what puts
    // the command together, and npm declines to run it unasked: it says so in a
    // warning nobody reads and then leaves an `enigma` that is not there. Named,
    // so this allows one package's scripts and nothing else's.
    const npm = `npm install -g --allow-scripts=${pkg} ${spec} || npm install -g ${spec}`;
    const version = enigmaVersionOf(settings);
    const lines = EXACT_VERSION.test(version)
        ? [
              // The home is kept, so after the first session this is the whole
              // script - and a bumped version is what makes it install again.
              `[ "$(enigma --version 2>/dev/null)" = "${version}" ] && { echo "polaris: Enigma ${version} is installed"; exit 0; }`,
              `echo "polaris: installing Enigma ${version}"`,
              // Next to the npm prefix the home keeps, so it survives the session
              // and replaces the `enigma` an older npm install left there.
              'enigma_root="${NPM_CONFIG_PREFIX:-$HOME/.local}"',
              `( ${enigmaReleaseInstallScript(version, "$enigma_root/lib/enigma", "$enigma_root/bin").replace(/\n/g, "\n  ")} ) || ${npm} || true`,
              'PATH="$enigma_root/bin:$PATH"'
          ]
        : [`command -v enigma >/dev/null 2>&1 && exit 0`, `echo "polaris: installing Enigma (${spec})"`, `${npm} || true`];
    lines.push(
        'command -v enigma >/dev/null 2>&1 || { echo "polaris: Enigma did not install; this session runs without it"; exit 0; }'
    );
    return lines.join("\n");
}

/**
 * The half of Enigma's setup that belongs to whoever runs the agent.
 *
 * Everything that writes into a home directory: the skills, the memory file, the
 * commands, and the settings that pre-answer the trust prompt and turn the
 * approval prompts off. Run as the agent's own account rather than as root,
 * because that is whose home the agent will read.
 *
 * Empty when Enigma is off, which is what the boot script tests for.
 */
export function enigmaConfigureScript(settings: ResolvedEnigma): string {
    if (!settings.enabled) return "";
    const lines = [
        'PATH="${NPM_CONFIG_PREFIX:-$HOME/.local}/bin:$PATH"',
        'command -v enigma >/dev/null 2>&1 || exit 0',
        `enigma ${enigmaInstallArgv(settings).join(" ")} || echo "polaris: Enigma installed but its own setup did not finish"`
    ];
    const config = enigmaConfigArgv(settings).filter(([, key]) => key !== "gate");
    const skills = enigmaSkillsArgv(settings);
    const gate = enigmaGateArgv(settings);
    if (enigmaHasHostCli(enigmaVersionOf(settings))) {
        // One process for every setting, and one for every skill: each call
        // starts the CLI again, and a session waits for all of them. Both are
        // all or nothing, so a refused batch falls back to one call per value
        // and only the value the CLI refuses is lost.
        const pairs = [...config, gate].map(([, key, value]) => `${key}=${value}`);
        const single = [...config, gate].map((argv) => `enigma ${argv.join(" ")} || true`);
        lines.push(`enigma config set ${pairs.join(" ")} >/dev/null || { ${single.join("; ")}; }`);
        if (skills.length > 0) {
            const names = skills.map(([, , name]) => name);
            const each = skills.map((argv) => `enigma ${argv.join(" ")} || true`);
            lines.push(`enigma skills disable ${names.join(" ")} || { ${each.join("; ")}; }`);
        }
    } else {
        for (const argv of [...config, ...skills, gate]) lines.push(`enigma ${argv.join(" ")} || true`);
    }
    lines.push('echo "polaris: Enigma ready"');
    return lines.join("\n");
}
