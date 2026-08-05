/**
 * Provider credentials somebody brought themselves, and how they combine with
 * the deployment's own.
 *
 * Two accounts can hold a key for the same provider: the person whose
 * repositories the runs belong to, and the administrator who set the instance
 * up. Whose money a run spends is settled here, once, so every screen and the
 * dispatch path agree:
 *
 *   1. The repository owner's own keys, in the order they put them in.
 *   2. The deployment's key, if the administrator allows it to be shared.
 *
 * That order is what makes bringing your own key mean anything - a personal key
 * that could be silently overridden by the instance's would be a setting with no
 * effect. The fallback is a switch rather than an assumption because handing
 * every account an administrator's billing is a decision somebody has to make on
 * purpose. It defaults to on, which is what deployments already do today.
 *
 * An account may hold several keys for one provider - a work account and a
 * personal one, two spend caps, a spare for when the first is rate limited. They
 * are a list, not a set: `priority` is the order, the first key of a provider
 * that can be decrypted is the one a run is handed, and the order the providers
 * themselves appear in is the same list read from the top.
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
    id: string;
    provider: string;
    name: string;
    priority: number;
    config: Record<string, unknown>;
    lastUsedAt: string | null;
    updatedAt: string;
}

/** The order every read of somebody's keys uses. Creation breaks a tie so a list
 *  with removed rows, whose positions are then no longer contiguous, still reads
 *  the same on every screen. */
const BY_PRIORITY = [{ priority: "asc" }, { createdAt: "asc" }] as const;

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

/** What this account has brought, in the order it wants them tried. */
export async function listUserModelKeys(userId: string): Promise<UserModelKeyView[]> {
    const rows = await prisma.userModelKey.findMany({
        where: { userId },
        select: {
            id: true,
            provider: true,
            name: true,
            priority: true,
            config: true,
            lastUsedAt: true,
            updatedAt: true
        },
        orderBy: [...BY_PRIORITY]
    });
    return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        name: row.name,
        priority: row.priority,
        config: parseConfig(row.config),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString()
    }));
}

/** Which provider one of this account's keys belongs to, or null when it holds no
 *  such key. Never returns the credential - only what to check it against. */
export async function providerOfUserModelKey(userId: string, id: string): Promise<string | null> {
    const row = await prisma.userModelKey.findFirst({ where: { id, userId }, select: { provider: true } });
    return row?.provider ?? null;
}

function envelope(secret: string): { encryptedSecret: Buffer; secretNonce: Buffer; secretKeyId: string } {
    const blob = encryptSecret(secret.trim(), loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

/**
 * Store a new one, at the end of the list.
 *
 * The end rather than the front because a key somebody just added is the one
 * they know least about: putting it in front would silently re-point every run
 * at it. Moving it up is one drag, and it is theirs to make.
 *
 * The key is encrypted here; nothing keeps a plaintext copy, including the
 * caller.
 */
export async function createUserModelKey(
    userId: string,
    input: { provider: string; name: string; secret: string; config?: Record<string, unknown> }
): Promise<UserModelKeyView> {
    const last = await prisma.userModelKey.findFirst({
        where: { userId },
        orderBy: { priority: "desc" },
        select: { priority: true }
    });
    const row = await prisma.userModelKey.create({
        data: {
            userId,
            provider: input.provider,
            name: input.name,
            priority: (last?.priority ?? -1) + 1,
            config: JSON.stringify(input.config ?? {}),
            ...envelope(input.secret)
        },
        select: {
            id: true,
            provider: true,
            name: true,
            priority: true,
            config: true,
            lastUsedAt: true,
            updatedAt: true
        }
    });
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        priority: row.priority,
        config: parseConfig(row.config),
        lastUsedAt: null,
        updatedAt: row.updatedAt.toISOString()
    };
}

/**
 * Rename one, replace its key, or both.
 *
 * A secret of undefined leaves the stored one alone - that is what makes a
 * rename a rename, rather than a form that quietly wipes the credential because
 * the write-only field was left empty.
 */
export async function updateUserModelKey(
    userId: string,
    id: string,
    input: { name?: string; secret?: string; config?: Record<string, unknown> }
): Promise<boolean> {
    const result = await prisma.userModelKey.updateMany({
        where: { id, userId },
        data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.secret === undefined ? {} : envelope(input.secret)),
            ...(input.config === undefined ? {} : { config: JSON.stringify(input.config) })
        }
    });
    return result.count > 0;
}

