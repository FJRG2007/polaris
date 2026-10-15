/**
 * Security scans as the dashboard sees it: its screens under `/security`, and
 * one job that starts what is queued or due. Nothing runs between scans; the
 * job only reads a few indexed rows when there is nothing to do.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const MINUTE = 60_000;

export const securityExtension: AppExtension = {
    id: "security-scans",
    jobs: () => [
        {
            key: "security-scans-queue",
            everyMs: MINUTE,
            // A scan can run for a long while; the lease covers the longest.
            leaseMs: 4 * 60 * MINUTE,
            run: async () => (await import("./service")).tick()
        }
    ]
};
