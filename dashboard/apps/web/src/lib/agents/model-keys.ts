/**
 * Provider credentials, whoever brought them, and how they combine.
 *
 * Two owners can hold a key for the same provider: the person whose repositories
 * the runs belong to, and the deployment itself. Whose money a run spends is
 * settled here, once, so every screen and the dispatch path agree:
 *
 *   1. The repository owner's own keys, in the order they put them in.
 *   2. The deployment's keys, if the administrator allows them to be shared.
 *
 * That order is what makes bringing your own key mean anything - a personal key
 * that could be silently overridden by the deployment's would be a setting with
 * no effect. The fallback is a switch rather than an assumption because handing
 * every account an administrator's billing is a decision somebody has to make on
 * purpose. It defaults to on, which is what deployments already do today.
 *
 * Both kinds are rows in one table, told apart by having an owner or not. The
 * deployment's used to be a single key on the provider's Integration row - no
 * name, no end date, no order and no second key - which made an administrator's
 * credentials the poor relation of everybody else's for no reason anybody could
 * name.
 *
 * An owner may hold several keys for one provider - a work account and a
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
import { agentSignins, isSigninRow, isSigninSlug, signinSlug } from "@/lib/agents/agent-signins";
import { encryptSecret, decryptSecret, secretFingerprint, CredentialDecryptError } from "@polaris/storage";

/** Whose keys a call is about: an account, or the deployment itself. */
export type KeyOwner = string | null;

/** The deployment's own keys, which belong to no account and outlive all of
 *  them. Named rather than written as a bare null at every call site, because
 *  "the instance" is the thing being said. */
export const INSTANCE: KeyOwner = null;

/** Whether an account with no key of its own may run on the deployment's. */
const SHARE_KEY = "agents.keys.shareInstance";

/** Every slug somebody may store a key under. The gateway is one of them: it is
 *  how an account reuses a subscription it already pays for. */
const STORABLE = new Set<string>([...MODEL_PROVIDERS.map((provider) => provider.slug), GATEWAY_SLUG]);

export function isStorableProvider(slug: string): boolean {
    // Agent sign-ins live in this table too, under their own prefix. Asked
    // separately rather than folded into the set above because that set is
    // built once at module load and the sign-ins are derived from a catalogue -
    // a set frozen at import would go stale the moment one was added.
    return STORABLE.has(slug) || isSigninSlug(slug);
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
export interface ModelKeyView {
    id: string;
    provider: string;
    name: string;
    priority: number;
    config: Record<string, unknown>;
    /** When its owner said it stops working, or null for no end. */
    expiresAt: string | null;
    lastUsedAt: string | null;
    updatedAt: string;
}

/** The columns a screen may see. Everything absent from here is either the
 *  credential or bookkeeping nobody reads. */
const VIEW_SELECT = {
    id: true,
    provider: true,
    name: true,
    priority: true,
    config: true,
    expiresAt: true,
    lastUsedAt: true,
    updatedAt: true
} as const;

function toView(row: {
    id: string;
    provider: string;
    name: string;
    priority: number;
    config: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    updatedAt: Date;
}): ModelKeyView {
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        priority: row.priority,
        config: parseConfig(row.config),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString()
    };
}

/** The order every read of an owner's keys uses. Creation breaks a tie so a list
 *  with removed rows, whose positions are then no longer contiguous, still reads
 *  the same on every screen. */
const BY_PRIORITY = [{ priority: "asc" }, { createdAt: "asc" }] as const;

/** A key that has not passed its end date. Written once because "usable" has to
 *  mean the same thing everywhere, and called rather than held because the
 *  moment it compares against is the moment of the read - a constant here would
 *  freeze "now" at the first import and keep handing out keys that expired
 *  while the process was up. */
const unexpired = () => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

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

/** What this owner has, in the order it wants them tried. Expired keys are
 *  included: they are still theirs, and a row that vanished on its expiry date
 *  would look like Polaris lost it. */
export async function listModelKeys(owner: KeyOwner): Promise<ModelKeyView[]> {
    const rows = await prisma.userModelKey.findMany({
        where: { userId: owner },
        select: VIEW_SELECT,
        orderBy: [...BY_PRIORITY]
    });
    return rows.map(toView);
}

