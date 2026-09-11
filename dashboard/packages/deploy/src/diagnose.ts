/**
 * Why a deploy failed, read from its log, and the one setting that fixes it.
 *
 * `deploy-failure.ts` translates what the runtime said about the machine - a full
 * disk, a registry that refused. This reads what the project itself printed: a
 * start script that does not exist, a Node version the framework refuses, a
 * variable the app reads at boot and nobody set. Each of those is one field on the
 * service, so each comes with the fix that changes that field; the screen offers
 * it as a button and redeploys.
 *
 * Only failures seen in the wild, each recognized by the words its tool prints,
 * and the first that matches wins - so the specific come before the general. A log
 * nothing here recognizes gets no diagnosis rather than a guess.
 *
 * Pure: a log in, a diagnosis out. The log is the deploy's own, so it can hold
 * anything a build printed; only the matching line is ever returned.
 */

/** What to change. A fix that needs a value the log cannot supply has a
 *  suggestion of null, and the screen asks for it. */
export type DeployFix =
    | { readonly kind: "set-port"; readonly port: number }
    | { readonly kind: "set-start-command"; readonly suggestion: string | null }
    | { readonly kind: "set-build-command"; readonly suggestion: string | null }
    | { readonly kind: "set-root-directory"; readonly suggestion: string | null }
    | { readonly kind: "set-runtime-version"; readonly version: string }
    | { readonly kind: "add-variable"; readonly name: string; readonly value: string | null; readonly generate: boolean }
    | { readonly kind: "use-detected-build" };

export interface Diagnosis {
    /** A stable name for the cause, for the audit trail and the tests. */
    readonly cause: string;
    /** One line, what went wrong. */
    readonly title: string;
    /** What to do about it, when the fix is not the whole answer. */
    readonly detail: string;
    /** The line of the log that says so. */
    readonly evidence: string;
    readonly fix: DeployFix | null;
}

/** What the diagnosis may compare against. */
export interface DiagnoseContext {
    /** The port the service is published on, which the app has to listen on. */
    readonly port?: number | null;
}

/** The longest evidence line kept, so a minified bundle in an error does not
 *  become the screen. */
const EVIDENCE_LIMIT = 240;

