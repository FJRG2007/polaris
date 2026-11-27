/**
 * End-to-end encryption of a call's media: the rule, and the key exchange.
 *
 * Every call is end-to-end encrypted except a stage's, the way Discord's DAVE
 * protocol scopes it (daveprotocol.com: stage channels are not an eligible
 * session type). The frames themselves are encrypted by the call client's own
 * frame cryptor - LiveKit's E2EE, AES-GCM over each encoded frame through
 * insertable streams or `RTCRtpScriptTransform` in a worker - so this file only
 * decides who holds which key.
 *
 * The key. One random 256-bit key per membership of the call, made by its
 * leader - the participant with the lowest identity - and handed to every other
 * participant wrapped for them alone: ECDH (P-256) between the leader's and the
 * recipient's per-call key pairs, HKDF-SHA-256, AES-GCM. Somebody joining or
 * leaving makes the leader draw a new one (a new "generation"), so a participant
 * who left never holds the key the call continues under and one who arrived never
 * holds the key it was under before. DAVE gets the same property from an MLS
 * group of the call's participants whose epoch changes on every join and leave.
 *
 * Bound to the conversation's MLS group where there is one. When both ends hold
 * the conversation's group at the same epoch, its MLS exporter secret (RFC 9420
 * section 8.5, label `polaris/call/v1`, context the room) is the HKDF salt. The
 * server never has that secret, so a server that swapped the per-call public
 * keys for its own still could not open the wrap. Without a group - sealed chat
 * off, a public channel, a guest with no account - the wrap rests on the per-call
 * key pairs alone: the media server and Polaris never see the media, but a
 * server actively substituting keys during the exchange is not detected. Which of
 * the two a call has is said in the call.
 *
 * No imports beyond zod and WebCrypto, so the server's refusal and the tests
 * read the same rule the browser does.
 */

import { z } from "zod";

/**
 * The version of call encryption a client speaks. A client that sends a lower
 * one (or none: every client from before this existed) is refused a ticket to
 * an encrypted call instead of joining it in the clear.
 */
export const CALL_E2EE_VERSION = 1;

/** Data-message topic the wrapped keys travel on. */
export const CALL_KEY_TOPIC = "polaris.call-key";

/** Participant attribute carrying this browser's per-call public key. */
export const CALL_KEY_ATTRIBUTE = "polaris.e2ee";

/** The frame cryptor's key ring: a generation lives in slot `gen % size`. */
export const CALL_KEYRING_SIZE = 16;

/** Whether a call is end-to-end encrypted: every call except a stage's. */
export function callEncrypted(stage: boolean): boolean {
    return !stage;
}

/**
 * Why a client may not have a ticket, or null when it may. Read where the
 * ticket is signed, because the ticket is the only thing the media server
 * believes.
 */
export function callE2eeRefusal(stage: boolean, clientVersion: number | undefined): "outdated" | null {
    if (!callEncrypted(stage)) return null;
    return (clientVersion ?? 0) >= CALL_E2EE_VERSION ? null : "outdated";
}

/** The participant that makes the keys: the lowest identity present. */
export function keyLeader(identities: Iterable<string>): string | null {
    let leader: string | null = null;
    for (const identity of identities) if (leader === null || identity < leader) leader = identity;
    return leader;
}

/** The key-ring slot a generation is kept in. */
export function keySlot(generation: number): number {
    return generation % CALL_KEYRING_SIZE;
}

const b64 = z.string().max(4096).regex(/^[A-Za-z0-9+/=]*$/);
const epoch = z.string().regex(/^\d{1,20}$/).nullable();

/** What a participant says about itself in `CALL_KEY_ATTRIBUTE`. */
export const callKeyAnnounceSchema = z.object({ v: z.literal(1), pub: b64, epoch });
export type CallKeyAnnounce = z.infer<typeof callKeyAnnounceSchema>;

/** One wrapped key, sent by the leader to one participant. */
export const callKeyMessageSchema = z.object({
    v: z.literal(1),
    gen: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    to: z.string().min(1).max(200),
    /** The leader's public key the wrap was made against. */
    pub: b64,
    /** The MLS epoch whose exporter secret salted the wrap, or null for none. */
    epoch,
    iv: b64,
    wrapped: b64
});
export type CallKeyMessage = z.infer<typeof callKeyMessageSchema>;

