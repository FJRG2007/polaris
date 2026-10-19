// The screens' timed reads go through routes (see `lib/poll-route`), each of
// which runs the server action the screen used to call. The screen tests drive
// what those reads return by mocking the action modules, so each poll module is
// replaced here by one that forwards to whatever the test file has for that
// action - mocked or not, exactly what the screen called before. The routes
// themselves are tested on their own.
import { vi } from "vitest";

type Loader = () => Promise<unknown>;

/** Call `name` from the module `load` imports, with the first `arity` arguments
 *  (the poll's trailing abort signal is not the action's). */
function forward(load: Loader, name: string, arity: number) {
    return async (...args: unknown[]) => {
        const loaded = (await load()) as Record<string, (...args: unknown[]) => unknown>;
        return loaded[name](...args.slice(0, arity));
    };
}

vi.mock("@/app/(app)/apps/deploy/deploy-polls", () => {
    const databases = () => import("@/app/(app)/apps/deploy/database-actions");
    return {
        databaseOverview: forward(databases, "databaseOverviewAction", 1),
        databaseProcesses: forward(databases, "listDatabaseProcessesAction", 1),
        cutoverPanel: forward(
            () => import("@/app/(app)/apps/deploy/dns-cutover-actions"),
            "cutoverPanelAction",
            1
        ),
        externalServiceStatus: forward(
            () => import("@/app/(app)/apps/deploy/external-actions"),
            "refreshExternalServiceAction",
            2
        ),
        projectGlance: forward(
            () => import("@/app/(app)/apps/deploy/glance-actions"),
            "projectGlanceAction",
            1
        ),
        deployments: forward(
            () => import("@/app/(app)/apps/deploy/actions"),
            "listDeploymentsAction",
            1
        ),
        promotions: forward(
            () => import("@/app/(app)/apps/deploy/project-actions"),
            "listPromotionsAction",
            1
        )
    };
});
