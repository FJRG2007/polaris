/**
 * What Watch's services write in English, in the reader's words.
 *
 * The alarm evaluator stores the reading it judged on as a sentence, the schema
 * and the service refuse in English, and the breakdown and overview services
 * name rows and states the same way - all of it also read by tests and logs. The
 * screens say it through the `watch` catalog instead: a known sentence by its
 * key, a shaped one with its values carried over, and anything else - a
 * container's status, a probe's own reason - as it came.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { ALARM_METRICS, alarmUnit, formatThreshold, METRIC_LABEL } from "@/lib/watch/alarm-metrics";

type WatchKey = NamespaceKey<"watch">;
type WatchWords = NamespaceTranslator<"watch">;

/** Every sentence said word for word, by its English. */
export const WATCH_SENTENCES: Readonly<Record<string, WatchKey>> = {
    // What the evaluator judged an alarm on.
    "Domain not found": "text.domainNotFound",
    "Not checked yet": "text.notCheckedYet",
    unreachable: "text.unreachable",
    reachable: "text.reachable",
    "App not found": "text.appNotFound",
    "stopped (not expected up)": "text.stoppedNotExpected",
    "asleep (wakes on the next visit)": "text.asleep",
    running: "text.running",
    "no recent metrics (down?)": "text.noRecentMetricsDown",
    "unknown metric": "text.unknownMetric",
    "no recent metrics": "text.noRecentMetrics",
    "this server's disk is not measured": "text.diskNotMeasured",
    "metric unavailable": "text.metricUnavailable",
    "the service has no volumes": "text.serviceNoVolumes",
    "no recent volume measurement": "text.noRecentVolume",
    // What the schema and the service refuse with.
    "Domains use the http reachability metric": "text.domainsUseHttp",
    "That metric cannot be watched on this target": "text.metricNotOnTarget",
    "A percentage threshold is at most 100": "text.percentMax",
    "The selected server was not found": "text.serverNotFound",
    "The selected app was not found": "text.appNotSelected",
    "The selected domain was not found": "text.domainNotSelected",
    "Alarm not found": "text.alarmNotFound",
    // A metric taken apart.
    "That window has no time in it": "text.noWindow",
    "You can see this server's figures, but not what is on the machine itself.": "text.notYours",
    "A service is one container, so this figure has no parts to show.": "text.oneContainer",
    "Polaris measures the disk of the machine it runs on. It cannot see this one's.": "text.diskOnlyLocal",
    "Nothing is running on this server right now.": "text.nothingRunning",
    "This server would not say what its containers are using.": "text.containersSilent",
    "Idle, and anything outside a container": "text.idleOutside",
    "Free, and anything outside a container": "text.freeOutside",
    "The machine itself, and whatever is installed on it directly.": "text.machineItself",
    "Measured from the containers this server is running. The chart above is the whole machine, so anything outside a container is the last row.":
        "text.loadNote",
    "Polaris could not read this server just now.": "text.serverUnread",
    Images: "text.images",
    "What every deployed service runs from.": "text.imagesDetail",
    "Build cache": "text.buildCache",
    "Comes back on the next build.": "text.buildCacheDetail",
    Containers: "text.containers",
    "What running services wrote outside a volume.": "text.containersDetail",
    "This machine would not say what it is holding.": "text.storageSilent",
    "Nothing on this machine uses it": "text.volumeUnused",
    "Polaris has no record of this one": "text.volumeUnknown",
    "Everything else on this machine": "text.everythingElse",
    "The system itself and anything installed outside Polaris.": "text.systemItself",
    "Volumes are measured one by one. Nothing here is removed for you.": "text.volumesNote",
    "The volumes on this machine could not be listed, so only the store is broken out.": "text.volumesUnlisted",
    "That service is not here any more.": "text.serviceGone",
    "This service has no volumes, so it stores nothing of its own.": "text.serviceNoVolumesNote",
    "Nothing has measured this service's volumes yet. They are read on a slower cadence than the chart.":
        "text.volumesUnmeasured",
    "Measured from inside the service, which is the one place every kind of volume resolves to a path.":
        "text.serviceStorageNote",
    "Nothing was recorded for long enough in this window to say what sent it. A wider range will have more to go on.":
        "text.nothingSent",
    "Containers Polaris did not deploy, and the machine's own traffic.": "text.otherTraffic",
    "Averaged over the window on the chart, from what each service's own container counted. A service read only once in the window has no rate and is left out.":
        "text.trafficNote",
    "There is nothing to break down over that window.": "text.nothingToBreakDown",
    "Polaris could not work out what is using this just now.": "text.breakdownFailed",
    // A card's state and where it is.
    "No data yet": "text.noDataYet",
    Reporting: "text.reporting",
    "Stopped reporting": "text.stoppedReporting",
    Deploying: "text.deploying",
    "Not deployed": "text.notDeployed",
    "The machine Polaris runs on": "text.thisMachine"
};

