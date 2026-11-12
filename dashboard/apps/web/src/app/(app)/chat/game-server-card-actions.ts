"use server";

/**
 * What the game server card in a conversation shows this reader. Read against
 * the reader's own standing on the server, never the sharer's: somebody whose
 * access ended sees that it did, and not the address.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import * as card from "@/lib/chat/game-server-card";
import { gameServerAccess } from "@/lib/apps/install-access";
import { gameServerCardFacts } from "@/lib/app-extensions/registry";

export async function readGameServerCard(
    installedAppId: unknown
): Promise<card.GameServerCardView | null> {
    const id = z.string().uuid().safeParse(installedAppId);
    if (!id.success) return null;
    const user = await requireUser();
    const access = await gameServerAccess(user, id.data, "games.read").catch(() => null);
    if (!access) return { state: "denied" };
    const facts = await gameServerCardFacts(access.ownerId, id.data);
    if (!facts) return { state: "denied" };
    return card.cardView(facts);
}
