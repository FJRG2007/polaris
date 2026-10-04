/**
 * Which known assistant a connected app is, so the account screen can draw its
 * mark. Client-safe and pure.
 *
 * A client's name is its own claim, so a name alone never earns a brand's
 * logo: every address it sends people back to must also be either this
 * computer (a local tool the person started, which is how Claude Code, Cursor
 * and VS Code sign in) or the brand's own domain. "ChatGPT" returning to some
 * other site gets a plain initial instead.
 *
 * A registered `logo_uri` is deliberately not used: it is the client's claim
 * too, and loading it would hand that site a request every time somebody opens
 * their account.
 */

import { isLoopback } from "./urls";

export type ClientBrand = "claude-code" | "claude" | "chatgpt" | "cursor" | "vscode";

interface BrandRule {
    readonly brand: ClientBrand;
    readonly name: RegExp;
    /** Hosts (and their subdomains) the brand's hosted client returns to. */
    readonly domains: readonly string[];
}

/** First match wins, so Claude Code is tried before Claude. */
const RULES: readonly BrandRule[] = [
    { brand: "claude-code", name: /^claude[ -]?code\b/i, domains: [] },
    { brand: "claude", name: /^claude\b/i, domains: ["claude.ai", "claude.com"] },
    { brand: "chatgpt", name: /^(chatgpt|openai)\b/i, domains: ["chatgpt.com", "openai.com"] },
    { brand: "cursor", name: /^cursor\b/i, domains: ["cursor.com", "cursor.sh"] },
    { brand: "vscode", name: /^(visual studio code|vs ?code)\b/i, domains: ["vscode.dev"] }
];

function onDomain(host: string, domains: readonly string[]): boolean {
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function returnsHome(uri: string, domains: readonly string[]): boolean {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    if (isLoopback(url)) return true;
    return url.protocol === "https:" && onDomain(url.hostname.toLowerCase(), domains);
}

/** The known assistant behind a client, or null to draw its initial. */
export function clientBrand(name: string, redirectUris: readonly string[]): ClientBrand | null {
    const trimmed = name.trim();
    if (!trimmed || redirectUris.length === 0) return null;
    const rule = RULES.find((entry) => entry.name.test(trimmed));
    if (!rule) return null;
    return redirectUris.every((uri) => returnsHome(uri, rule.domains)) ? rule.brand : null;
}
