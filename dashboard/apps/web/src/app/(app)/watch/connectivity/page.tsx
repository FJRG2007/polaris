/**
 * Watch > Connectivity (/watch/connectivity): how often this deployment lost its
 * connection or stopped being reachable from outside, and for how long.
 *
 * Administrators only - the same people the "cannot reach the internet" alert
 * goes to. The page awaits nothing but that check; the record is read by the view
 * after it has painted (`/api/watch/connectivity`), so a navigation here never
 * waits on the database.
 */

import { requireAdmin } from "@/lib/session";
import { ConnectivityView } from "./connectivity-view";

export const dynamic = "force-dynamic";

export default async function ConnectivityPage() {
    await requireAdmin();
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col">
            <ConnectivityView />
        </div>
    );
}