/** Which provider one of this owner's keys belongs to, or null when it holds no
 *  such key. Never returns the credential - only what to check it against. */
export async function providerOfModelKey(owner: KeyOwner, id: string): Promise<string | null> {
    const row = await prisma.userModelKey.findFirst({
        where: { id, userId: owner },
        select: { provider: true }
    });
    return row?.provider ?? null;
}

/**
 * What "the same credential" means, per provider.
 *
 * For a provider it is the key, and two rows holding one key are a duplicate. For
 * the gateway it is the key AND the endpoint: the token is frequently nothing at
 * all, so two gateways on the same network would otherwise collide on the
 * placeholder and only the first could be added.
 */
function fingerprintScope(provider: string, config?: Record<string, unknown>): string {
    if (provider !== GATEWAY_SLUG) return `model-key:${provider}`;
    const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.replace(/\/+$/, "") : "";
    return `model-key:${provider}:${baseUrl}`;
}

/**
 * The stored form of a secret: the envelope, plus the fingerprint that is the
 * only way to notice the same credential arriving twice.
 *
 * Writing a secret always resets `expiryNotice`, because whatever Polaris last
 * announced was about the key that is no longer there.
 */
function envelope(secret: string, provider: string, config?: Record<string, unknown>) {
    const master = loadEnv().POLARIS_MASTER_KEY;
    const blob = encryptSecret(secret.trim(), master);
    return {
        encryptedSecret: blob.ciphertext,
        secretNonce: blob.nonce,
        secretKeyId: blob.keyId,
        secretFingerprint: secretFingerprint(secret.trim(), fingerprintScope(provider, config), master),
        expiryNotice: ""
    };
}

/**
 * Whether this owner already calls a key by this name.
 *
 * Compared here rather than by the database, because the unique index is exact
 * and "Prod" beside "prod" is one name to the person reading the table. Done in
 * memory over the owner's own rows - there are a handful - since the
 * case-insensitive filter Postgres would use is not available on the SQLite the
 * dev setup runs on, and a rule that only holds in production is not a rule.
 */
export async function ownerHasModelKeyName(owner: KeyOwner, name: string, exceptId?: string): Promise<boolean> {
    const rows = await prisma.userModelKey.findMany({
        where: { userId: owner },
        select: { id: true, name: true }
    });
    const wanted = name.trim().toLowerCase();
    return rows.some((row) => row.id !== exceptId && row.name.toLowerCase() === wanted);
}

/** Whether this owner already holds this exact secret for this provider, other
 *  than as the row being edited. The same key stored twice is two rows that
 *  expire together, hit one rate ceiling together, and look like a spare. */
export async function ownerHasModelSecret(
    owner: KeyOwner,
    provider: string,
    secret: string,
    options: { exceptId?: string; config?: Record<string, unknown> } = {}
): Promise<boolean> {
    const { exceptId, config } = options;
    const fingerprint = secretFingerprint(
        secret.trim(),
        fingerprintScope(provider, config),
        loadEnv().POLARIS_MASTER_KEY
    );
    const row = await prisma.userModelKey.findFirst({
        where: {
            userId: owner,
            provider,
            secretFingerprint: fingerprint,
            ...(exceptId ? { id: { not: exceptId } } : {})
        },
        select: { id: true }
    });
    return row !== null;
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
export async function createModelKey(
    owner: KeyOwner,
    input: {
        provider: string;
        name: string;
        secret: string;
        config?: Record<string, unknown>;
        expiresAt?: Date | null;
    }
): Promise<ModelKeyView> {
    const last = await prisma.userModelKey.findFirst({
        where: { userId: owner },
        orderBy: { priority: "desc" },
        select: { priority: true }
    });
    const row = await prisma.userModelKey.create({
        data: {
            userId: owner,
            provider: input.provider,
            name: input.name,
            priority: (last?.priority ?? -1) + 1,
            config: JSON.stringify(input.config ?? {}),
            expiresAt: input.expiresAt ?? null,
            ...envelope(input.secret, input.provider, input.config)
        },
        select: VIEW_SELECT
    });
    return toView(row);
}

/**
 * Rename one, replace its key, move its expiry, or all three.
 *
 * A secret of undefined leaves the stored one alone - that is what makes a
 * rename a rename, rather than a form that quietly wipes the credential because
 * the write-only field was left empty. `expiresAt` is different: it is a plain
 * field, so null there means "no expiry" and undefined means "not mentioned".
 */
export async function updateModelKey(
    owner: KeyOwner,
    id: string,
    input: {
        name?: string;
        secret?: string;
        config?: Record<string, unknown>;
        expiresAt?: Date | null;
    }
): Promise<boolean> {
    const held = await prisma.userModelKey.findFirst({
        where: { id, userId: owner },
        select: { provider: true, config: true }
    });
    if (!held) return false;

    // The gateway's fingerprint takes in its endpoint, so a key rewritten
    // alongside a new endpoint has to be fingerprinted against the new one.
    const config = input.config ?? parseConfig(held.config);

    await prisma.userModelKey.update({
        where: { id },
        data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.secret === undefined ? {} : envelope(input.secret, held.provider, config)),
            ...(input.config === undefined ? {} : { config: JSON.stringify(input.config) }),
            // A date pushed out has to start the warnings over, or the one already
            // sent would be the last thing said about a key that is fine now.
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt, expiryNotice: "" })
        }
    });
    return true;
}

