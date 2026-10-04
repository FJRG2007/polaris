/**
 * Reading the command line.
 *
 * Node's own `parseArgs`, strict: an option nobody defined is an error naming
 * it, not something silently ignored - `plr deploy web --folow` should not
 * deploy without following. Every option is global; a command reads the ones
 * that mean something to it.
 */

import { usage } from "./errors.js";
import { parseArgs } from "node:util";

export interface Flags {
    readonly json: boolean;
    readonly follow: boolean;
    readonly browserless: boolean;
    readonly help: boolean;
    readonly version: boolean;
    /** Answers yes to the one question the CLI asks (`plr uninstall`). */
    readonly yes: boolean;
    readonly url?: string;
    readonly profile?: string;
    readonly tail?: number;
}

export interface Parsed {
    /** The command and its arguments, e.g. ["logs", "shop/web"]. */
    readonly positionals: readonly string[];
    readonly flags: Flags;
}

const OPTIONS = {
    json: { type: "boolean" },
    follow: { type: "boolean", short: "f" },
    browserless: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    yes: { type: "boolean", short: "y" },
    url: { type: "string" },
    profile: { type: "string", short: "p" },
    tail: { type: "string", short: "n" }
} as const;

/** The largest tail the server accepts. */
export const MAX_TAIL = 5000;

export function parse(argv: readonly string[]): Parsed {
    let values: Record<string, string | boolean | undefined>;
    let positionals: string[];
    try {
        ({ values, positionals } = parseArgs({
            args: [...argv],
            options: OPTIONS,
            allowPositionals: true,
            strict: true
        }));
    } catch (caught) {
        throw usage(
            caught instanceof Error ? caught.message : "That option is not one this CLI knows."
        );
    }

    let tail: number | undefined;
    if (typeof values.tail === "string") {
        tail = Number(values.tail);
        if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
            throw usage(`--tail takes a whole number from 1 to ${MAX_TAIL}.`);
        }
    }
    for (const name of ["url", "profile"] as const) {
        if (values[name] === "") throw usage(`--${name} needs a value.`);
    }

    return {
        positionals,
        flags: {
            json: values.json === true,
            follow: values.follow === true,
            browserless: values.browserless === true,
            help: values.help === true,
            version: values.version === true,
            yes: values.yes === true,
            url: typeof values.url === "string" ? values.url : undefined,
            profile: typeof values.profile === "string" ? values.profile : undefined,
            tail
        }
    };
}

/**
 * A Polaris address as typed, made into the one form it is stored in: an
 * origin with no trailing slash. `polaris.example.com` gets https:// in front;
 * anything that is not http(s), or carries a path, query or credentials, is
 * refused rather than guessed at.
 */
export function normalizeUrl(typed: string): string {
    const trimmed = typed.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        throw usage(
            `"${typed}" is not an address. Use the one you open Polaris at, e.g. https://polaris.example.com`
        );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        throw usage("The address must start with https:// (or http:// on a network you trust).");
    if (url.username || url.password)
        throw usage("Leave the user name and password out of the address; plr login signs you in.");
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
        throw usage(`Use the address Polaris answers at, without a path: ${url.origin}`);
    }
    return url.origin;
}
