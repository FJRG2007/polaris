/**
 * The encryption policy's rule and numbers, with no imports, so a screen can
 * read them as well as the server (`encryption-policy.ts` applies them;
 * docs/chat-e2ee-mls.md, "Encryption policy").
 */

/**
 * The one switch for the public, not end-to-end encrypted mode. Off: every
 * conversation is sealed when sealed chat is on (the behaviour before this
 * policy), no channel is labelled public, and the sweep is a no-op. Turned on
 * by changing this constant in a release, like `CHAT_E2EE_DEFAULT_ON`: no
 * install sets anything.
 */
export const PUBLIC_CHANNELS_OPEN = false;

/**
 * The most people a sealed conversation holds. The measured ceiling is the
 * MLS tree's: 64 parts of 512 KiB at about 2.66 KB per member once paths are
 * filled, some 12,600 members (docs/chat-e2ee-mls.md, row 12). 10,000 leaves
 * a fifth of it as margin. Past it a join is refused, the way Signal and
 * WhatsApp refuse an add into a full group; the conversation never stops
 * sealing and is never turned public for it.
 */
export const SEALED_MEMBER_CAP = 10_000;

/** Where whoever runs a sealed conversation is warned that it is filling up. */
export const SEALED_WARN_AT = Math.floor(SEALED_MEMBER_CAP * 0.8);

export type EncryptionMode = "sealed" | "open";

/** What the join rule of a conversation is read from. */
export interface JoinRule {
    readonly kind: string;
    readonly private: boolean;
    /** The space's visibility, or null for a conversation outside a space. */
    readonly spaceVisibility: string | null;
}

/**
 * A conversation's mode from its join rule. Open only for a space channel
 * that is not private in an `internal` space - the one place anybody joins
 * with no invitation and no approval - and only while the public mode is on.
 */
export function encryptionModeOf(rule: JoinRule, publicOpen: boolean = PUBLIC_CHANNELS_OPEN): EncryptionMode {
    if (!publicOpen) return "sealed";
    if (rule.kind === "dm" || rule.kind === "group" || rule.private) return "sealed";
    return rule.spaceVisibility === "internal" ? "open" : "sealed";
}

/** What a join of `adding` people into a sealed conversation holding `current` comes to. */
export function seatsAfter(current: number, adding: number): { readonly refused: boolean; readonly warn: boolean } {
    const after = current + adding;
    return { refused: adding > 0 && after > SEALED_MEMBER_CAP, warn: current < SEALED_WARN_AT && after >= SEALED_WARN_AT && after <= SEALED_MEMBER_CAP };
}
