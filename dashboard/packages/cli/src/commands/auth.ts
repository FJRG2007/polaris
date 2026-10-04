/**
 * Signing in and out, and saying who you are: `login`, `logout`, `whoami`.
 *
 * `login` is the device-authorization grant (RFC 8628) the way Railway's CLI
 * runs it: it opens the approval page in the browser with the code already in
 * it, and falls back to printing the address and the code - to type on any
 * device - when there is no browser here or `--browserless` says not to try.
 */

import { CLI_VERSION } from "../version.js";
import { CliError, usage } from "../errors.js";
import { line, printJson } from "../output.js";
import { normalizeUrl, type Flags } from "../args.js";
import { call, send, type Connection } from "../api.js";
import { authorizeSchema, claimSchema, meSchema } from "../schemas.js";
import { chosenProfileName, requireSession, type Context } from "../context.js";
import {
    loadConfig,
    profileNameFor,
    profileNameSchema,
    saveConfig,
    type Config
} from "../config.js";

/** What `plr login` asks to be allowed. Everything the commands use, and no more. */
export const LOGIN_SCOPES = ["deploy.read", "deploy.manage"] as const;

/** Consecutive failed polls tolerated before giving up: a Wi-Fi blip while
 *  somebody is approving must not throw the whole sign-in away. */
const POLL_FAILURES = 3;

