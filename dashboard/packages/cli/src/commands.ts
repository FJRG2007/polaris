/**
 * Every command, as `plr <noun> <verb>`.
 *
 * The same shape as `gh pr list` or `fly apps list`: the first word names the
 * thing acted on, the second what is done to it. Commands for a new Polaris app
 * go under a noun of their own, so they cannot collide with another app's - and
 * `test/commands/registry.test.ts` refuses a noun, verb or alias used twice.
 *
 * A command's code is loaded only when that command runs (`import()` inside
 * `run`). The bundle is still one file - esbuild inlines each module behind a
 * lazy initializer - but `plr --help` or `plr env list` no longer evaluates the
 * modules every other command needs.
 *
 * The names before this layout (`plr projects`, `plr build-log`, ...) still work:
 * they are hidden aliases that print one line on stderr naming the new command,
 * so a script that uses them keeps running and its output is unchanged.
 */

import type { Flags } from "./args.js";
import type { Context } from "./context.js";

export type Handler = (context: Context, flags: Flags, args: readonly string[]) => Promise<void>;

export interface Command {
    readonly verb: string;
    /** What follows the verb in the help, e.g. "SERVICE [--follow]". */
    readonly usage?: string;
    readonly summary: string;
    /** Shorter names for the verb, listed in the help and never deprecated. */
    readonly aliases?: readonly string[];
    readonly run: Handler;
}

export interface Group {
    readonly noun: string;
    readonly title: string;
    readonly commands: readonly Command[];
    /** The verb `plr <noun>` alone runs; without one it prints the group's help. */
    readonly defaultVerb?: string;
}

const auth = () => import("./commands/auth.js");
const deploy = () => import("./commands/deploy.js");
const install = () => import("./commands/install.js");

