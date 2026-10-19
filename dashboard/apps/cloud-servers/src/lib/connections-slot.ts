/**
 * The Cloud servers section of a connections hub: the accounts connected for
 * the person reading, or for the organization whose hub it is, with Connect
 * and Remove for whoever may use them.
 *
 * `canManage` is the same answer the actions reach: Cloud servers itself
 * (`system.manage`) and, for an organization, managing its connections.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { listScopedAccounts, type AccountView } from "./service";

type AppSlot = AppHostTypes["AppSlot"];
type ConnectionsViewer = AppHostTypes["ConnectionsViewer"];

/** An account as the hub shows it. `lastError` is the provider's own words,
 *  kept for whoever may act on them; everybody else only learns it `failing`. */
export interface HubAccount extends AccountView {
    readonly failing: boolean;
}

/** What the section is drawn from. */
export interface CloudConnectionsProps {
    readonly accounts: HubAccount[];
    readonly orgId: string | null;
    readonly orgName: string | null;
    readonly canManage: boolean;
    readonly returnTo: string | null;
}

export async function cloudConnectionsSlot(viewer: ConnectionsViewer): Promise<AppSlot | null> {
    const user = await host.session.requireUser();
    const usesCloud = await host.session.sessionCan(user, "system.manage");
    const org = viewer.scope.kind === "org" ? viewer.scope : null;
    // A person who cannot open Cloud servers has nothing of it to connect. An
    // organization's roster still sees what was connected for it.
    if (!org && !usesCloud) return null;
    const accounts = await listScopedAccounts(viewer.userId, org?.orgId ?? null);
    const canManage = usesCloud && (org ? org.canManage : true);
    if (org && accounts.length === 0 && !canManage) return null;
    const props: CloudConnectionsProps = {
        accounts: accounts.map((account) => ({
            ...account,
            lastError: canManage ? account.lastError : null,
            failing: account.lastError !== null
        })),
        orgId: org?.orgId ?? null,
        orgName: org?.orgName ?? null,
        canManage,
        returnTo: viewer.returnTo
    };
    return { app: "cloud-servers", kind: "connections", props };
}
