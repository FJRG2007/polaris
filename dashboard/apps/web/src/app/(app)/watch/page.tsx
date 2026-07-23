/**
 * Watch: CloudWatch-style alarms over deployed apps and domains. Create alarms on
 * CPU/memory spikes or reachability; the evaluator fires notifications (and
 * optionally a channel message) on state transitions and logs each event here.
 */

import { requirePermission } from "@/lib/session";
import { listAlarms, listAlarmTargets, listRecentAlarmEvents } from "@/lib/watch-service";
import { WatchView } from "./watch-view";

export const dynamic = "force-dynamic";

export default async function WatchPage() {
    const user = await requirePermission("deploy.read");
    const [alarms, events, targets] = await Promise.all([
        listAlarms(user.id),
        listRecentAlarmEvents(user.id),
        listAlarmTargets(user.id)
    ]);
    return <WatchView initialAlarms={alarms} initialEvents={events} targets={targets} />;
}
