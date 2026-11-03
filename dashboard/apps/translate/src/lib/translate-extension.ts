/**
 * Translate as the dashboard sees it: an id and nothing else. It runs no jobs
 * and needs nothing at boot; its screen lives under `/translate` and its API
 * under `/api/translate`, served from its routes.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

export const translateExtension: AppExtension = {
    id: "translate"
};
