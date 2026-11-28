/**
 * Hospitality as the dashboard sees it: screens under `/hospitality` and the
 * live channel under `/api/hospitality/stream`, both served from its routes,
 * a card for the Overview, and the automation steps its manifest declares
 * (`automationSteps`), run through the host. No scheduled job and nothing at
 * boot: a venue with nobody working costs nothing.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const cards = () => import("./overview-cards");

export const hospitalityExtension: AppExtension = {
    id: "hospitality",
    // The steps its manifest declares, done once the host has checked them.
    automationSteps: async () => (await import("./automation-steps")).hospitalitySteps,
    // Its Overview card, read only once somebody has it on screen.
    overviewWidgets: () => [
        {
            kind: "service",
            defaultSize: "md",
            permission: "hospitality.use",
            describe: async () => (await cards()).describe(),
            targets: async () => (await cards()).targets(),
            read: async (targets) => (await cards()).read(targets)
        }
    ]
};
