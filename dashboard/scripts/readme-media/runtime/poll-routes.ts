/**
 * The timed reads that moved from a server action to a route (`lib/poll-route`).
 *
 * Each route runs the action it replaced with the query's values as its
 * arguments, so a scene that already answers the action answers the route the
 * same way: the harness finds the route here, calls the scene's handler for the
 * action, and sends the result in the wire format `readPoll` reads. A route
 * whose action the scene does not answer is still reported as missing.
 *
 * The argument names are the route's query keys, in the order its action takes
 * them (see each `apps/web/src/app/api/.../route.ts`).
 */

import { toWire } from "@/lib/app-bundles/wire";

const POLL_ROUTES: Record<string, { action: string; args: readonly string[] }> = {
    "/api/account/step-up/remaining": { action: "stepUpRemainingAction", args: ["purpose"] },
    "/api/admin/own-vulnerabilities": { action: "ownVulnerabilitiesAction", args: [] },
    "/api/apps/installed/redeploy-strategy": {
        action: "redeployStrategyAction",
        args: ["installId"]
    },
    "/api/chat/calls-unavailable": { action: "callsUnavailableAction", args: [] },
    "/api/chat/elsewhere": { action: "conversationsElsewhereAction", args: [] },
    "/api/chat/meeting-list": { action: "listMeetingsAction", args: [] },
    "/api/chat/profile": { action: "profileAction", args: ["channelId", "userId"] },
    "/api/chat/rules": { action: "chatRulesAction", args: [] },
    "/api/deploy/freshness": { action: "deployFreshnessAction", args: ["applicationId"] },
    "/api/deploy/image-update": { action: "imageUpdateAction", args: ["applicationId"] },
    "/api/deploy/services/follow-state": {
        action: "serviceFollowStateAction",
        args: ["applicationId"]
    },
    "/api/deploy/services/history": { action: "serviceHistoryAction", args: ["applicationId"] },
    "/api/drive/jobs": { action: "driveJobsAction", args: ["connectionId", "folder"] },
    "/api/drive/transfers/sent": { action: "sentTransfersAction", args: [] },
    "/api/drive/transfers/waiting": { action: "waitingTransfersAction", args: [] },
    "/api/marketplace/install-targets": { action: "listInstallTargetsAction", args: [] },
    "/api/marketplace/storage-connections": {
        action: "listStorageConnectionsAction",
        args: []
    },
    "/api/office/google-link": { action: "officeGoogleLinkAction", args: ["documentId"] },
    "/api/tasks/detail": { action: "getTaskDetailAction", args: ["taskId"] },
    "/api/vault/item-uses": { action: "itemUsesAction", args: ["itemId"] }
};

/**
 * The scene's answer to a GET of one of these routes, or `null` when the path is
 * not one of them or the scene does not answer its action.
 */
export async function pollAnswer(url: URL): Promise<{ value: unknown } | null> {
    const route = POLL_ROUTES[url.pathname];
    const handler = route && globalThis.__ACTIONS__?.[route.action];
    if (!route || !handler) return null;
    // An absent query value reaches the action as `undefined`, as the route's
    // optional fields do.
    const args = route.args.map((name) => url.searchParams.get(name) ?? undefined);
    return { value: toWire(await handler(...args)) };
}
