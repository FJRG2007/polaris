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
        },
        {
            // The old workflows, moved to the central automations a few at a time.
            key: "crm-workflow-move",
            everyMs: MINUTE,
            leaseMs: 5 * MINUTE,
            run: async () => (await import("./automation-move")).moveCrmWorkflows()
        }
    ],
    // Its record triggers, checks and actions in the central automations engine.
    automationNodes: async () => (await import("./automation-central")).crmAutomationNodes(),
    // What a moved workflow ran before the move, read from the CRM's tables.
    automationHistory: async (legacyRef) =>
        (await import("./automation-move")).legacyRuns(legacyRef),
    // The central list narrowed to its automations: the chips' names and its New button.
    automationsFilter: async (ref) => (await import("./automation-filter")).automationsFilter(ref),
    favorites: async (userId) => (await import("./favorites")).railFavorites(userId),
    searchRecords: async (userId, query, limit) =>
        (await import("./records")).searchAllRecords(userId, query, limit)
};
