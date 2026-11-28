/**
 * Hospitality as the dashboard sees it: screens under `/hospitality` and the
 * live channel under `/api/hospitality/stream`, both served from its routes.
 * No scheduled job and nothing at boot: a venue with nobody working costs
 * nothing.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

export const hospitalityExtension: AppExtension = {
    id: "hospitality"
};