/** Remove one. Scoped by owner, so an id from somewhere else deletes nothing. */
export async function deleteUserModelKey(userId: string, id: string): Promise<boolean> {
    const result = await prisma.userModelKey.deleteMany({ where: { id, userId } });
    return result.count > 0;
}

/**
 * Write a new order.
 *
 * Ids this account does not own are ignored rather than refused: the list is
 * rewritten from what it does own, so a stale row a screen still remembers
 * cannot renumber somebody else's keys or wedge the whole save. Anything left
 * out keeps its place after the ones named, in the order it already had.
 */
export async function reorderUserModelKeys(userId: string, ids: string[]): Promise<void> {
    const rows = await prisma.userModelKey.findMany({
        where: { userId },
        select: { id: true },
        orderBy: [...BY_PRIORITY]
    });
    const owned = new Set(rows.map((row) => row.id));
    const named = ids.filter((id) => owned.has(id));
    const ordered = [...new Set([...named, ...rows.map((row) => row.id)])];

    await prisma.$transaction(
        ordered.map((id, index) =>
            prisma.userModelKey.update({ where: { id }, data: { priority: index } })
        )
    );
}

/** One stored credential, as the resolution path reads it. */
interface StoredKey {
    id: string;
    provider: string;
    config: string;
    encryptedSecret: Uint8Array;
    secretNonce: Uint8Array;
    secretKeyId: string;
}

/** Every key this account holds, in its own order. */
async function storedKeys(userId: string): Promise<StoredKey[]> {
    return prisma.userModelKey.findMany({
        where: { userId },
        select: {
            id: true,
            provider: true,
            config: true,
            encryptedSecret: true,
            secretNonce: true,
            secretKeyId: true
        },
        orderBy: [...BY_PRIORITY]
    });
}

/** Decrypt one, or null when it cannot be read. A key written under a master key
 *  this deployment no longer has is not an error to raise at a run: it is simply
 *  a credential this instance does not hold. */
