/**
 * Who may read this deployment's connectivity record.
 *
 * Administrators, who receive the "cannot reach the internet" alert it records,
 * and anybody one of them shared it with (`watch.connectivity`, a grant over
 * the one record there is). A grant reads; checking now and the merge window
 * stay with administrators.
 *
 * What somebody it was shared with is sent is the record without the parts that
 * name this network: which probe noticed, the error it got, the address that
 * answered first. Whether and how long the line was down is what was shared.
 */

import * as core from "@polaris/core";
import type { SessionUser } from "@/lib/session";
import { grantedCapability } from "@/lib/access/grants";
import type { ConnectivityReport, OutageView } from "@/lib/connectivity/outage-tracker";

/** How a viewer reaches the record: as an administrator, through a share, or not. */
export type ConnectivityReach = "admin" | "shared" | null;

export async function connectivityReach(
    user: Pick<SessionUser, "id" | "isAdmin">
): Promise<ConnectivityReach> {
    if (user.isAdmin) return "admin";
    const held = await grantedCapability(
        user.id,
        "watch.connectivity",
        core.WATCH_CONNECTIVITY_ID
    );
    return core.atLeast("watch.connectivity", held, "view") ? "shared" : null;
}

function plain(outage: OutageView): OutageView {
    return { ...outage, detectedBy: null, detail: null, firstBack: null, closedBy: null };
}

/** The record as anybody but an administrator is sent it. */
export function sharedConnectivityReport(report: ConnectivityReport): ConnectivityReport {
    return {
        ...report,
        open: report.open ? plain(report.open) : null,
        outages: report.outages.map(plain)
    };
}