/** Parse an announcement attribute; null for anything that does not fit. */
export function readAnnounce(value: string | undefined): CallKeyAnnounce | null {
    if (!value) return null;
    try {
        const parsed = callKeyAnnounceSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Parse a key message; null for anything that does not fit. */
export function readKeyMessage(payload: Uint8Array): CallKeyMessage | null {
    if (payload.byteLength > 16_384) return null;
    try {
        const parsed = callKeyMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function toBase64(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** A per-call key pair; the private half never leaves this browser. */
export async function makeCallKeyPair(): Promise<{ pair: CryptoKeyPair; pub: string }> {
    const pair = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return { pair, pub: toBase64(raw) };
}

/** A fresh call key: 32 random bytes. */
export function makeCallKey(): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(32));
}

interface WrapContext {
    readonly room: string;
    readonly gen: number;
    readonly leader: string;
    readonly to: string;
    /** The conversation's MLS exporter secret for this room, when both ends share one epoch. */
    readonly bind: { readonly epoch: string; readonly secret: Uint8Array } | null;
}

/** Everything the wrap is bound to, so a wrap cannot be replayed into another call, slot or recipient. */
function wrapInfo(context: WrapContext): Uint8Array<ArrayBuffer> {
    const line = ["polaris/call-key/v1", context.room, String(context.gen), context.leader, context.to, context.bind?.epoch ?? "-"].join("\n");
    return new TextEncoder().encode(line);
}

async function wrapKey(own: CryptoKey, peerPub: string, context: WrapContext): Promise<CryptoKey> {
    const peer = await crypto.subtle.importKey("raw", fromBase64(peerPub), ECDH, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, own, 256);
    const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const salt = context.bind ? new Uint8Array(context.bind.secret) : new Uint8Array(32);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: wrapInfo(context) },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

/** Wrap `key` for one recipient. Made by the leader. */
export async function wrapCallKey(
    key: Uint8Array<ArrayBuffer>,
    leaderPair: CryptoKeyPair,
    leaderPub: string,
    recipientPub: string,
    context: WrapContext
): Promise<CallKeyMessage> {
    const wrapping = await wrapKey(leaderPair.privateKey, recipientPub, context);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: wrapInfo(context) }, wrapping, key)
    );
    return {
        v: 1,
        gen: context.gen,
        to: context.to,
        pub: leaderPub,
        epoch: context.bind?.epoch ?? null,
        iv: toBase64(iv),
        wrapped: toBase64(wrapped)
    };
}

/**
 * Open a key the leader wrapped for this browser. Null when it does not open:
 * the wrong recipient, another room, a tampered byte, or an MLS secret that
 * differs from the leader's.
 */
export async function unwrapCallKey(
    message: CallKeyMessage,
    ownPair: CryptoKeyPair,
    context: Omit<WrapContext, "gen" | "to">  & { readonly self: string }
): Promise<Uint8Array<ArrayBuffer> | null> {
    if (message.to !== context.self) return null;
    if ((message.epoch ?? null) !== (context.bind?.epoch ?? null)) return null;
    const full: WrapContext = { room: context.room, gen: message.gen, leader: context.leader, to: context.self, bind: context.bind };
    try {
        const wrapping = await wrapKey(ownPair.privateKey, message.pub, full);
        const opened = new Uint8Array(
            await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromBase64(message.iv), additionalData: wrapInfo(full) },
                wrapping,
                fromBase64(message.wrapped)
            )
        );
        return opened.byteLength === 32 ? opened : null;
    } catch {
        return null;
    }
}

/**
 * Whether the leader should draw a new key: the set of participants it can
 * hand one to changed since the last generation. Order does not matter.
 */
export function membershipChanged(previous: ReadonlySet<string> | null, current: ReadonlySet<string>): boolean {
    if (!previous || previous.size !== current.size) return true;
    for (const identity of current) if (!previous.has(identity)) return true;
    return false;
}
