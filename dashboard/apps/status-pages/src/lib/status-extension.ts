/**
 * Status pages as the dashboard sees it: two scheduled jobs, and the routes for
 * pages served at a custom domain, written again at boot.
 * Its screens live under `/status-pages` and its public pages under `/status`,
 * served from its routes.
 *
 * Every job imports its service when it runs, not when this module loads, so
 * nothing of the app reaches the database until a job does.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const statusExtension: AppExtension = {
    id: "status-pages",

    jobs: () => [
        {
            key: "status-checks",
            // The shortest interval a check may ask for. A pass with nothing
            // due is one indexed query that returns no rows.
            everyMs: 30 * SECOND,
            // Leased: two passes would run the same checks twice and count each
            // run twice in the day's uptime.
            leaseMs: 2 * MINUTE,
            run: async () => (await import("./runner")).runDueChecks()
        },
        {
            key: "status-prune",
            everyMs: 60 * MINUTE,
            leaseMs: 10 * MINUTE,
            // Also writes the custom-domain routes again, so a file emptied or
            // lost by anything else is back within the hour.
            run: async () => {
                await (await import("./runner")).pruneStatusHistory();
                await (await import("./edge")).trySyncStatusEdge();
            }
        }
    ],

    // The custom-domain routes, written once at boot so they repair themselves
    // after an update. Not awaited: the server is still starting.
    onBoot: () => {
        void import("./edge").then((edge) => edge.trySyncStatusEdge());
    }
};
