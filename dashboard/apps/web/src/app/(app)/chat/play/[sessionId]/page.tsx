/**
 * A game lobby, opened from an invitation, a card or somebody's "Join game".
 *
 * The server hands over the id and nothing else; whether the reader may be in
 * it is decided by the action the client calls (`lobby-actions`).
 */

import { GameLobby } from "@/app/(app)/chat/game-lobby";

export const dynamic = "force-dynamic";

export default async function GameLobbyPage({
    params
}: {
    params: Promise<{ sessionId: string }>;
}) {
    const { sessionId } = await params;
    return <GameLobby sessionId={sessionId} />;
}
