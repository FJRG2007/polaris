/**
 * Cloud servers as the dashboard sees it: its screen is a section of Servers,
 * `/apps/servers/cloud`, and it runs one job - an hourly read of what each
 * server is doing and costs. Every Polaris has it; the job reads nothing until
 * a server was created at a connected account, and loads the service only
 * when it runs.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const MINUTE = 60_000;

export const cloudServersExtension: AppExtension = {
    id: "cloud-servers",
    jobs: () => [
        {
            key: "cloud-servers-refresh",
            // Prices change rarely and state is read live when the page asks,
            // so an hourly pass keeps the month's cost honest.
            everyMs: 60 * MINUTE,
            leaseMs: 30 * MINUTE,
            run: async () => (await import("./service")).refreshAll()
        }
    ]
};
