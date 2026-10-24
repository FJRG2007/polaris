/**
 * Games as the dashboard sees it: nothing runs in the background. Its screens
 * live under `/games`, and a game's page is a bundle asset loaded only when
 * somebody opens it, so an instance where nobody plays pays nothing for it.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

export const arcadeExtension: AppExtension = {
    id: "arcade",
    // The games a call can play together, named for the reader. Loaded when a
    // call asks, so nothing of the registry or the messages rides along with
    // the extension.
    async callActivities(locale) {
        const [{ GAMES, gameFrameSrc }, { arcadeCatalogs }] = await Promise.all([
            import("../games/registry"),
            import("../../messages")
        ]);
        const t = arcadeCatalogs.translator(locale, "arcade");
        return GAMES.filter((game) => game.multiplayer).map((game) => ({
            id: game.id,
            name: t(`games.${game.id}.name` as never),
            src: gameFrameSrc(game)
        }));
    }
};