export const GROUPS: readonly Group[] = [
    {
        noun: "auth",
        title: "Signing in",
        commands: [
            {
                verb: "login",
                usage: "[--url URL] [--profile NAME] [--browserless]",
                summary: "Sign in from your browser, or with a code on another device",
                run: async (context, flags) => (await auth()).login(context, flags)
            },
            {
                verb: "logout",
                summary: "Sign out and revoke this computer's key",
                run: async (context, flags) => (await auth()).logout(context, flags)
            },
            {
                verb: "whoami",
                summary: "Who you are signed in as, and what you may do",
                run: async (context, flags) => (await auth()).whoami(context, flags)
            },
            {
                verb: "status",
                summary: "CLI version, Polaris, sign-in, and whether an update is out",
                run: async (context, flags) =>
                    (await import("./commands/status.js")).status(context, flags)
            }
        ]
    },
    {
        noun: "profile",
        title: "Profiles (one per Polaris or account)",
        defaultVerb: "list",
        commands: ["list", "use", "remove"].map((verb) => ({
            verb,
            usage: verb === "list" ? undefined : "NAME",
            summary: {
                list: "Every profile, and which is in use",
                use: "Switch to another profile",
                remove: "Sign a profile out and remove it"
            }[verb]!,
            run: async (context: Context, flags: Flags, args: readonly string[]) =>
                (await import("./commands/profile.js")).profile(context, flags, [verb, ...args])
        }))
    },
    {
        noun: "project",
        title: "Projects",
        commands: [
            {
                verb: "list",
                aliases: ["ls"],
                summary: "Every service you can reach",
                run: async (context, flags) => (await deploy()).projects(context, flags)
            }
        ]
    },
    {
        noun: "service",
        title: "Services",
        commands: [
            {
                verb: "view",
                usage: "SERVICE",
                summary: "Status, source and domains",
                run: async (context, flags, [ref]) => (await deploy()).service(context, flags, ref)
            },
            {
                verb: "deploy",
                usage: "SERVICE [--follow]",
                summary: "Deploy it again, and watch the build",
                run: async (context, flags, [ref]) => (await deploy()).deploy(context, flags, ref)
            },
            {
                verb: "logs",
                usage: "SERVICE [--follow] [--tail N]",
                summary: "Its runtime log",
                run: async (context, flags, [ref]) => (await deploy()).logs(context, flags, ref)
            },
            {
                verb: "restart",
                usage: "SERVICE",
                summary: "Restart it",
                run: async (context, flags, [ref]) => (await deploy()).restart(context, flags, ref)
            }
        ]
    },
    {
        noun: "deployment",
        title: "Deployments",
        commands: [
            {
                verb: "list",
                aliases: ["ls"],
                usage: "SERVICE",
                summary: "Recent deployments",
                run: async (context, flags, [ref]) =>
                    (await deploy()).deployments(context, flags, ref)
            },
            {
                verb: "logs",
                usage: "DEPLOYMENT [--follow] [--tail N]",
                summary: "Its build log",
                run: async (context, flags, [id]) => (await deploy()).buildLog(context, flags, id)
            }
        ]
    },
    {
        noun: "env",
        title: "Environment variables (values are never shown)",
        commands: (
            [
                ["list", "ls", "SERVICE", "Names, whether each is secret, and when it changed"],
                [
                    "set",
                    undefined,
                    "SERVICE NAME [--from-file PATH] [--plain] [--restart]",
                    "Create or replace one; type the value at a hidden prompt or pipe it in, never on the command line"
                ],
                [
                    "remove",
                    "rm",
                    "SERVICE NAME [--yes] [--restart]",
                    "Remove one. --restart redeploys so the change applies"
                ]
            ] as const
        ).map(([verb, alias, usage, summary]) => ({
            verb,
            aliases: alias ? [alias] : undefined,
            usage,
            summary,
            run: async (context: Context, flags: Flags, args: readonly string[]) =>
                (await import("./commands/env.js")).env(context, flags, [verb, ...args])
        }))
    },
    {
        noun: "dashboard",
        title: "Dashboard",
        commands: [
            {
                verb: "open",
                usage: "[home|deploy|keys|downloads]",
                summary: "Open the dashboard in your browser",
                run: async (context, flags, [page]) =>
                    (await import("./commands/open.js")).open(context, flags, page)
            }
        ]
    },
    {
        noun: "cli",
        title: "This CLI",
        commands: [
            {
                verb: "update",
                usage: "[--url URL]",
                summary: "Get the newest CLI, or the one a Polaris serves",
                run: async (context, flags) => (await install()).update(context, flags)
            },
            {
                verb: "uninstall",
                usage: "[--yes]",
                summary: "Sign out everywhere and remove the CLI",
                run: async (context, flags) => (await install()).uninstall(context, flags)
            }
        ]
    }
];

/** Where an older or shorter name leads: a noun, or a noun and its verb. */
type Target = readonly [noun: string, verb?: string];

/**
 * Top-level names that are not deprecated. Every Polaris dashboard and both
 * installers print `plr login`, and a CLI already installed knows no other name
 * for it, so these two stay first-class.
 */
export const SHORTCUTS: Readonly<Record<string, Target>> = {
    login: ["auth", "login"],
    logout: ["auth", "logout"]
};

/** The names before `plr <noun> <verb>`. Hidden from the help; they keep working. */
export const DEPRECATED: Readonly<Record<string, Target>> = {
    whoami: ["auth", "whoami"],
    status: ["auth", "status"],
    profiles: ["profile"],
    projects: ["project", "list"],
    deployments: ["deployment", "list"],
    deploy: ["service", "deploy"],
    redeploy: ["service", "deploy"],
    "build-log": ["deployment", "logs"],
    logs: ["service", "logs"],
    restart: ["service", "restart"],
    open: ["dashboard", "open"],
    update: ["cli", "update"],
    uninstall: ["cli", "uninstall"]
};

/**
 * `plr service SERVICE` showed a service before `plr service view` existed. A
 * second word that is not one of the group's verbs is read that way.
 */
const LEGACY_VERB: Readonly<Record<string, string>> = { service: "view" };

export type Resolved =
    | { readonly kind: "help"; readonly group?: Group }
    | {
          readonly kind: "run";
          readonly group: Group;
          readonly command: Command;
          readonly args: readonly string[];
          /** Set when an old name was used: the line to print on stderr. */
          readonly notice?: string;
      }
    | { readonly kind: "unknown"; readonly message: string };

const byNoun = new Map(GROUPS.map((group) => [group.noun, group]));

