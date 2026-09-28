/**
 * Every catalog id that is a game server, for a query to filter on.
 *
 * The same manifest test as `isGameServerApp`, run over the catalog rather than
 * over the rows: asked in the database, an owner with thirty other apps does not
 * load thirty configs to throw them away every few seconds.
 */

import { host } from "@polaris/app-host";

const { catalogApps, isGameServerApp } = host.appsCatalog;

export function gameServerCatalogIds(): string[] {
    return catalogApps()
        .filter((app) => isGameServerApp(app.id))
        .map((app) => app.id);
}
