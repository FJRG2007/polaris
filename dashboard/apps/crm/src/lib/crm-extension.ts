/**
 * The CRM as the dashboard sees it: everything it draws lives under `/crm`,
 * served from its routes, and it runs one job - the workflows whose schedule
 * has come round.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const MINUTE = 60_000;

export const crmExtension: AppExtension = {
    id: "crm",
    jobs: () => [
        {
            key: "crm-workflow-schedules",
            // Cron's own grain: a schedule names minutes.
            everyMs: MINUTE,
            // Leased so one pass at a time claims the due runs; each run is
            // claimed on its own as well, so an expired lease cannot run one twice.
            leaseMs: 5 * MINUTE,
            run: async () => (await import("./workflows")).runDueSchedules()
        }
    ],
    favorites: async (userId) => (await import("./favorites")).railFavorites(userId),
    searchRecords: async (userId, query, limit) =>
        (await import("./records")).searchAllRecords(userId, query, limit)
};
