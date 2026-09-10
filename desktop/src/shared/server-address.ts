/**
 * The address of the Polaris this app opens, as typed on the first run.
 *
 * Shared by the form that asks for it and by the main process that stores it, so
 * the field says the same thing the store would refuse. One stored form: the
 * origin, `https://host[:port]`, lowercased, with the default port dropped and no
 * trailing slash - which is also what the navigation allowlist compares against.
 *
 * Only the address. A path, a query or a user name is refused rather than cut
 * off, because Polaris is always served from the root of its host and a pasted
 * `https://polaris.example.com/home` is better answered with the address to use
 * than silently rewritten.
 */

import { z } from "zod";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The text as it should be read: trimmed, and taken as https when no scheme was
 * typed. The schema below still decides whether the result is an address.
 */
export function normalizeServerInput(raw: string): string {
    const text = raw.trim();
    if (!text) return text;
    return SCHEME.test(text) ? text : `https://${text}`;
}

/** The address, or the sentence saying what is wrong with it. */
export const serverAddressSchema = z
    .string()
    .transform(normalizeServerInput)
    .transform((text, ctx) => {
        if (!text) {
            ctx.addIssue({ code: "custom", message: "Enter the address of your Polaris." });
            return z.NEVER;
        }
        let url: URL;
        try {
            url = new URL(text);
        } catch {
            ctx.addIssue({ code: "custom", message: "That is not an address. It looks like https://polaris.example.com." });
            return z.NEVER;
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            ctx.addIssue({ code: "custom", message: "The address starts with https:// (or http:// on your own network)." });
            return z.NEVER;
        }
        if (!url.hostname || /\s/.test(text)) {
            ctx.addIssue({ code: "custom", message: "That is not an address. It looks like https://polaris.example.com." });
            return z.NEVER;
        }
        if (url.username || url.password) {
            ctx.addIssue({ code: "custom", message: "Leave the user name and password out of the address." });
            return z.NEVER;
        }
        if (url.pathname !== "/" || url.search || url.hash) {
            ctx.addIssue({ code: "custom", message: `Only the address, without a path: ${url.origin}` });
            return z.NEVER;
        }
        return url.origin;
    });

export type ServerAddress = z.output<typeof serverAddressSchema>;

/** The stored address, or null when what was stored is no longer one. */
export function readServerAddress(value: unknown): string | null {
    const parsed = serverAddressSchema.safeParse(typeof value === "string" ? value : "");
    return parsed.success ? parsed.data : null;
}
