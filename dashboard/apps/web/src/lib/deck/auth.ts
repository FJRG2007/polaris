/**
 * Who a Stream Deck request acts as.
 *
 * Only a key of kind "streamdeck" - the one the deck's own connection minted -
 * opens these routes. A key made for a pipeline or the CLI is wired into
 * something else, and a deck API that took any key would be one more way for
 * it to reach chat and Places that nobody approved it for.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { DeckCaller } from "./types";
import type { DeckWords } from "./deck-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { translatorFor } from "@/lib/i18n/translate";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { getUserLocale } from "@/lib/i18n/locale-service";

/** Presses and reads one deck may make in a minute: a person mashing keys on
 *  a 32-key deck, far short of a loop. */
export const DECK_CALL_LIMIT = 240;
const DECK_WINDOW_MS = 60_000;

/** The words a deck's owner reads, in their own language: the deck has none. */
export function deckWords(caller: Pick<DeckCaller, "locale">): DeckWords {
    return translatorFor(caller.locale, "api") as unknown as DeckWords;
}

/**
 * Resolve the deck, or the Response to send back. `bucket` names the throttle
 * the call counts against, so the stream's reconnects do not eat the presses.
 */
export async function deckCaller(
    request: Request,
    bucket: "call" | "stream"
): Promise<DeckCaller | Response> {
    const principal = await authenticateApiKey(request);
    if (!principal || principal.kind !== "streamdeck") {
        const t = translatorFor("en-US", "api");
        return Response.json({ error: t("errors.unauthorized") }, { status: 401 });
    }
    const user = await prisma.user.findUnique({
        where: { id: principal.userId },
        select: { isAdmin: true }
    });
    const locale = await getUserLocale(principal.userId);
    const words = translatorFor(locale, "api");
    if (!user) return Response.json({ error: words("errors.unauthorized") }, { status: 401 });

    const limit = bucket === "call" ? DECK_CALL_LIMIT : 30;
    const throttle = await rateLimit(`deck-${bucket}:${principal.keyId}`, limit, DECK_WINDOW_MS);
    if (!throttle.ok) {
        return Response.json(
            { error: words("deck.errors.throttled") },
            {
                status: 429,
                headers: { "retry-after": String(Math.ceil(throttle.retryAfterMs / 1000)) }
            }
        );
    }

    return {
        userId: principal.userId,
        isAdmin: user.isAdmin,
        keyId: principal.keyId,
        scopes: principal.scopes,
        locale
    };
}