function find(group: Group, verb: string | undefined): Command | undefined {
    if (verb === undefined) return undefined;
    return group.commands.find(
        (command) => command.verb === verb || command.aliases?.includes(verb)
    );
}

function notice(old: string, now: string): string {
    return `plr: "plr ${old}" is now "plr ${now}"; the old name keeps working.\n`;
}

/** Which command a line of words names. Pure, so a test can walk every name. */
export function resolve(words: readonly string[], env: NodeJS.ProcessEnv = {}): Resolved {
    const [first = "help", ...rest] = words;
    if (first === "help") return { kind: "help", group: rest[0] ? groupFor(rest[0]) : undefined };

    const shortcut = SHORTCUTS[first];
    if (shortcut) return resolveTarget(shortcut, rest);

    const old = DEPRECATED[first];
    if (old) {
        const resolved = resolveTarget(old, rest);
        if (resolved.kind !== "run") return resolved;
        const now = old[1] ? `${old[0]} ${old[1]}` : old[0];
        return { ...resolved, notice: notice(first, now) };
    }

    const group = byNoun.get(first);
    if (!group) return { kind: "unknown", message: `"${first}" is not a plr command.` };

    const [verb, ...args] = rest;
    const command = find(group, verb);
    if (command) return { kind: "run", group, command, args };

    const legacy = LEGACY_VERB[group.noun];
    if (legacy && (verb !== undefined || env.POLARIS_SERVICE)) {
        return {
            kind: "run",
            group,
            command: find(group, legacy)!,
            args: rest,
            notice: notice(`${group.noun} SERVICE`, `${group.noun} ${legacy} SERVICE`)
        };
    }
    if (verb === undefined) {
        const fallback = find(group, group.defaultVerb);
        return fallback ? { kind: "run", group, command: fallback, args } : { kind: "help", group };
    }
    return {
        kind: "unknown",
        message: `"plr ${group.noun} ${verb}" is not a command; plr ${group.noun} lists them.`
    };
}

function resolveTarget([noun, verb]: Target, rest: readonly string[]): Resolved {
    return resolve(verb ? [noun, verb, ...rest] : [noun, ...rest]);
}

/** The group a word names, through the old and short names too. */
export function groupFor(word: string): Group | undefined {
    const target = SHORTCUTS[word] ?? DEPRECATED[word];
    return byNoun.get(target ? target[0] : word);
}

const COLUMN = 25;
const WIDTH = 80;

/** Words into lines of at most `width` characters. */
function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(" ")) {
        if (current && current.length + 1 + word.length > width) {
            lines.push(current);
            current = word;
        } else current = current ? `${current} ${word}` : word;
    }
    return [...lines, current];
}

function helpLines(group: Group): string[] {
    const lines = [`${group.title}`];
    for (const command of group.commands) {
        const verbs = [command.verb, ...(command.aliases ?? [])].join("|");
        const left = `  plr ${group.noun} ${verbs}${command.usage ? ` ${command.usage}` : ""}`;
        const summary = wrap(command.summary, WIDTH - COLUMN);
        if (left.length < COLUMN - 1) lines.push(`${left.padEnd(COLUMN)}${summary.shift()}`);
        else lines.push(left);
        lines.push(...summary.map((part) => `${" ".repeat(COLUMN)}${part}`));
    }
    return lines;
}

const FOOTER = `SERVICE is project/service, project/environment/service, or its id.
--json prints read commands as JSON. --profile (or POLARIS_PROFILE) picks a
profile for one command. POLARIS_TOKEN with POLARIS_URL uses an API key instead
of a sign-in, for CI.
`;

/** The help, grouped by noun; one group's alone when `group` is given. */
export function helpText(group?: Group): string {
    if (group) return `${helpLines(group).join("\n")}\n\n${FOOTER}`;
    const sections = GROUPS.map((each) => helpLines(each).join("\n"));
    return `plr - the Polaris command line (also installed as polaris)

Usage: plr <noun> <verb> [arguments] [flags]

${sections.join("\n\n")}

Shortcuts
  plr login              plr auth login
  plr logout             plr auth logout

${FOOTER}`;
}
