/**
 * The CRM as the dashboard sees it. It runs nothing on a schedule and draws
 * nothing in the dashboard's own screens yet: everything it is lives under
 * `/crm`, served from its routes.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

export const crmExtension: AppExtension = {
    id: "crm"
};
