/**
 * Translate as the dashboard sees it: an id and the translation it offers the
 * rest of Polaris. It runs no jobs and needs nothing at boot; its screen lives
 * under `/translate` and its API under `/api/translate`, served from its
 * routes - which is also what the selection menu and Chat call.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

export const translateExtension: AppExtension = {
    id: "translate",
    textTranslation: () => ({ appId: "translate", endpoint: "/api/translate", page: "/translate" })
};