/** Sentences with a value inside, and the names the catalog gives those values. */
const SHAPED: readonly (readonly [RegExp, WatchKey, readonly string[]])[] = [
    [/^A threshold in (.+) is required for this metric$/, "text.thresholdRequired", ["unit"]],
    [/^Belongs to (.+)$/s, "text.belongsTo", ["owner"]],
    [/^Mounted at (.+)$/s, "text.mountedAt", ["path"]],
    [/^Polaris - (.+)$/s, "text.polarisPart", ["part"]],
    [/^(.+) - the machine Polaris runs on$/s, "text.thisMachineAt", ["address"]]
];

/** A known sentence in the reader's words, or null when it is not one of Watch's. */
export function knownWatchText(t: WatchWords, message: string): string | null {
    const key = WATCH_SENTENCES[message];
    if (key) return t(key);
    for (const [pattern, shapedKey, names] of SHAPED) {
        const match = pattern.exec(message);
        if (!match) continue;
        const params: Record<string, string> = {};
        names.forEach((name, index) => {
            params[name] = match[index + 1] ?? "";
        });
        return t(shapedKey, params);
    }
    // A reading against its threshold: "CPU 91.2% (threshold > 90%)".
    const reading = /^(.+) \(threshold ([<>] .+)\)$/.exec(message);
    if (reading?.[1] && reading[2]) {
        const metric = ALARM_METRICS.find((entry) => reading[1]?.startsWith(`${METRIC_LABEL[entry]} `));
        if (metric) {
            const value = reading[1].slice(METRIC_LABEL[metric].length + 1);
            return t("text.reading", { metric: metricWord(t, metric), value, threshold: reading[2] });
        }
    }
    return null;
}

/** A sentence from Watch's services in the reader's words; anything else as it came. */
export function watchText(t: WatchWords, message: string): string {
    return knownWatchText(t, message) ?? message;
}

/** What a metric is called. An id the catalog does not know shows as stored. */
export function metricWord(t: WatchWords, metric: string): string {
    if (!(ALARM_METRICS as readonly string[]).includes(metric)) return metric;
    return t(`labels.metric.${metric === "network_in" ? "networkIn" : metric === "network_out" ? "networkOut" : metric}` as WatchKey);
}

/** An alarm's state as a badge says it. */
export function alarmStateWord(t: WatchWords, state: string): string {
    if (state === "ok" || state === "alarm" || state === "insufficient") return t(`labels.state.${state}`);
    return state;
}

/** "Disk > 90%", as `describeThreshold` writes it, in the reader's words. */
export function thresholdWords(
    t: WatchWords,
    alarm: { metric: string; targetType: string; operator: string; threshold: number }
): string {
    return t("labels.threshold", {
        metric: metricWord(t, alarm.metric),
        threshold: formatThreshold(alarm.operator, alarm.threshold, alarmUnit(alarm.metric, alarm.targetType))
    });
}
