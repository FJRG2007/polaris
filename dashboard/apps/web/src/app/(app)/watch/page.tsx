/**
 * Watch: CloudWatch-style alarms over deployed apps and domains. Create alarms on
 * CPU/memory spikes or reachability; the evaluator raises an alert on state
 * transitions and logs each event here.
 *
 * Where those alerts go is not configured here. An alarm firing is one of the
 * events in the account's notification rules, so it is routed beside every other
 * alert Polaris raises - one place to decide what reaches a phone, rather than a
 * separate answer per feature. The view shows the current routing and links to
 * it.
 */

import { requirePermission } from "@/lib/session";
import { listAlarms, listAlarmTargets, listRecentAlarmEvents } from "@/lib/watch-service";
import { ruleFor } from "@/lib/notifications/preferences";
import { listDestinations } from "@/lib/notifications/destinations";
import { WatchView } from "./watch-view";

export const dynamic = "force-dynamic";

export default async function WatchPage() {
    const user = await requirePermission("deploy.read");
    const [alarms, events, targets, rule, destinations] = await Promise.all([
        listAlarms(user.id),
        listRecentAlarmEvents(user.id),
        listAlarmTargets(user.id),
        ruleFor(user.id, "watch.alarm"),
        listDestinations(user.id)
    ]);

    // Only the names of the destinations this event actually routes to travel to
    // the client; the rest of the list is the settings page's business.
    const routes = [
        ...(rule.inapp ? ["In-app"] : []),
        ...(rule.email ? ["Email"] : []),
        ...destinations.filter((entry) => rule.destinations.includes(entry.id)).map((entry) => entry.name)
    ];

    return <WatchView initialAlarms={alarms} initialEvents={events} targets={targets} routes={routes} />;
}