/** Remove terminal colour codes, which builds print and screens should not. */
function plain(log: string): string {
    // eslint-disable-next-line no-control-regex
    return log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** The whole line a match sits on, trimmed and bounded. */
function lineOf(log: string, index: number): string {
    const start = log.lastIndexOf("\n", index) + 1;
    const end = log.indexOf("\n", index);
    const line = log.slice(start, end < 0 ? undefined : end).trim();
    return line.length > EVIDENCE_LIMIT ? `${line.slice(0, EVIDENCE_LIMIT - 3)}...` : line;
}

/** The highest major version a requirement names, bounded to the Node lines an
 *  image is published for. `^18.18.0 || ^19.8.0 || >= 20.0.0` is 20. */
function nodeMajorFor(requirement: string): string | null {
    const majors = [...requirement.matchAll(/(\d+)(?:\.\d+)*/g)].map((match) => Number(match[1])).filter((major) => major >= 14 && major <= 30);
    if (majors.length === 0) return null;
    const highest = Math.max(...majors);
    return String(Math.max(18, highest));
}

/** The lowest `major.minor` a Python requirement accepts: `>=3.11` is 3.11. */
function pythonMinimum(requirement: string): string | null {
    return /(\d+\.\d+)/.exec(requirement)?.[1] ?? null;
}

interface Rule {
    readonly cause: string;
    readonly pattern: RegExp;
    readonly diagnose: (match: RegExpExecArray, context: DiagnoseContext, log: string) => Omit<Diagnosis, "cause" | "evidence"> | null;
}

/** A variable the app refused to start without, by name. */
function missingVariable(name: string, why?: string): Omit<Diagnosis, "cause" | "evidence"> {
    return {
        title: `The app needs ${name} and it is not set`,
        detail: why ?? `Add ${name} under Variables with the value it expects.`,
        fix: { kind: "add-variable", name, value: null, generate: false }
    };
}

/** A secret the framework refuses to boot without; a random one is exactly right. */
function missingSecret(name: string, framework: string): Omit<Diagnosis, "cause" | "evidence"> {
    return {
        title: `${framework} needs ${name} to start`,
        detail: "A random value works. Polaris can generate one and keep it as a secret.",
        fix: { kind: "add-variable", name, value: null, generate: true }
    };
}

/** In order: the first that matches anywhere in the log wins. */
const RULES: readonly Rule[] = [
    {
        cause: "heap-out-of-memory",
        pattern: /JavaScript heap out of memory|Reached heap limit Allocation failed|Allocation failed - JavaScript heap/,
        diagnose: () => ({
            title: "The build ran out of JavaScript memory",
            detail: "Node's default heap is too small for this build. Raising it with NODE_OPTIONS usually lets it finish.",
            fix: { kind: "add-variable", name: "NODE_OPTIONS", value: "--max-old-space-size=4096", generate: false }
        })
    },
    {
        cause: "killed-out-of-memory",
        pattern: /\bOOMKilled\b|exit code:? 137\b|exited with code 137\b|signal: killed/i,
        diagnose: () => ({
            title: "The machine ran out of memory",
            detail: "The process was killed for using more memory than the machine could give it. Free some on that server, or deploy it to a larger one under Settings.",
            fix: null
        })
    },
    {
        // MongoDB's own refusal, word for word (SERVER-121912). Seen running
        // mongo:8 on a host with Linux 7.0 on 2026-09-11; mongo:7 starts there.
        cause: "mongo-kernel-incompatible",
        pattern: /MongoDB cannot start: Linux kernel versions 6\.19 and newer has a known incompatibility/,
        diagnose: () => ({
            title: "This MongoDB version cannot run on this server's Linux kernel",
            detail: "MongoDB 8 refuses to start on Linux 6.19 or newer (MongoDB issue SERVER-121912). Run MongoDB 7 on this server until MongoDB ships a fix, or use a server with an older kernel.",
            fix: null
        })
    },
    {
        cause: "missing-start-script",
        pattern: /Missing script:\s*"?start"?|No start command could be found|missing script: start/i,
        diagnose: () => ({
            title: "Nothing says how to start this app",
            detail: "Its package.json has no start script. Set the command that starts it.",
            fix: { kind: "set-start-command", suggestion: null }
        })
    },
    {
        cause: "missing-build-script",
        pattern: /Missing script:\s*"?build"?/i,
        diagnose: () => ({
            title: "The build command names a script that does not exist",
            detail: "Set the build command this project actually uses, or clear it if it needs none.",
            fix: { kind: "set-build-command", suggestion: null }
        })
    },
    {
        cause: "dockerfile-missing",
        pattern: /failed to (?:read|solve)[^\n]*dockerfile[^\n]*no such file|open [^\s]*Dockerfile[^\s]*: no such file|Cannot locate specified Dockerfile|unable to prepare context: unable to evaluate symlinks in Dockerfile path/i,
        diagnose: () => ({
            title: "There is no Dockerfile where the service looks for one",
            detail: "Point it at the right path, or let Polaris work out how to build the repository instead.",
            fix: { kind: "use-detected-build" }
        })
    },
    {
        cause: "wrong-root-directory",
        pattern: /ENOENT: no such file or directory, open '[^']*package\.json'|Could not read package\.json|unable to generate a build plan|Nixpacks was unable to generate a build plan/i,
        diagnose: () => ({
            title: "The build found no project where it looked",
            detail: "In a repository holding several apps, the root directory has to name the one to deploy.",
            fix: { kind: "set-root-directory", suggestion: null }
        })
    },
    {
        cause: "node-version",
        pattern:
            /The engine "node" is incompatible with this module\. Expected version "([^"]+)"|Unsupported engine[^\n]*required: \{[^}]*node: '([^']+)'|Node\.js version "?([^"\n]+?)"? is required|requires Node\.js (?:version )?([>=^~]+\s*\d[^\s,.]*)|upgrade Node\.js to a supported version: "([^"]+)"/i,
        diagnose: (match) => {
            const requirement = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
            const version = nodeMajorFor(requirement);
            return version
                ? {
                      title: `The project needs Node ${requirement.trim()}`,
                      detail: `Build it on Node ${version}.`,
                      fix: { kind: "set-runtime-version", version }
                  }
                : null;
        }
    },
    {
        cause: "python-version",
        pattern: /requires a different Python: [\d.]+ not in '([^']+)'|Requires-Python ([>=<~!^][^\s;]+)/,
        diagnose: (match) => {
            const version = pythonMinimum(match[1] ?? match[2] ?? "");
            return version
                ? {
                      title: `The project needs Python ${(match[1] ?? match[2] ?? "").trim()}`,
                      detail: `Build it on Python ${version}.`,
                      fix: { kind: "set-runtime-version", version }
                  }
                : null;
        }
    },
    {
        cause: "rails-secret",
        pattern: /Missing `secret_key_base`|secret_key_base.*(?:must|is) (?:be )?(?:set|missing)/i,
        diagnose: () => missingSecret("SECRET_KEY_BASE", "Rails")
    },
    {
        cause: "laravel-key",
        pattern: /No application encryption key has been specified/,
        diagnose: () => missingSecret("APP_KEY", "Laravel")
    },
    {
        cause: "django-secret",
        pattern: /The SECRET_KEY setting must not be empty/,
        diagnose: () => missingSecret("SECRET_KEY", "Django")
    },
    {
        cause: "missing-variable",
        pattern:
            /Environment variable not found: ([A-Z][A-Z0-9_]+)|Missing (?:required )?environment variables?:?\s*["'`]?([A-Z][A-Z0-9_]+)|KeyError: '([A-Z][A-Z0-9_]+)'|(?:environment variable|env var|process\.env\.)\s*["'`]?([A-Z][A-Z0-9_]{2,})["'`]? (?:is )?(?:not set|missing|undefined|required)/,
        diagnose: (match) => {
            const name = match[1] ?? match[2] ?? match[3] ?? match[4];
            return name ? missingVariable(name) : null;
        }
    },
    {
        cause: "command-not-found",
        pattern: /(?:^|\n)\s*(?:sh|bash|\/bin\/sh)(?:: \d+)?: ([A-Za-z0-9_.@/-]+): (?:command )?not found/,
        diagnose: (match) => ({
            title: `The build ran ${match[1]}, which is not installed`,
            detail: `Either ${match[1]} is missing from the project's dependencies, or the build command names a tool this project does not use.`,
            fix: { kind: "set-build-command", suggestion: null }
        })
    },
    {
        cause: "missing-module",
        pattern: /Error: Cannot find module '([^']+)'|ERR_MODULE_NOT_FOUND[^\n]*'([^']+)'|ModuleNotFoundError: No module named '([^']+)'/,
        diagnose: (match) => {
            const module = match[1] ?? match[2] ?? match[3] ?? "";
            // A path is the app's own build output; a name is a dependency.
            const builtFile = module.startsWith(".") || module.startsWith("/");
            return {
                title: builtFile ? `The app looked for ${module}, which the build did not produce` : `The app needs ${module}, which is not installed`,
                detail: builtFile
                    ? "The start command expects build output the build never wrote. Check the build command, or the start command's path."
                    : `Add ${module} to the project's dependencies - as a regular dependency, since development ones are not installed for production.`,
                fix: builtFile ? { kind: "set-start-command", suggestion: null } : null
            };
        }
    },
    {
        cause: "lockfile-mismatch",
        pattern: /ERR_PNPM_OUTDATED_LOCKFILE|`npm ci` can only install packages when your package\.json and package-lock\.json|The lockfile would have been modified by this install|Your lockfile needs to be updated/,
        diagnose: (_match, _context, log) =>
            // The install falls back to the manifest by itself; when it did, the
            // lockfile is not what stopped this deploy.
            log.includes("installing from the manifest instead")
                ? null
                : {
                      title: "The lockfile does not match package.json",
                      detail: "Run the install locally and commit the updated lockfile.",
                      fix: null
                  }
    },
    {
        cause: "listening-on-localhost",
        pattern: /(?:listening|running|started|serving|ready|server)[^\n]{0,40}?(?:on|at)\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?/i,
        diagnose: () => ({
            title: "The app only listens inside its own container",
            detail: "It bound to localhost, which nothing outside the container can reach. Setting HOST to 0.0.0.0 makes most frameworks listen everywhere.",
            fix: { kind: "add-variable", name: "HOST", value: "0.0.0.0", generate: false }
        })
    },
    {
        cause: "wrong-port",
        pattern: /(?:listening|running|started|serving|ready)[^\n]{0,40}?(?:port\s+|:)(\d{2,5})\b/i,
        diagnose: (match, context) => {
            const port = Number(match[1]);
            if (!context.port || !Number.isInteger(port) || port === context.port || port < 80 || port > 65535) return null;
            return {
                title: `The app listens on ${port}, not ${context.port}`,
                detail: `Polaris sends its traffic to ${context.port}. Use ${port} instead.`,
                fix: { kind: "set-port", port }
            };
        }
    }
];

/** Read a failed deploy's log for a cause, or null when nothing here knows it. */
export function diagnoseDeploy(log: string, context: DiagnoseContext = {}): Diagnosis | null {
    const text = plain(log);
    for (const rule of RULES) {
        const match = rule.pattern.exec(text);
        if (!match) continue;
        const found = rule.diagnose(match, context, text);
        if (found) return { cause: rule.cause, evidence: lineOf(text, match.index + (match[0].startsWith("\n") ? 1 : 0)), ...found };
    }
    return null;
}
