/**
 * Games as the dashboard sees it: nothing runs in the background. Its screens
 * live under `/games`, and a game's page is a bundle asset loaded only when
 * somebody opens it, so an instance where nobody plays pays nothing for it.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

export const arcadeExtension: AppExtension = { id: "arcade" };
