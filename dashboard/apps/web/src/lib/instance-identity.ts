/**
 * Who this Polaris is, in a form a client can check from another address.
 *
 * One stable instance id and one Ed25519 keypair, made the first time the
 * dashboard boots and kept in the `Setting` table from then on, so every peer of
 * a no-downtime rollover answers with the same identity. The private key is
 * sealed with the master key like every other secret here; the public key and
 * the id are public by design.
 *
 * A client that signed in over the public domain stores the id, the public key
 * and the addresses below. When that domain stops answering it challenges one of
 * the other addresses (`signChallenge`) and sends its credential there only when
 * the signature checks out - see `@polaris/core/instance-fallback`.
 *
 * Made on boot when missing, so an install that predates it needs nothing from
 * `.env` and nothing from its operator.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { getHostLanIp } from "@/lib/host-address";
import { appBaseUrl } from "@/lib/domain-service";
import { dashboardHosts } from "@/lib/domain-edge";
import { challengeMessage } from "@polaris/core/instance-fallback";
import { CredentialDecryptError, decryptSecret, encryptSecret } from "@polaris/storage";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/** Readable from any origin, never with a cookie. */
export const OPEN_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
} as const;

/** The one row the identity lives in. */
export const IDENTITY_KEY = "instance.identity";

/** What the row holds. The private key only ever sealed. */
interface StoredIdentity {
    readonly id: string;
    readonly publicKey: string;
    readonly sealed: { readonly c: string; readonly n: string; readonly k: string };
}

export interface InstanceIdentity {
    readonly id: string;
    /** Raw Ed25519 public key, base64url. */
    readonly publicKey: string;
    readonly privateKey: KeyObject;
}

let cached: InstanceIdentity | null = null;
let inflight: Promise<InstanceIdentity | null> | null = null;

/** Drop the cached identity. For tests that assert what was stored. */
export function forgetInstanceIdentity(): void {
    cached = null;
    inflight = null;
}

function readStored(raw: string): StoredIdentity | null {
    try {
        const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
        const sealed = parsed.sealed;
        if (
            typeof parsed.id === "string" &&
            typeof parsed.publicKey === "string" &&
            sealed &&
            typeof sealed.c === "string" &&
            typeof sealed.n === "string" &&
            typeof sealed.k === "string"
        ) {
            return { id: parsed.id, publicKey: parsed.publicKey, sealed };
        }
    } catch {
        // Not JSON: treated as missing by the caller, which refuses to replace it.
    }
    return null;
}

function open(stored: StoredIdentity): InstanceIdentity {
    const pkcs8 = decryptSecret(
        {
            ciphertext: Buffer.from(stored.sealed.c, "base64"),
            nonce: Buffer.from(stored.sealed.n, "base64"),
            keyId: stored.sealed.k
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" });
    return { id: stored.id, publicKey: stored.publicKey, privateKey };
}

function mint(): { stored: StoredIdentity; identity: InstanceIdentity } {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = String(pair.publicKey.export({ format: "jwk" }).x);
    const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const blob = encryptSecret(pkcs8, loadEnv().POLARIS_MASTER_KEY);
    const id = `plr_${randomBytes(16).toString("base64url")}`;
    const stored: StoredIdentity = {
        id,
        publicKey,
        sealed: { c: blob.ciphertext.toString("base64"), n: blob.nonce.toString("base64"), k: blob.keyId }
    };
    return { stored, identity: { id, publicKey, privateKey: pair.privateKey } };
}

async function load(): Promise<InstanceIdentity | null> {
    const existing = await prisma.setting.findUnique({ where: { key: IDENTITY_KEY }, select: { value: true } });
    if (existing) {
        const stored = readStored(existing.value);
        // A row that cannot be read is never replaced: clients have pinned the key
        // it held, and a new one would read to all of them as another Polaris.
        if (!stored) {
            console.error("polaris: the instance identity is unreadable; leaving it in place");
            return null;
        }
        try {
            return open(stored);
        } catch (caught) {
            if (caught instanceof CredentialDecryptError) {
                console.error("polaris: the instance identity key cannot be opened with this master key");
                return null;
            }
            throw caught;
        }
    }
    const { stored, identity } = mint();
    try {
        await prisma.setting.create({ data: { key: IDENTITY_KEY, value: JSON.stringify(stored), scope: "global" } });
        return identity;
    } catch {
        // Another peer of the rollover made it first; theirs is the one to keep.
        const raced = await prisma.setting.findUnique({ where: { key: IDENTITY_KEY }, select: { value: true } });
        const theirs = raced ? readStored(raced.value) : null;
        return theirs ? open(theirs) : null;
    }
}

/**
 * The identity, made when this install has none. Idempotent and safe on every
 * boot and every request; null only when a stored one cannot be opened, which is
 * logged and never repaired by replacing it.
 */
export async function ensureInstanceIdentity(): Promise<InstanceIdentity | null> {
    if (cached) return cached;
    inflight ??= load()
        .then((identity) => {
            cached = identity;
            return identity;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

function origin(value: string): string | null {
    try {
        const url = new URL(value.includes("://") ? value : `https://${value}`);
        return url.protocol === "https:" ? url.origin : null;
    } catch {
        return null;
    }
}

/**
 * Every https origin this Polaris answers on: its public hostnames first, then the
 * names and the address it has on the LAN. Plain-http addresses are left out on
 * purpose - a client only sends its credential to an alternate over TLS.
 */
export async function instanceAddresses(): Promise<string[]> {
    const [app, hosts, lanIp] = await Promise.all([
        appBaseUrl().catch(() => null),
        dashboardHosts().catch(() => [] as string[]),
        getHostLanIp().catch(() => null)
    ]);
    const mdns = process.env.POLARIS_MDNS_HOSTNAME || process.env.POLARIS_LOCAL_HOSTNAME || "polaris";
    const candidates = [
        ...(app ? [app] : []),
        ...hosts,
        `${mdns}.local`,
        "polaris.local",
        ...(lanIp ? [lanIp] : [])
    ];
    const origins = candidates.map(origin).filter((one): one is string => one !== null);
    return [...new Set(origins)].slice(0, 16);
}

/** Sign a client's nonce for the origin it asked on. */
export function signChallenge(identity: InstanceIdentity, requestOrigin: string, nonce: string): string {
    const message = Buffer.from(challengeMessage(identity.id, requestOrigin, nonce));
    return sign(null, message, identity.privateKey).toString("base64url");
}
