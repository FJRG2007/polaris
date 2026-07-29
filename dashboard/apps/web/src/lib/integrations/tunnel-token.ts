/**
 * What a tunnel provider's token has to look like before Polaris stores it.
 * Neither provider offers a way to verify a token without running the agent, so
 * this is a shape check rather than a validation: it catches the half-selected
 * paste, the dashboard URL pasted instead of the token, and the stray newline,
 * and leaves anything that could plausibly be a token to the provider to reject.
 */

export type TunnelProviderSlug = "cloudflare" | "ngrok";

const RULES: Record<TunnelProviderSlug, { pattern: RegExp; hint: string }> = {
    // Authtokens are base62 with one underscore separating the two halves; older
    // ones are a single run of base62 with no separator at all.
    ngrok: {
        pattern: /^[A-Za-z0-9_]{20,}$/,
        hint: "That is not an ngrok authtoken. Copy the whole value from the ngrok dashboard."
    },
    // A connector token is base64 (either alphabet) and never short - it carries
    // the account, the tunnel id, and its secret.
    cloudflare: {
        pattern: /^[A-Za-z0-9+/=_-]{40,}$/,
        hint: "That is not a Cloudflare tunnel token. Copy the token from the connector install command."
    }
};

/** Whether `token` has the shape `provider` issues. Blank is not a token - callers
 *  that let a blank field keep the stored one check for blank themselves. */
export function isTunnelToken(provider: TunnelProviderSlug, token: string): boolean {
    return RULES[provider].pattern.test(token.trim());
}

/** What to tell an operator whose token was refused by the shape check. */
export function tunnelTokenHint(provider: TunnelProviderSlug): string {
    return RULES[provider].hint;
}
