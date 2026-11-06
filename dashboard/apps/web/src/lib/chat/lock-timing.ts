/**
 * How long locked chats stay open after the code, and how long the code is.
 *
 * Pure, so the server that signs an unlock proof and the tab that keeps it read
 * the same rule. The reader picks the duration, the way Vault's auto-lock is
 * picked: right away, a number of minutes, or until the browser closes. The
 * window slides - using the open locked chat pushes it on - so it never runs out
 * in the middle of a conversation somebody is having.
 */

/** "Until the browser closes": the proof lives as long as the tab's storage. */
export const UNLOCK_UNTIL_CLOSED = -1;

/** "Immediately": open only while the conversation is on screen. */
export const UNLOCK_IMMEDIATELY = 0;

/** The choices, in minutes, in the order the setting lists them. */
export const CHAT_UNLOCK_CHOICES = [
    UNLOCK_IMMEDIATELY,
    1,
    5,
    15,
    30,
    60,
    UNLOCK_UNTIL_CLOSED
] as const;

/** What a person who never chose gets: how the lock behaved before the choice. */
export const DEFAULT_UNLOCK_MINUTES = UNLOCK_UNTIL_CLOSED;

/** How long a proof answers when it is kept until the browser closes. A tab
 *  session rarely outlives it, and one that does asks for the code again. */
const UNTIL_CLOSED_TTL_MS = 12 * 60 * 60_000;

/** "Immediately" still needs a proof while the chat is on screen; the open chat
 *  renews it, and leaving the chat throws it away. */
const ON_SCREEN_TTL_MS = 2 * 60_000;

/** Never renew more often than this, whatever the duration. */
const MIN_RENEW_MS = 10_000;

/** Renew at least this often, so a long duration still slides. */
const MAX_RENEW_MS = 60_000;

/** A stored or typed value read as one of the choices; anything else is the default. */
export function unlockMinutesOf(value: unknown): number {
    return typeof value === "number" && (CHAT_UNLOCK_CHOICES as readonly number[]).includes(value)
        ? value
        : DEFAULT_UNLOCK_MINUTES;
}

/** How long a proof minted under this choice answers. */
export function proofTtlMs(minutes: number): number {
    const choice = unlockMinutesOf(minutes);
    if (choice === UNLOCK_UNTIL_CLOSED) return UNTIL_CLOSED_TTL_MS;
    if (choice === UNLOCK_IMMEDIATELY) return ON_SCREEN_TTL_MS;
    return choice * 60_000;
}

/** How often an open locked chat renews its proofs, a third of the way in. */
export function renewEveryMs(minutes: number): number {
    return Math.min(MAX_RENEW_MS, Math.max(MIN_RENEW_MS, Math.floor(proofTtlMs(minutes) / 3)));
}

/** When a proof stops answering, read from its own expiry; null when it is not one. */
export function proofExpiresAt(proof: string | null | undefined): number | null {
    if (!proof) return null;
    const expires = proof.split(".")[0];
    return expires && /^\d{10,16}$/.test(expires) ? Number(expires) : null;
}

/** Whether a kept proof is still worth presenting. */
export function proofLive(proof: string | null | undefined, now = Date.now()): boolean {
    const expires = proofExpiresAt(proof);
    return expires !== null && expires > now;
}

/**
 * Whether the open locked chat should renew now: the reader did something since
 * the last renewal, or, under "immediately", the chat is simply on screen - that
 * choice only ends when the reader leaves.
 */
export function shouldRenew(input: {
    minutes: number;
    lastActivity: number;
    lastRenew: number;
    visible: boolean;
}): boolean {
    if (unlockMinutesOf(input.minutes) === UNLOCK_IMMEDIATELY) return input.visible;
    return input.lastActivity > input.lastRenew;
}

/** The lengths a chat lock code is set with. */
export const LOCK_CODE_LENGTHS = [4, 6, 8] as const;

/** What a new code gets when nobody chose. */
export const DEFAULT_LOCK_CODE_LENGTH = 6;

/** A stored length the entry box can wait for; null means "submit with a button"
 *  - a code set before lengths were recorded, of whatever length it has. */
export function knownCodeLength(value: unknown): number | null {
    return typeof value === "number" && (LOCK_CODE_LENGTHS as readonly number[]).includes(value)
        ? value
        : null;
}
