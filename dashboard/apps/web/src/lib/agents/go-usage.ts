/**
 * How much of its OpenCode Go allowance each of a person's Console sign-ins
 * has used, for the sign-in card on /account/ai-keys.
 *
 * Read when the card asks, never in the background, and kept for a minute per
 * sign-in so a screen opened twice asks OpenCode once.
 *
 * Server-only.
 */

import { chatCredentialsFor } from "@/lib/agents/model-keys";
import { loginRequest, type LoginRequest } from "@/lib/agents/provider-login-http";
import { readGoUsage, type GoUsage } from "@/lib/agents/signin-opencode";

/** One Console sign-in and its allowance: null usage when its workspace has no
 *  Go, `failed` when OpenCode could not be asked. */
export interface GoUsageRow {
    keyId: string;
    name: string;
    workspace: string | null;
    usage: GoUsage | null;
    failed: boolean;
}

const CONSOLE_SLUGS = ["opencode-go", "opencode"] as const;
const CACHE_MS = 60_000;
const MAX_CACHED = 1000;
const cache = new Map<string, { until: number; row: GoUsageRow }>();

export async function goUsageFor(
    userId: string,
    request: LoginRequest = loginRequest,
    now = Date.now()
): Promise<GoUsageRow[]> {
    const held = (await Promise.all(CONSOLE_SLUGS.map((slug) => chatCredentialsFor(userId, slug, "own")))).flat();
    // A pasted Console key has no workspace to ask about; only sign-ins do.
    const logins = held.filter((credential) => credential.oauth && credential.keyId);
    return Promise.all(
        logins.map(async (credential) => {
            const keyId = credential.keyId!;
            const cached = cache.get(keyId);
            if (cached && cached.until > now) return cached.row;
            const base = {
                keyId,
                name: credential.keyName ?? keyId,
                workspace: credential.oauth?.orgName ?? null
            };
            let row: GoUsageRow;
            try {
                row = { ...base, usage: await readGoUsage(request, credential.secret, credential.oauth?.orgID), failed: false };
            } catch (caught) {
                console.warn("[go-usage] read failed:", caught instanceof Error ? caught.message : "error");
                return { ...base, usage: null, failed: true };
            }
            if (cache.size >= MAX_CACHED) cache.clear();
            cache.set(keyId, { until: now + CACHE_MS, row });
            return row;
        })
    );
}

/** Test seam: forget every cached reading. */
export function resetGoUsageCache(): void {
    cache.clear();
}