/** The code as it is shown: two groups of four. */
export function formatCode(code: string): string {
    return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Whether an http:// address is on this machine or the local network, where
 *  plain HTTP is the default install and not worth a warning. */
function isLocal(url: string): boolean {
    const host = new URL(url).hostname;
    return (
        host === "localhost" ||
        host.endsWith(".local") ||
        host === "polaris" ||
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
        host === "[::1]"
    );
}

/** The address to sign in to: --url, the chosen profile's, or asked for. */
async function loginUrl(context: Context, flags: Flags, config: Config): Promise<string> {
    if (flags.url) return normalizeUrl(flags.url);
    const name = chosenProfileName(context, flags, config.current);
    const known = name ? config.profiles[name] : undefined;
    if (known) return known.url;
    const typed = await context.prompt("Polaris address (the one you open it at): ");
    if (!typed)
        throw usage("Name the Polaris to sign in to: plr login --url https://polaris.example.com");
    return normalizeUrl(typed);
}

/** End a token's sign-in on the server. Best-effort: what it says is returned
 *  for the caller to report. */
async function revokeRemotely(
    context: Context,
    connection: Connection
): Promise<"revoked" | "gone" | "kept" | "unreachable"> {
    try {
        const response = await send(connection, "DELETE", "/api/cli/session", {
            fetch: context.fetch,
            timeoutMs: 15_000
        });
        if (response.status === 204) return "revoked";
        if (response.status === 401) return "gone";
        return "kept";
    } catch {
        return "unreachable";
    }
}

export async function login(context: Context, flags: Flags): Promise<void> {
    const config = await loadConfig(context.configDir);
    const url = await loginUrl(context, flags, config);
    const existing = Object.entries(config.profiles).find(
        ([, profile]) => profile.url === url
    )?.[0];
    const name = profileNameSchema.parse(flags.profile ?? existing ?? profileNameFor(url));

    if (new URL(url).protocol === "http:" && !isLocal(url)) {
        context.io.err(
            `Warning: ${url} is not encrypted, so this sign-in travels in the clear. Use https:// where you can.\n`
        );
    }

    const anonymous: Connection = { url, token: null };
    const opened = await call(anonymous, "POST", "/api/cli/authorize", authorizeSchema, {
        fetch: context.fetch,
        body: {
            deviceName: (context.machineName() || "Unknown computer").slice(0, 80),
            clientVersion: CLI_VERSION,
            scopes: LOGIN_SCOPES
        }
    });

    const approveUrl = `${url}${opened.approvePath}`;
    const code = formatCode(opened.userCode);
    const browser =
        !flags.browserless && context.canOpenBrowser() && (await context.openBrowser(approveUrl));
    if (browser) {
        line(context.io, `Opened ${approveUrl} in your browser.`);
        line(context.io, `Check that it shows the code ${code}, then approve it there.`);
    } else {
        line(context.io, `On any device, open ${url}${opened.verificationPath}`);
        line(context.io, `and type the code ${code}`);
    }
    line(context.io, "Waiting for the approval... (Ctrl+C to stop)");

    const deadline = new Date(opened.expiresAt).getTime();
    let failures = 0;
    for (;;) {
        await context.sleep(opened.pollMs);
        if (Date.now() > deadline + opened.pollMs) {
            throw new CliError(
                "The code expired before it was approved. Run plr login again for a new one."
            );
        }
        let claim;
        try {
            claim = await call(anonymous, "POST", "/api/cli/authorize/claim", claimSchema, {
                fetch: context.fetch,
                body: { deviceCode: opened.deviceCode }
            });
            failures = 0;
        } catch (caught) {
            failures += 1;
            if (failures >= POLL_FAILURES) throw caught;
            continue;
        }
        if (claim.status === "pending") continue;
        if (claim.status === "denied")
            throw new CliError("The sign-in was turned away. Nothing was saved.");
        if (claim.status === "expired") {
            throw new CliError(
                "The code expired before it was approved. Run plr login again for a new one."
            );
        }

        // Signing a profile in again replaces its key, so the old one is ended
        // rather than left working on a machine that no longer uses it.
        const previous = config.profiles[name];
        if (previous) {
            const oldToken = await context.secrets.read(name, previous.storage);
            if (oldToken) await revokeRemotely(context, { url: previous.url, token: oldToken });
        }

        const storage = await context.secrets.save(name, claim.token);
        const next: Config = {
            current: name,
            profiles: {
                ...config.profiles,
                [name]: {
                    url,
                    account: claim.account,
                    keyId: claim.keyId,
                    scopes: claim.scopes,
                    storage,
                    signedInAt: new Date().toISOString()
                }
            }
        };
        await saveConfig(context.configDir, next);

        const who = claim.account.name
            ? `${claim.account.name} <${claim.account.email}>`
            : claim.account.email;
        line(context.io, `Signed in to ${url} as ${who} (profile ${name}).`);
        line(
            context.io,
            storage === "keychain"
                ? "The token is in this computer's keychain."
                : `There is no keychain here, so the token is in ${context.configDir} (readable only by you).`
        );
        return;
    }
}

export async function logout(context: Context, flags: Flags): Promise<void> {
    if (context.host.env.POLARIS_TOKEN) {
        throw new CliError(
            "POLARIS_TOKEN is set, and logout signs out a profile. Unset it; to stop that key working, revoke it under API keys."
        );
    }
    const config = await loadConfig(context.configDir);
    const name = chosenProfileName(context, flags, config.current);
    if (!name) throw new CliError("Not signed in, so there is nothing to sign out of.");
    const profile = config.profiles[name];
    if (!profile) {
        throw new CliError(`There is no profile named "${name}". plr profile list shows yours.`);
    }

    // A profile whose token has gone missing (a keychain reset, a deleted
    // file) is still removed: it is exactly the one somebody wants gone.
    const token = await context.secrets.read(name, profile.storage);
    const outcome = token ? await revokeRemotely(context, { url: profile.url, token }) : "missing";
    await context.secrets.forget(name);

    const { [name]: _removed, ...rest } = config.profiles;
    const current = config.current === name ? (Object.keys(rest)[0] ?? null) : config.current;
    await saveConfig(context.configDir, { current, profiles: rest });

    if (outcome === "revoked" || outcome === "gone") {
        line(context.io, `Signed out of ${profile.url} (profile ${name}).`);
    } else if (outcome === "kept") {
        line(
            context.io,
            `Removed profile ${name} from this computer. Its key was not a CLI sign-in, so it still works; revoke it under API keys.`
        );
    } else if (outcome === "missing") {
        line(
            context.io,
            `Removed profile ${name} from this computer. Its token was no longer here to revoke; revoke the key under API keys on ${profile.url}.`
        );
    } else {
        line(
            context.io,
            `Removed profile ${name} from this computer, but ${profile.url} could not be reached to revoke its key. It keeps working until you revoke it under API keys.`
        );
    }
    if (current && current !== name) line(context.io, `Now using profile ${current}.`);
}

export async function whoami(context: Context, flags: Flags): Promise<void> {
    const session = await requireSession(context, flags);
    const me = await call(session.connection, "GET", "/api/v1/me", meSchema, {
        fetch: context.fetch
    });
    if (flags.json) {
        printJson(context.io, { url: session.connection.url, profile: session.profileName, ...me });
        return;
    }
    const who = me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email;
    line(context.io, who);
    line(context.io, `Polaris: ${session.connection.url}`);
    if (session.profileName) line(context.io, `Profile: ${session.profileName}`);
    line(
        context.io,
        `Allowed to: ${me.key.scopes.length ? me.key.scopes.join(", ") : "nothing (ask an administrator for Deploy access)"}`
    );
}
