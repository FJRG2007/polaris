/**
 * Which instance a subscription login is made against, when it is not the
 * vendor's public one: a self-managed GitLab (its address and the OAuth
 * application registered on it), or a GitHub Enterprise domain for Copilot.
 *
 * Pure and free of Node imports, so the sign-in dialog checks a value as it is
 * typed with the same rules the server applies before it calls anything.
 */

import { z } from "zod";

/** The longest instance address taken. */
const ADDRESS_MOST = 512;

/**
 * A GitLab address in the one form it is stored and called in: `https://`,
 * no credentials, query or fragment, and the path kept (an instance served
 * under a relative root, `/gitlab`) without a trailing slash. An address typed
 * without a scheme is taken as `https://`. Null for anything else, a plain
 * `http://` included: the token is sent there.
 */
export function gitlabInstanceUrl(input: string): string | null {
    const text = input.trim();
    if (!text || text.length > ADDRESS_MOST) return null;
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!url.hostname.includes(".")) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A GitLab OAuth application's ID, as its Applications page shows it. */
export const GITLAB_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const gitlabInstanceSchema = z.object({
    url: z
        .string()
        .max(ADDRESS_MOST)
        .transform((value, context) => {
            const url = gitlabInstanceUrl(value);
            if (!url) {
                context.addIssue({ code: "custom", message: "gitlab.url" });
                return z.NEVER;
            }
            return url;
        }),
    clientId: z.string().trim().regex(GITLAB_CLIENT_ID_PATTERN, "gitlab.clientId")
});

/** A self-managed GitLab a login is made against. */
export type GitlabInstance = z.output<typeof gitlabInstanceSchema>;

/** The longest domain name DNS allows. */
const DOMAIN_MOST = 253;

/**
 * A GitHub Enterprise domain (`company.ghe.com`, or a GitHub Enterprise Server
 * host) in the one form it is kept in: the lowercase host alone, typed with or
 * without `https://` and a trailing slash, as OpenCode's `normalizeDomain`
 * takes it. Its API and Copilot API are the `api.` and `copilot-api.` hosts
 * beside it, so a port, a path or anything after the host is refused, and so is
 * github.com itself, which is the other choice. Null for anything else.
 */
export function copilotDomain(input: string): string | null {
    const text = input.trim();
    if (!text || text.length > DOMAIN_MOST + 8) return null;
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    if (url.username || url.password || url.port || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    const host = url.hostname;
    if (host.length > DOMAIN_MOST || !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")) return null;
    if (host === "github.com" || host.endsWith(".github.com")) return null;
    return host;
}

export const copilotDomainSchema = z
    .string()
    .max(DOMAIN_MOST + 8)
    .transform((value, context) => {
        const domain = copilotDomain(value);
        if (!domain) {
            context.addIssue({ code: "custom", message: "copilot.domain" });
            return z.NEVER;
        }
        return domain;
    });