/** Remove one. Scoped by owner, so an id from somewhere else deletes nothing. */
export async function deleteModelKey(owner: KeyOwner, id: string): Promise<boolean> {
    const result = await prisma.userModelKey.deleteMany({ where: { id, userId: owner } });
    return result.count > 0;
}

/**
 * Write a new order.
 *
 * Ids this owner does not hold are ignored rather than refused: the list is
 * rewritten from what it does hold, so a stale row a screen still remembers
 * cannot renumber somebody else's keys or wedge the whole save. Anything left
 * out keeps its place after the ones named, in the order it already had.
 */
export async function reorderModelKeys(owner: KeyOwner, ids: string[]): Promise<void> {
    const rows = await prisma.userModelKey.findMany({
        where: { userId: owner },
        select: { id: true },
        orderBy: [...BY_PRIORITY]
    });
    const held = new Set(rows.map((row) => row.id));
    const named = ids.filter((id) => held.has(id));
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

/**
 * Every key this owner can actually spend, in its own order.
 *
 * An expired one is left out here rather than filtered later, so there is one
 * place that decides what "usable" means and no path that can forget: the date
 * its owner set is the date it stops being handed to a run.
 */
async function storedKeys(owner: KeyOwner): Promise<StoredKey[]> {
    return prisma.userModelKey.findMany({
        where: { userId: owner, ...unexpired() },
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

/**
 * Decrypt one, or null when it cannot be read.
 *
 * A key written under a master key this deployment no longer has is not an error
 * to raise at a run: it is simply a credential this instance does not hold.
 *
 * An empty envelope is not a failure either - it is a row that deliberately
 * carries no credential, which only a gateway that wants no token has. That is
 * the shape the deployment's own gateway arrived in when it was carried over
 * from its Integration row, where a missing key was a missing column rather than
 * a stored placeholder.
 */
function readSecret(row: StoredKey): string | null {
    if (row.encryptedSecret.length === 0) return "";
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
        // Compared against null rather than tested for truth: a gateway that
        // needs no token holds an empty secret, and it is still a usable row.
        if (secret !== null) return { row, secret };
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

/**
 * Which providers the DEPLOYMENT can serve a run with.
 *
 * Not the same question as which ones a given person can. Somebody may hold
 * their own key for a provider this has never heard of, and may be barred from
 * spending the deployment's - `providersFor` answers for a person, and is what
 * every screen belonging to one should call. This one is for the places with
 * nobody to resolve for: the setup wizard, and the deployment-wide defaults
 * under /admin.
 */
export async function connectedProviders(): Promise<string[]> {
    return usableProviders(await activeKeys(INSTANCE));
}

/** Provider and config of an owner's unexpired keys, in their order. Enough to
 *  say which providers are covered without decrypting anything. */
async function activeKeys(owner: KeyOwner): Promise<Array<{ provider: string; config: string }>> {
    return prisma.userModelKey.findMany({
        where: { userId: owner, ...unexpired() },
        select: { provider: true, config: true },
        orderBy: [...BY_PRIORITY]
    });
}

/**
 * The providers a list of keys covers, in the order the list gives them.
 *
 * The gateway joins on different terms: it holds no provider key, so what makes
 * it usable is an endpoint and a model to ask it for. A token is optional there
 * - plenty of them accept unauthenticated calls from inside the network - so
 * requiring one would hide a gateway that works.
 */
function usableProviders(keys: Array<{ provider: string; config: string }>): string[] {
    const providers: string[] = [];
    for (const row of keys) {
        if (providers.includes(row.provider)) continue;
        if (row.provider === GATEWAY_SLUG) {
            const config = readGatewayConfig(parseConfig(row.config));
            if (!config.baseUrl || !config.model) continue;
        }
        providers.push(row.provider);
    }
    return providers;
}

/** Which of the two owners a provider's credential would come from. */
export type KeySource = "own" | "instance";

/** Where each provider's credential comes from for this person, provider slug to
 *  source, in the order the account would have them tried. A provider absent from
 *  the map has no credential at all. */
export async function keySourcesFor(userId: string): Promise<Map<string, KeySource>> {
    const [own, instance, shared] = await Promise.all([
        // Expired keys are not credentials. Counting one would say a provider is
        // covered by this account and stop the deployment's key from stepping in
        // underneath it.
        activeKeys(userId),
        activeKeys(INSTANCE),
        instanceKeysAreShared()
    ]);

    // Written first, so the account's own order is the map's order and a personal
    // key always wins the entry.
    const sources = new Map<string, KeySource>();
    for (const provider of usableProviders(own)) sources.set(provider, "own");
    if (shared) {
        for (const provider of usableProviders(instance)) {
            if (!sources.has(provider)) sources.set(provider, "instance");
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
        const instance = shared ? await storedKeys(INSTANCE) : [];

        const secrets: Record<string, string> = {};
        const used: string[] = [];
        for (const provider of MODEL_PROVIDERS) {
            const picked = firstUsable(own, provider.slug) ?? firstUsable(instance, provider.slug);
            if (!picked || !picked.secret) continue;
            secrets[provider.envVar] = picked.secret;
            used.push(picked.row.id);
        }

        applyGateway(secrets, own, instance, used);
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
 * front of whatever the owner already pays for, so it contributes a base URL and
 * two token limits as well as a key.
 *
 * The limits ride along because an endpoint publishes no catalogue. Without them
 * the agent answers in 32000-token slices, which most models refuse outright,
 * and never compacts - the overflow check short-circuits on an undeclared window.
 */
function applyGateway(
    secrets: Record<string, string>,
    own: StoredKey[],
    instance: StoredKey[],
    used: string[]
): void {
    for (const keys of [own, instance]) {
        const picked = firstUsable(keys, GATEWAY_SLUG);
        if (!picked) continue;
        const config = readGatewayConfig(parseConfig(picked.row.config));
        if (!config.baseUrl) continue;
        writeGateway(secrets, config, picked.secret);
        used.push(picked.row.id);
        return;
    }
}

/** The five variables a gateway contributes, from one config. */
function writeGateway(
    secrets: Record<string, string>,
    config: ReturnType<typeof readGatewayConfig>,
    key: string | null
): void {
    secrets.OPENAI_COMPATIBLE_BASE_URL = config.baseUrl.replace(/\/+$/, "");
    // The token is frequently nothing: plenty of gateways accept unauthenticated
    // calls from inside the network, and the runtime still needs the variable.
    secrets.OPENAI_COMPATIBLE_API_KEY = key || "unused";
    if (config.model) secrets.OPENAI_COMPATIBLE_MODEL = config.model;
    if (config.context > 0) secrets.OPENAI_COMPATIBLE_CONTEXT = String(config.context);
    if (config.maxOutput > 0) secrets.OPENAI_COMPATIBLE_MAX_OUTPUT = String(config.maxOutput);
}

// ---------------------------------------------------------------------------
// Agent sign-ins
// ---------------------------------------------------------------------------

/**
 * The credentials a SESSION is handed: the model provider keys a run gets, plus
 * the sign-ins that no provider serves.
 *
 * One function rather than two calls at every site, because a session that got
 * one and not the other is a session that starts and then sits at a login prompt
 * - which looks from every screen exactly like an agent thinking hard.
 *
 * Null, as with a run's, means the store could not be read at all. An empty
 * object means it was read and holds nothing, and those two must not be reported
 * as each other: the first is a fault here, the second is somebody who has not
 * linked an account yet and can be told so.
 */
export async function sessionSecretsFor(userId: string | null): Promise<Record<string, string> | null> {
    const secrets = await runSecretsFor(userId);
    if (secrets === null) return null;
    try {
        const shared = await instanceKeysAreShared();
        const own = userId ? await storedKeys(userId) : [];
        const instance = shared ? await storedKeys(INSTANCE) : [];
        const used: string[] = [];
        for (const signin of agentSignins()) {
            const picked = firstUsable(own, signin.slug) ?? firstUsable(instance, signin.slug);
            if (!picked || !picked.secret) continue;
            secrets[signin.env] = picked.secret;
            used.push(picked.row.id);
        }
        await noteUsed(used);
        return secrets;
    } catch {
        return null;
    }
}

/** The sign-in rows this owner holds, as the screen that lists them needs them.
 *  Separate from `listModelKeys` so neither screen has to know the other's rows
 *  are in the same table. */
export async function listAgentSignins(owner: KeyOwner): Promise<ModelKeyView[]> {
    const rows = await listModelKeys(owner);
    return rows.filter((row) => isSigninRow(row.provider));
}

/** The model provider keys this owner holds - everything `listModelKeys` returns
 *  that is not a sign-in. What the providers table on the keys screen shows. */
export async function listProviderKeys(owner: KeyOwner): Promise<ModelKeyView[]> {
    const rows = await listModelKeys(owner);
    return rows.filter((row) => !isSigninRow(row.provider));
}

/** Which sign-ins this person can actually spend - their own, and the
 *  deployment's where it shares them. By variable, which is what readiness is
 *  asked in. */
/**
 * Which account, by name, a session would actually sign each agent in with.
 *
 * The narrower question `signinEnvsFor` answers is "is there one". This one is
 * "whose, and called what" - which is what somebody handing a task to an agent
 * needs, because a deployment can hold accounts of its own and an account can
 * hold several, and until this existed the screen said nothing at all about
 * which of them was about to do the work.
 *
 * Own before the deployment's, which is the order they are actually spent in.
 */
export async function signinAccountsFor(
    userId: string | null
): Promise<Map<string, { name: string; identity: string | null; source: KeySource }>> {
    const found = new Map<string, { name: string; identity: string | null; source: KeySource }>();
    try {
        const shared = await instanceKeysAreShared();
        const own = userId ? await storedKeys(userId) : [];
        const instance = shared ? await storedKeys(INSTANCE) : [];
        // The name and whose account it is are not on the row the resolver
        // returns, so the descriptive columns are read alongside it.
        const described = new Map(
            (await prisma.userModelKey.findMany({
                where: { OR: [...(userId ? [{ userId }] : []), ...(shared ? [{ userId: null }] : [])] },
                select: { id: true, name: true, config: true }
            })).map((row) => [row.id, row])
        );
        for (const signin of agentSignins()) {
            const slug = signinSlug(signin.env);
            const mine = firstUsable(own, slug);
            const picked = mine ?? firstUsable(instance, slug);
            if (!picked) continue;
            const row = described.get(picked.row.id);
            const config = row ? parseConfig(row.config) : {};
            const email = typeof config.email === "string" ? config.email : null;
            found.set(signin.env, {
                name: row?.name ?? "an account",
                identity: email,
                source: mine ? "own" : "instance"
            });
        }
    } catch {
        return found;
    }
    return found;
}

export async function signinEnvsFor(userId: string | null): Promise<Set<string>> {
    const found = new Set<string>();
    try {
        const shared = await instanceKeysAreShared();
        const own = userId ? await storedKeys(userId) : [];
        const instance = shared ? await storedKeys(INSTANCE) : [];
        for (const signin of agentSignins()) {
            const slug = signinSlug(signin.env);
            if (firstUsable(own, slug) ?? firstUsable(instance, slug)) found.add(signin.env);
        }
    } catch {
        return found;
    }
    return found;
}
