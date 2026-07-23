/**
 * The normalized messaging domain, shared by the web control plane and the
 * bridge. Platform specifics never leak past the adapters: everything above them
 * speaks these types.
 */

export type Platform = "telegram" | "whatsapp" | "discord" | "slack";

/** WhatsApp has two selectable backends with very different trade-offs. */
export type WhatsAppProvider = "whatsapp-web" | "whatsapp-cloud";

/** How a channel is brought online. */
export type OnboardingMode = "token" | "qr" | "code" | "oauth";

/** What a connected channel can do, so an interactive prompt renders natively
 *  where possible and degrades predictably where not. */
export interface ChannelCapabilities {
    nativeButtons: boolean;
    nativeSelects: boolean;
    /** Native polls (a WhatsApp/Telegram selector substitute). */
    polls: boolean;
    media: boolean;
    /** Pre-approved template messages (WhatsApp Cloud). */
    templates: boolean;
    /** Non-official client that can be blocked by the platform. */
    banRisk: boolean;
    /** Runs a headless browser (whatsapp-web) - heavy, one per number. */
    needsBrowser: boolean;
    onboarding: OnboardingMode;
}

export type MessageKind = "text" | "image" | "file" | "audio" | "interactive" | "system";

/** A message arriving from a platform, normalized by an adapter. */
export interface InboundMessage {
    channelId: string;
    /** Platform-side chat/peer id, unique within the channel. */
    peerId: string;
    peerName?: string;
    /** Platform-side message id, for acks and dedup. */
    externalId?: string;
    kind: MessageKind;
    body?: string;
    /** For an interactive reply (button press / poll vote): the chosen option id. */
    selection?: string;
    /** Epoch milliseconds. */
    at: number;
}

/** A single choice offered to a contact. */
export interface InteractiveOption {
    /** Stable id echoed back as `selection` when chosen. */
    id: string;
    label: string;
}

/** "Offer these options" - rendered as native buttons/selects, or a poll /
 *  numbered menu where the channel lacks them. */
export interface InteractivePrompt {
    text: string;
    options: InteractiveOption[];
    /** Force a rendering; otherwise the adapter picks by capability. */
    style?: "buttons" | "poll";
}

/** A message the web asks the bridge to send. */
export interface OutboundMessage {
    peerId: string;
    text?: string;
    interactive?: InteractivePrompt;
}
