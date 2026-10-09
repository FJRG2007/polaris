/** Game servers: every server, its players and its state, in one table. */

import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { GamesView } from "../../../apps/game-servers/src/screens/games-view";
import { gameFacts, gameLive, gameServers } from "../fixtures/games";

export const games = defineScene({
    id: "games",
    path: "/apps/games",
    api: (ctx) => ({
        "GET /api/apps/games": () => ({ servers: gameFacts(ctx) }),
        "GET /api/apps/games/live": () => ({ servers: gameLive(ctx) })
    }),
    render: (ctx) => (
        <Chrome>
            <GamesView servers={gameServers(ctx)} installed canCreate />
        </Chrome>
    )
});
