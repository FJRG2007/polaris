/**
 * Renewing a stored subscription login before its token is spent.
 *
 * One refresh per row at a time: two chats starting together on an expiring
 * login share the one renewal instead of racing, which matters for a vendor
 * that rotates the refresh token, since the loser of that race would be holding
 * one that no longer works (GitLab's plugin in OpenCode does the same).
 *
 * The rotated login is written back by the `persist` the caller hands in, so
 * this module does not depend on the key store.
 */

import { refreshXaiTokens } from "@/lib/agents/signin-xai";
import { refreshGitlabTokens } from "@/lib/agents/signin-gitlab";
import { refreshOpencodeTokens } from "@/lib/agents/signin-opencode";
import { asDirectPost, loginRequest, type LoginRequest } from "@/lib/agents/provider-login-http";
import { oauthNeedsRefresh, writeOAuthSecret, type StoredOAuth } from "@/lib/agents/provider-oauth";
import { coalescer } from "@/lib/coalesce";

const inFlight = coalescer<StoredOAuth>();

async function renew(provider: string, login: StoredOAuth, request: LoginRequest, now: number): Promise<StoredOAuth> {
    if (provider === "xai") {
        const tokens = await refreshXaiTokens(asDirectPost(request), login, now);
        return { ...login, ...tokens };
    }
    if (provider === "gitlab") {
        const tokens = await refreshGitlabTokens(request, login, now);
        return { ...login, ...tokens };
    }
    if (provider === "opencode" || provider === "opencode-go") {
        const tokens = await refreshOpencodeTokens(request, login, now);
        return { ...login, ...tokens };
    }
    // Copilot's GitHub token does not expire; nothing else is a login.
    return login;
}

/**
 * The login with a token that works now: the stored one when it has time
 * left, else a renewed one, written back before it is returned. A failed
 * renewal hands back the stored login, so the provider's own refusal is what
 * the router sees and cools the key over.
 */
export async function freshLogin(
    rowId: string,
    provider: string,
    login: StoredOAuth,
    persist: (secret: string) => Promise<void>,
    request: LoginRequest = loginRequest,
    now = Date.now()
): Promise<StoredOAuth> {
    if (!oauthNeedsRefresh(login, now)) return login;
    return inFlight.run(rowId, async () => {
        try {
            const renewed = await renew(provider, login, request, now);
            if (renewed !== login) await persist(writeOAuthSecret(renewed));
            return renewed;
        } catch (caught) {
            console.warn(`[provider-login] ${provider} refresh failed:`, caught instanceof Error ? caught.message : "error");
            return login;
        }
    });
}
