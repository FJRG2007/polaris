/**
 * Adding a cloud account (`cloud-credentials.ts`) as one of a person's model
 * keys: checked with its vendor where that can be done without side effects,
 * then stored encrypted on the provider's slug, named after it.
 *
 * DigitalOcean's sign-in is OpenCode's implicit grant: the state it started
 * with lives in server memory only, bound to the account, for fifteen minutes.
 *
 * Server-only.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { TokenFetch } from "@/lib/agents/cloud-tokens";
import { createModelKey, ownerHasModelKeyName } from "@/lib/agents/model-keys";
import { checkCloudCredential, type CloudCheck } from "@/lib/polar/cloud-models";
import {
    digitaloceanAuthorizeUrl,
    readDigitaloceanReturn,
    writeCloudSecret,
    type CloudCredential,
    type CloudProvider
} from "@/lib/agents/cloud-credentials";

const KEY_NAME: Record<CloudProvider, string> = {
    "amazon-bedrock": "Amazon Bedrock", // i18n-ignore: product name
    azure: "Azure OpenAI", // i18n-ignore: product name
    "google-vertex": "Google Vertex AI", // i18n-ignore: product name
    "snowflake-cortex": "Snowflake Cortex", // i18n-ignore: product name
    digitalocean: "DigitalOcean" // i18n-ignore: product name
};

export type CloudAdd = { ok: true; keyId: string } | Extract<CloudCheck, { ok: false }>;

export async function addCloudAccount(
    userId: string,
    credential: CloudCredential,
    request?: TokenFetch
): Promise<CloudAdd> {
    const checked = await checkCloudCredential(credential, request);
    if (!checked.ok) return checked;
    const base = KEY_NAME[checked.credential.provider];
    let name = base;
    for (let n = 2; n < 50 && (await ownerHasModelKeyName(userId, name)); n++) name = `${base} ${n}`;
    const row = await createModelKey(userId, {
        provider: checked.credential.provider,
        name,
        secret: writeCloudSecret(checked.credential),
        ...(checked.credential.provider === "digitalocean" && checked.credential.method === "oauth"
            ? { expiresAt: new Date(checked.credential.expires) }
            : {})
    });
    return { ok: true, keyId: row.id };
}

interface Attempt {
    userId: string;
    state: string;
    startedAt: number;
}

const ATTEMPT_LIFETIME_MS = 15 * 60_000;
const MAX_ATTEMPTS = 500;
const attempts = new Map<string, Attempt>();

export function startDigitaloceanLogin(userId: string, now = Date.now()): { id: string; url: string } {
    for (const [id, attempt] of attempts) {
        if (now - attempt.startedAt > ATTEMPT_LIFETIME_MS) attempts.delete(id);
    }
    while (attempts.size >= MAX_ATTEMPTS) {
        const oldest = attempts.keys().next().value;
        if (oldest === undefined) break;
        attempts.delete(oldest);
    }
    const id = randomUUID();
    const state = randomBytes(32).toString("base64url");
    attempts.set(id, { userId, state, startedAt: now });
    return { id, url: digitaloceanAuthorizeUrl(state) };
}

export type DigitaloceanFinish = CloudAdd | { ok: false; reason: "gone" | "bad-paste" | "denied" };

export async function finishDigitaloceanLogin(
    userId: string,
    id: string,
    pasted: string,
    request?: TokenFetch,
    now = Date.now()
): Promise<DigitaloceanFinish> {
    const attempt = attempts.get(id);
    if (!attempt || attempt.userId !== userId || now - attempt.startedAt > ATTEMPT_LIFETIME_MS) {
        return { ok: false, reason: "gone" };
    }
    const read = readDigitaloceanReturn(pasted, attempt.state, now);
    if (!read.ok) return read;
    attempts.delete(id);
    return addCloudAccount(
        userId,
        { provider: "digitalocean", method: "oauth", token: read.token, expires: read.expires },
        request
    );
}
