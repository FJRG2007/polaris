/**
 * The first-run setup: what somebody says Polaris is for, and the apps that
 * answer it.
 *
 * Only apps that install with one click are recommended - the ones that run
 * nothing until they are used (`installMethod: "builtin"`), so a fresh Polaris
 * never downloads anything heavy because a box was ticked. They are installed
 * through the same path the marketplace uses, one at a time.
 *
 * Offered once per deployment, to the first administrator who opens the
 * Overview of a new one (see `shouldOfferSetup`): whoever finishes or skips it
 * answers for everybody, and it stays reachable from Management afterwards. The mark lives in the instance settings
 * (`SETUP_MARK_KEY`).
 *
 * Pure and safe in the browser.
 */

import { z } from "zod";

export const SETUP_USE_CASES = ["hosting", "team", "games", "homelab"] as const;

export type SetupUseCase = (typeof SETUP_USE_CASES)[number];

/** The catalog apps the wizard can install, in the order it lists them. */
export const SETUP_APPS = [
    "status-pages",
    "security-scans",
    "cloud-servers",
    "calendar",
    "crm",
    "game-servers",
    "home",
    "tools"
] as const;

export type SetupApp = (typeof SETUP_APPS)[number];

/** What each use case recommends installing. */
export const USE_CASE_APPS: Readonly<Record<SetupUseCase, readonly SetupApp[]>> = {
    hosting: ["status-pages", "security-scans", "cloud-servers"],
    team: ["calendar", "crm"],
    games: ["game-servers"],
    homelab: ["home", "tools", "security-scans"]
};

/** The apps recommended for these use cases, each once, in the wizard's order. */
export function recommendApps(useCases: readonly SetupUseCase[]): SetupApp[] {
    const wanted = new Set(useCases.flatMap((useCase) => USE_CASE_APPS[useCase] ?? []));
    return SETUP_APPS.filter((app) => wanted.has(app));
}

/** The instance setting that records the setup was finished or skipped. */
export const SETUP_MARK_KEY = "setup.wizard";

export const SETUP_OUTCOMES = ["done", "skipped"] as const;

export const setupOutcomeSchema = z.enum(SETUP_OUTCOMES);

export const setupAppSchema = z.enum(SETUP_APPS);

/**
 * Whether the setup opens by itself for this viewer: an administrator, as
 * themselves rather than viewing as somebody else, on a deployment that is
 * still new - nobody has finished or skipped the setup, the viewer is its only
 * account, and no marketplace app is installed yet.
 *
 * The last two keep an established Polaris from being greeted with a first-run
 * screen after an Update: one with other accounts or with apps installed was
 * set up long before the setup existed, whatever its mark says. It is still
 * reachable from Management there.
 */
export function shouldOfferSetup({
    isAdmin,
    viewingAs,
    mark,
    accounts,
    appsInstalled
}: {
    isAdmin: boolean;
    viewingAs: boolean;
    /** The stored outcome, or null when there is none. */
    mark: string | null;
    /** How many accounts this Polaris has, counting the viewer. */
    accounts: number;
    /** Whether any marketplace app is installed. */
    appsInstalled: boolean;
}): boolean {
    return isAdmin && !viewingAs && mark === null && accounts <= 1 && !appsInstalled;
}

/** Where each install stands on the wizard's last step. */
export type InstallStatus = "waiting" | "installing" | "installed" | "failed";
