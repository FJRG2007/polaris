/**
 * Provider credentials somebody brought themselves, and how they combine with
 * the deployment's own.
 *
 * Two accounts can hold a key for the same provider: the person whose
 * repositories the runs belong to, and the administrator who set the instance
 * up. Whose money a run spends is settled here, once, so every screen and the
 * dispatch path agree:
 *
 *   1. The repository owner's own key for that provider, if they have one.
 *   2. The deployment's key, if the administrator allows it to be shared.
 *
 * That order is what makes bringing your own key mean anything - a personal key
 * that could be silently overridden by the instance's would be a setting with no
 * effect. The fallback is a switch rather than an assumption because handing
 * every account an administrator's billing is a decision somebody has to make on
 * purpose. It defaults to on, which is what deployments already do today.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { getSetting, setSetting } from "@/lib/setting-store";
import { readGatewayConfig } from "@/lib/integrations/registry";
import { GATEWAY_SLUG, MODEL_PROVIDERS } from "@/lib/agents/agent-providers";
import { encryptSecret, decryptSecret, CredentialDecryptError } from "@polaris/storage";
import { getIntegrationSecret, listIntegrationStates } from "@/lib/integration-service";

/** Whether an account with no key of its own may run on the deployment's. */
const SHARE_KEY = "agents.keys.shareInstance";

/** Every slug somebody may store a key under. The gateway is one of them: it is
 *  how an account reuses a subscription it already pays for. */
const STORABLE = new Set<string>([...MODEL_PROVIDERS.map((provider) => provider.slug), GATEWAY_SLUG]);

export function isStorableProvider(slug: string): boolean {
    return STORABLE.has(slug);
}

export async function instanceKeysAreShared(): Promise<boolean> {
    // Absent means yes. A deployment that upgraded into this feature was already
    // running everything on the instance's keys, and reading an unset row as
    // "no" would stop every run on it.
    return (await getSetting(SHARE_KEY)) !== "off";
}

export async function setInstanceKeysShared(shared: boolean): Promise<void> {
    await setSetting(SHARE_KEY, shared ? "on" : "off");
}

/** A stored key as a screen sees it - never the key. */
export interface UserModelKeyView {
    provider: string;
    config: Record<string, unknown>;
    lastUsedAt: string | null;
    updatedAt: string;
}

function parseConfig(json: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(json);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** What this account has brought. */
export async function listUserModelKeys(userId: string): Promise<UserModelKeyView[]> {
    const rows = await prisma.userModelKey.findMany({
        where: { userId },
        select: { provider: true, config: true, lastUsedAt: true, updatedAt: true },
        orderBy: { provider: "asc" }
    });
    return rows.map((row) => ({
        provider: row.provider,
        config: parseConfig(row.config),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString()
    }));
}

/** Store or replace one. The key is trimmed and encrypted; nothing keeps a
 *  plaintext copy, including this function's caller. */
export async function saveUserModelKey(
    userId: string,
    provider: string,
    secret: string,
    config?: Record<string, unknown>
): Promise<void> {
    const blob = encryptSecret(secret.trim(), loadEnv().POLARIS_MASTER_KEY);
    const fields = {
        encryptedSecret: blob.ciphertext,
        secretNonce: blob.nonce,
        secretKeyId: blob.keyId,
        ...(config === undefined ? {} : { config: JSON.stringify(config) })
    };
    await prisma.userModelKey.upsert({
        where: { userId_provider: { userId, provider } },
        create: { userId, provider, config: "{}", ...fields },
        update: fields
    });
}

export async function deleteUserModelKey(userId: string, provider: string): Promise<void> {
    await prisma.userModelKey.deleteMany({ where: { userId, provider } });
}

/** Decrypt one, or null when there is none or it cannot be read. A key written
 *  under a master key this deployment no longer has is not an error to raise at
 *  a run: it is simply a credential this instance does not hold. */
async function readUserSecret(userId: string, provider: string): Promise<string | null> {
    const row = await prisma.userModelKey.findUnique({
        where: { userId_provider: { userId, provider } },
        select: { encryptedSecret: true, secretNonce: true, secretKeyId: true }
    });
    if (!row) return null;
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedSecret),
                nonce: Buffer.from(row.secretNonce),
                keyId: row.secretKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}

/** Which providers can serve a run for this person - their own keys and, where
 *  the deployment shares them, its own. This is what every screen belonging to a
 *  person should offer models from; `connectedProviders` answers the narrower
 *  question of what the deployment itself holds. */
export async function providersFor(userId: string): Promise<string[]> {
    return [...(await keySourcesFor(userId)).keys()];
}

/** Which of the two accounts a provider's credential would come from. */
export type KeySource = "own" | "instance";

/** Where each provider's credential comes from for this person, provider slug to
 *  source. A provider absent from the map has no credential at all. */