function readSecret(row: StoredKey): string | null {
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

/** The first key of this provider that can actually be read, with the row it came
 *  from so the caller can note that it was used. */
function firstUsable(keys: StoredKey[], provider: string): { row: StoredKey; secret: string } | null {
    for (const row of keys) {
        if (row.provider !== provider) continue;
        const secret = readSecret(row);
        if (secret) return { row, secret };
    }
    return null;
}

/** Which providers can serve a run for this person - their own keys and, where
 *  the deployment shares them, its own. This is what every screen belonging to a
 *  person should offer models from; `connectedProviders` answers the narrower
 *  question of what the deployment itself holds. Ordered: the account's own
 *  preference first, then whatever the deployment adds under it. */
export async function providersFor(userId: string): Promise<string[]> {
    return [...(await keySourcesFor(userId)).keys()];
}

/** Which of the two accounts a provider's credential would come from. */
export type KeySource = "own" | "instance";

/** Where each provider's credential comes from for this person, provider slug to
 *  source, in the order the account would have them tried. A provider absent from
 *  the map has no credential at all. */
export async function keySourcesFor(userId: string): Promise<Map<string, KeySource>> {
    const [own, states, shared] = await Promise.all([
        prisma.userModelKey.findMany({
            where: { userId },
            select: { provider: true },
            orderBy: [...BY_PRIORITY]
        }),
        listIntegrationStates(),
        instanceKeysAreShared()
    ]);

    // Written first, so the account's own order is the map's order and a personal
    // key always wins the entry.
    const sources = new Map<string, KeySource>();
    for (const row of own) if (!sources.has(row.provider)) sources.set(row.provider, "own");

    if (shared) {
        for (const provider of MODEL_PROVIDERS) {
            if (!sources.has(provider.slug) && states.get(provider.slug)?.hasSecret) {
                sources.set(provider.slug, "instance");
            }
        }
        const gateway = states.get(GATEWAY_SLUG);
        if (!sources.has(GATEWAY_SLUG) && gateway?.enabled) {
            const config = readGatewayConfig(gateway.config);
            if (config.baseUrl && config.model) sources.set(GATEWAY_SLUG, "instance");
        }
    }
    return sources;
}

/**
 * The environment a run is handed, resolved for whoever owns the repository.
 *
 * Every provider that resolves is included rather than only the one the chosen
 * model needs: the agent CLIs pick a substitute themselves when a model is
 * unreachable, and handing over one key would turn a recoverable substitution
 * into a failed run. A provider the account holds several keys for contributes
 * one - the first that reads - because the variable the CLIs look at holds one
 * value, and which one is the order the account set.
 *
 * Returns null - distinct from an empty object - when the store could not be
 * read at all, so a run can tell "nobody has stored one" from "the store blinked"
 * and not report the second as the first.
 */
export async function runSecretsFor(userId: string | null): Promise<Record<string, string> | null> {
    try {
        const shared = await instanceKeysAreShared();
        const own = userId ? await storedKeys(userId) : [];
        const states = await listIntegrationStates();

        const secrets: Record<string, string> = {};
        const used: string[] = [];
        for (const provider of MODEL_PROVIDERS) {
            const mine = firstUsable(own, provider.slug);
            let key = mine?.secret ?? null;
            if (mine) used.push(mine.row.id);
            if (!key && shared && states.get(provider.slug)?.hasSecret) {
                key = await getIntegrationSecret(provider.slug);
            }
            if (key) secrets[provider.envVar] = key;
        }

        await applyGateway({ secrets, own, states, shared, used });
        await noteUsed(used);
        return secrets;
    } catch {
        return null;
    }
}

/** Best-effort, and after the fact: it is a note on a screen, not something a run
 *  should fail over. */
async function noteUsed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await prisma.userModelKey
        .updateMany({ where: { id: { in: ids } }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
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
    own: StoredKey[];
    states: Awaited<ReturnType<typeof listIntegrationStates>>;
    shared: boolean;
    used: string[];
}): Promise<void> {
    const mine = firstUsable(input.own, GATEWAY_SLUG);
    if (mine) {
        const config = readGatewayConfig(parseConfig(mine.row.config));
        if (config.baseUrl) {
            writeGateway(input.secrets, config, mine.secret);
            input.used.push(mine.row.id);
            return;
        }
    }

    if (!input.shared) return;
    const gateway = input.states.get(GATEWAY_SLUG);
    if (!gateway?.enabled) return;
    const config = readGatewayConfig(gateway.config);
    if (!config.baseUrl) return;
    // The token is frequently nothing: plenty of gateways accept unauthenticated
    // calls from inside the network, and the runtime still needs the variable.
    writeGateway(input.secrets, config, gateway.hasSecret ? await getIntegrationSecret(GATEWAY_SLUG) : null);
}

/** The five variables a gateway contributes, from one config. */
function writeGateway(
    secrets: Record<string, string>,
    config: ReturnType<typeof readGatewayConfig>,
    key: string | null
): void {
    secrets.OPENAI_COMPATIBLE_BASE_URL = config.baseUrl.replace(/\/+$/, "");
    secrets.OPENAI_COMPATIBLE_API_KEY = key ?? "unused";
    if (config.model) secrets.OPENAI_COMPATIBLE_MODEL = config.model;
    if (config.context > 0) secrets.OPENAI_COMPATIBLE_CONTEXT = String(config.context);
    if (config.maxOutput > 0) secrets.OPENAI_COMPATIBLE_MAX_OUTPUT = String(config.maxOutput);
}
