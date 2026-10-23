/**
 * The two ends of Polar in the browser extension's side panel.
 *
 * The side panel is an extension page that frames this deployment's own
 * `/polar/embed`, so the chat in it is always the one this Polaris serves - a
 * dashboard update reaches it with no extension release. The page the person
 * has open travels from the panel to the frame by `postMessage`, and only after
 * they allowed it for that site in the panel; the frame never reaches into a
 * tab by itself.
 *
 * Both directions are checked here: the frame takes messages only from its
 * parent, only from the extension origin named in its address, and only in the
 * shape below. `next.config.mjs` writes the same origin pattern into the
 * page's `frame-ancestors`, and a test holds the two to each other.
 */

import { z } from "zod";
import { siteContextSchema, type SiteContext } from "@/lib/polar/shared";

/**
 * An extension's own origin: Chromium's 32-letter id (a-p) or Firefox's
 * per-install UUID. Nothing else may frame the embed.
 */
export const EXTENSION_ORIGIN_PATTERN =
    "chrome-extension://[a-p]{32}|moz-extension://[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const EXTENSION_ORIGIN = new RegExp(`^(?:${EXTENSION_ORIGIN_PATTERN})$`);

/** The panel's origin from the embed's `?ext=`, or null when it is not one. */
export function extensionOrigin(value: unknown): string | null {
    return typeof value === "string" && EXTENSION_ORIGIN.test(value) ? value : null;
}

/** What the panel's messages carry, so neither end answers anybody else's. */
export const FROM_EXTENSION = "polaris-extension";
export const FROM_EMBED = "polaris-embed";

const pageMessage = z.object({
    source: z.literal(FROM_EXTENSION),
    kind: z.literal("page"),
    page: z.unknown()
});

/**
 * The page a message from the panel hands over: the site context, null for
 * "nothing to share" (a browser page, a site not allowed, sharing stopped), or
 * undefined for a message that is not one of the panel's.
 */
export function pageFrom(data: unknown): SiteContext | null | undefined {
    const message = pageMessage.safeParse(data);
    if (!message.success) return undefined;
    if (message.data.page === null) return null;
    const page = siteContextSchema.safeParse(message.data.page);
    return page.success ? page.data : null;
}

/** Something asked from the extension's right-click menu: a quote for the
 *  composer, a question typed under it, or both. Nothing is sent by itself. */
export interface ExtensionAsk {
    readonly quote?: string;
    readonly draft?: string;
}

const askFields = {
    quote: z.string().max(4000).optional(),
    draft: z.string().max(2000).optional()
};

const askMessage = z.object({
    source: z.literal(FROM_EXTENSION),
    kind: z.literal("ask"),
    ...askFields
});

/** A question the panel hands the embed, or null for a message that is not one. */
export function askFrom(data: unknown): ExtensionAsk | null {
    const message = askMessage.safeParse(data);
    if (!message.success) return null;
    return { quote: message.data.quote, draft: message.data.draft };
}

const polarCommand = z.discriminatedUnion("action", [
    z.object({
        source: z.literal(FROM_EXTENSION),
        kind: z.literal("polar"),
        action: z.literal("toggle")
    }),
    z.object({
        source: z.literal(FROM_EXTENSION),
        kind: z.literal("polar"),
        action: z.literal("ask"),
        ...askFields
    })
]);

export type PolarCommand = z.infer<typeof polarCommand>;

/**
 * What the extension tells a Polaris page about its Polar: open or close it -
 * the extension's shortcut is the same Ctrl+J as the page's, and the browser
 * gives it to the extension first - or open it with something to ask. The
 * extension posts it into the page's own window, so a page only takes it from
 * itself, on its own origin; anything else, or any other shape, is null.
 */
export function polarCommandFrom(
    event: { data: unknown; origin: string; source: unknown },
    self: { location: { origin: string } }
): PolarCommand | null {
    if (event.source !== self || event.origin !== self.location.origin) return null;
    const command = polarCommand.safeParse(event.data);
    return command.success ? command.data : null;
}

/** The conversation a panel asked for by `?chat=`: a tab's own, or null for
 *  the one every tab shares. */
export function chatScope(value: unknown): string | null {
    return typeof value === "string" && /^tab-(?:[a-z0-9]{1,16}-)?\d{1,12}$/.test(value)
        ? value
        : null;
}

/** The embed asking the panel to read the page again, for a fresh selection. */
export const REFRESH_MESSAGE = { source: FROM_EMBED, kind: "refresh" } as const;

/**
 * Whether a click on this address should leave the frame: anything but the
 * embed itself. The rest of Polaris refuses to be framed, so following a link
 * in place would leave the panel on the browser's blocked-frame page.
 */
export function opensOutside(href: string, here: string): boolean {
    let url: URL;
    try {
        url = new URL(href, here);
    } catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const current = new URL(here);
    return !(url.origin === current.origin && url.pathname === current.pathname);
}

/**
 * The copy of a conversation the panel keeps for when this Polaris does not
 * answer: the extension draws it, read-only, in place of the frame. Bounded
 * here and again in the panel (`apps/extension/src/lib/polar-offline.ts`, held
 * to these by a test): the last messages of the one conversation on screen,
 * as plain text, and the account they belong to so another account signing in
 * on the same browser never reads them.
 */
export const SNAPSHOT_MESSAGES = 40;
export const SNAPSHOT_TEXT = 8000;
export const SNAPSHOT_TITLE = 120;

const snapshotMessage = z.object({
    source: z.literal(FROM_EMBED),
    kind: z.literal("snapshot"),
    account: z.string().min(1).max(64),
    conversation: z.object({
        id: z.string().min(1).max(64),
        title: z.string().max(SNAPSHOT_TITLE),
        at: z.number().int().nonnegative(),
        messages: z
            .array(
                z.object({
                    role: z.enum(["user", "assistant"]),
                    text: z.string().max(SNAPSHOT_TEXT)
                })
            )
            .max(SNAPSHOT_MESSAGES)
    })
});

export type ConversationSnapshot = z.infer<typeof snapshotMessage>;

export interface SnapshotLine {
    readonly role: string;
    readonly text: string;
}

/**
 * The message the embed hands the panel for a conversation, cut to the caps:
 * spoken lines only, empty ones dropped, the newest kept. Null when there is
 * nothing worth keeping.
 */
export function snapshotOf(
    account: string,
    conversation: { id: string; at: number; lines: readonly SnapshotLine[] }
): ConversationSnapshot | null {
    const messages = conversation.lines
        .filter((line) => (line.role === "user" || line.role === "assistant") && line.text.trim())
        .slice(-SNAPSHOT_MESSAGES)
        .map((line) => ({
            role: line.role as "user" | "assistant",
            text: line.text.trim().slice(0, SNAPSHOT_TEXT)
        }));
    if (!messages.length) return null;
    const first = messages.find((line) => line.role === "user") ?? messages[0]!;
    const parsed = snapshotMessage.safeParse({
        source: FROM_EMBED,
        kind: "snapshot",
        account,
        conversation: {
            id: conversation.id,
            title: first.text.replace(/\s+/g, " ").slice(0, SNAPSHOT_TITLE),
            at: Math.max(0, Math.floor(conversation.at)),
            messages
        }
    });
    return parsed.success ? parsed.data : null;
}

/** A snapshot message as the panel must find it, or null for anything else. */
export function snapshotFrom(data: unknown): ConversationSnapshot | null {
    const message = snapshotMessage.safeParse(data);
    return message.success ? message.data : null;
}