export async function keySourcesFor(userId: string): Promise<Map<string, KeySource>> {
    const [own, states, shared] = await Promise.all([
        prisma.userModelKey.findMany({ where: { userId }, select: { provider: true } }),
        listIntegrationStates(),
        instanceKeysAreShared()
    ]);

    const sources = new Map<string, KeySource>();
    if (shared) {
        for (const provider of MODEL_PROVIDERS) {
            if (states.get(provider.slug)?.hasSecret) sources.set(provider.slug, "instance");
        }
        const gateway = states.get(GATEWAY_SLUG);
        if (gateway?.enabled) {
            const config = readGatewayConfig(gateway.config);
            if (config.baseUrl && config.model) sources.set(GATEWAY_SLUG, "instance");
        }
    }
    // Written after, so a personal key always wins the entry.
    for (const row of own) sources.set(row.provider, "own");
    return sources;
}

/**
 * The environment a run is handed, resolved for whoever owns the repository.
 *
 * Every provider that resolves is included rather than only the one the chosen
 * model needs: the agent CLIs pick a substitute themselves when a model is
 * unreachable, and handing over one key would turn a recoverable substitution
 * into a failed run.
 *
 * Returns null - distinct from an empty object - when the store could not be
 * read at all, so a run can tell "nobody has stored one" from "the store blinked"
 * and not report the second as the first.
 */
export async function runSecretsFor(userId: string | null): Promise<Record<string, string> | null> {
    try {
        const shared = await instanceKeysAreShared();
        const own = userId
            ? new Set(
                  (await prisma.userModelKey.findMany({ where: { userId }, select: { provider: true } })).map(
                      (row) => row.provider
                  )
              )
            : new Set<string>();
        const states = await listIntegrationStates();

        const secrets: Record<string, string> = {};
        const used: string[] = [];
        for (const provider of MODEL_PROVIDERS) {
            let key: string | null = null;
            if (userId && own.has(provider.slug)) {
                key = await readUserSecret(userId, provider.slug);
                if (key) used.push(provider.slug);
            }
            if (!key && shared && states.get(provider.slug)?.hasSecret) {
                key = await getIntegrationSecret(provider.slug);
            }
            if (key) secrets[provider.envVar] = key;
        }

        await applyGateway({ secrets, userId, own, states, shared, used });

        // Best-effort, and after the fact: it is a note on a screen, not
        // something a run should fail over.
        if (userId && used.length > 0) {
            await prisma.userModelKey
                .updateMany({ where: { userId, provider: { in: used } }, data: { lastUsedAt: new Date() } })
                .catch(() => undefined);
        }
        return secrets;
    } catch {
        return null;
    }
}

/**
 * The gateway, which is not a provider: it is an OpenAI-compatible endpoint in
 * front of whatever the account already pays for, so it contributes a base URL
 * and two token limits as well as a key.
 *
 * The limits ride along because an endpoint publishes no catalogue. Without them
 * the agent answers in 32000-token slices, which most models refuse outright,
 * and never compacts - the overflow check short-circuits on an undeclared window.
 */
async function applyGateway(input: {
    secrets: Record<string, string>;
    userId: string | null;
    own: Set<string>;
    states: Awaited<ReturnType<typeof listIntegrationStates>>;
    shared: boolean;
    used: string[];
}): Promise<void> {
    const personal = input.userId && input.own.has(GATEWAY_SLUG);
    if (personal) {
        const row = await prisma.userModelKey.findUnique({
            where: { userId_provider: { userId: input.userId as string, provider: GATEWAY_SLUG } },
            select: { config: true }
        });
        const config = readGatewayConfig(parseConfig(row?.config ?? "{}"));
        if (config.baseUrl) {
            input.secrets.OPENAI_COMPATIBLE_BASE_URL = config.baseUrl.replace(/\/+$/, "");
            input.secrets.OPENAI_COMPATIBLE_API_KEY =
                (await readUserSecret(input.userId as string, GATEWAY_SLUG)) ?? "unused";
            if (config.model) input.secrets.OPENAI_COMPATIBLE_MODEL = config.model;
            if (config.context > 0) input.secrets.OPENAI_COMPATIBLE_CONTEXT = String(config.context);
            if (config.maxOutput > 0) input.secrets.OPENAI_COMPATIBLE_MAX_OUTPUT = String(config.maxOutput);
            input.used.push(GATEWAY_SLUG);
            return;
        }
    }

    if (!input.shared) return;
    const gateway = input.states.get(GATEWAY_SLUG);
    if (!gateway?.enabled) return;
    const config = readGatewayConfig(gateway.config);
    if (!config.baseUrl) return;
    input.secrets.OPENAI_COMPATIBLE_BASE_URL = config.baseUrl.replace(/\/+$/, "");
    const key = gateway.hasSecret ? await getIntegrationSecret(GATEWAY_SLUG) : null;
    input.secrets.OPENAI_COMPATIBLE_API_KEY = key ?? "unused";
    if (config.model) input.secrets.OPENAI_COMPATIBLE_MODEL = config.model;
    if (config.context > 0) input.secrets.OPENAI_COMPATIBLE_CONTEXT = String(config.context);
    if (config.maxOutput > 0) input.secrets.OPENAI_COMPATIBLE_MAX_OUTPUT = String(config.maxOutput);
}
