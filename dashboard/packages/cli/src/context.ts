/**
 * Everything a command reaches outside itself, in one object.
 *
 * The real one is built by `main`; a test builds one with an in-memory terminal,
 * a stub `fetch` and a fake keychain, so a command can be run end to end without
 * a network, a browser or a real credential store.
 */

import { hostname } from "node:os";
import { CliError } from "./errors.js";
import { normalizeUrl, type Flags } from "./args.js";
import type { Connection, Fetch } from "./api.js";
import { readSecret } from "./secret-input.js";
import { secrets, type Secrets } from "./secrets.js";
import { createInterface } from "node:readline/promises";
import { canOpenBrowser, openBrowser } from "./browser.js";
import { timed } from "./timing.js";
import { configDir, currentHost, type Host } from "./paths.js";
import { loadConfig, profileNameSchema, type Profile } from "./config.js";

export interface Io {
    out(text: string): void;
    err(text: string): void;
    /** Whether a person is at the other end, to be asked things and shown progress. */
    readonly interactive: boolean;
}

export interface Context {
    readonly host: Host;
    readonly configDir: string;
    readonly secrets: Secrets;
    readonly fetch: Fetch;
    readonly io: Io;
    /** Open a page; false when there was no browser to open it in. */
    openBrowser(url: string): Promise<boolean>;
    canOpenBrowser(): boolean;
    sleep(ms: number): Promise<void>;
    /** Ask one question; null when nobody can answer it. */
    prompt(question: string): Promise<string | null>;
    /** A value that must not be seen: a prompt that does not echo, or stdin when
     *  something is piped in. Null when it was abandoned or too large. */
    readSecret(question: string): Promise<string | null>;
    machineName(): string;
}

/** The context of this process. */
export function processContext(): Context {
    const host = currentHost();
    const dir = configDir(host);
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    return {
        host,
        configDir: dir,
        secrets: secrets(host, dir),
        fetch,
        io: {
            out: (text) => void process.stdout.write(text),
            err: (text) => void process.stderr.write(text),
            interactive
        },
        openBrowser: (url) => openBrowser(host, url),
        canOpenBrowser: () => canOpenBrowser(host),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        async prompt(question) {
            if (!interactive) return null;
            const reader = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return (await reader.question(question)).trim();
            } finally {
                reader.close();
            }
        },
        readSecret,
        machineName: () => hostname()
    };
}

/** A signed-in connection, and the profile behind it (null when it came from
 *  POLARIS_TOKEN). */
export interface Session {
    readonly connection: Connection;
    readonly profileName: string | null;
    readonly profile: Profile | null;
}

/** Which profile a command means: --profile, then POLARIS_PROFILE, then the one
 *  `plr login` or `plr profile use` last chose. */
export function chosenProfileName(
    context: Context,
    flags: Flags,
    current: string | null
): string | null {
    const name = flags.profile ?? context.host.env.POLARIS_PROFILE ?? current;
    if (name === null || name === undefined) return null;
    const checked = profileNameSchema.safeParse(name);
    if (!checked.success)
        throw new CliError(`"${name}" is not a profile name. plr profile list shows yours.`, 2);
    return checked.data;
}

/**
 * The sign-in a command acts with.
 *
 * `POLARIS_TOKEN` (with `POLARIS_URL`) wins over every profile, the way a CI job
 * passes a key it was given; otherwise the chosen profile's token is read from
 * wherever `plr login` put it.
 */
export async function requireSession(context: Context, flags: Flags): Promise<Session> {
    const env = context.host.env;
    if (env.POLARIS_TOKEN) {
        const url = flags.url ?? env.POLARIS_URL;
        if (!url)
            throw new CliError(
                "POLARIS_TOKEN is set, so POLARIS_URL (or --url) has to say which Polaris it is for.",
                2
            );
        return {
            connection: { url: normalizeUrl(url), token: env.POLARIS_TOKEN },
            profileName: null,
            profile: null
        };
    }

    const config = await loadConfig(context.configDir);
    const name = chosenProfileName(context, flags, config.current);
    if (!name)
        throw new CliError("Not signed in. Run plr login --url https://your-polaris-address");
    const profile = config.profiles[name];
    if (!profile)
        throw new CliError(
            `There is no profile named "${name}". plr profile list shows yours; plr login adds one.`
        );
    const token = await timed(`sign-in read from the ${profile.storage}`, () =>
        context.secrets.read(name, profile.storage)
    );
    if (!token) {
        throw new CliError(
            `The sign-in for "${name}" is missing from the ${profile.storage === "keychain" ? "keychain" : "credentials file"}. Run plr login --profile ${name}.`
        );
    }
    return { connection: { url: profile.url, token }, profileName: name, profile };
}
