/**
 * The games Polaris can run a server for.
 *
 * Kept in `@polaris/core` so that the Game servers app and the dashboard read
 * the same list without the app reaching into the dashboard: it is data, and
 * the host only offers functions. Re-exported here for the dashboard's own
 * modules, which have always imported it from this path.
 */

export {
    findGame,
    GAME_SERVERS_APP_ID,
    gameForCatalogId,
    gameOfServer,
    GAMES,
    isGameManagerApp,
    isGameServersApp,
    routesByHostname,
    type GameDefinition,
    type GameId
} from "@polaris/core";
