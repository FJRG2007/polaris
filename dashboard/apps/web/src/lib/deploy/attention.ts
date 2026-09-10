/**
 * What on a service needs somebody to look at it: its last deploy failed, one of
 * its addresses is down, or a scheduled job's last run failed.
 *
 * One definition for every place that draws the dot - the service's own tabs and
 * the project's section rail - so they never disagree about whether a service is
 * fine. Pure, so a client component can ask it too; the rows it is read from are
 * loaded by `serviceAttention` in `project-glance.ts`.
 */

export interface ServiceAttention {
    /** Its newest deployment failed (the release before it may still be serving). */
    deployFailed: boolean;
    /** An enabled address of its own that the health probe found down. */
    domainDown: boolean;
    /** An enabled scheduled job whose last run failed or timed out. */
    cronFailing: boolean;
}

/** Deployment states that end a deploy that did not ship. */
export const FAILED_DEPLOY_STATUSES: readonly string[] = ["failed", "rolled_back"];

/** Scheduled-job run states that count as failing. */
export const FAILED_CRON_STATUSES: readonly string[] = ["failed", "timed_out"];

/** Whether anything on the service needs a look. */
export function needsAttention(attention: ServiceAttention | null | undefined): boolean {
    return Boolean(
        attention && (attention.deployFailed || attention.domainDown || attention.cronFailing)
    );
}

/** The same, as the words a tooltip says. */
export function attentionReasons(attention: ServiceAttention | null | undefined): string[] {
    if (!attention) return [];
    return [
        attention.deployFailed ? "last deploy failed" : null,
        attention.domainDown ? "an address is down" : null,
        attention.cronFailing ? "a scheduled job is failing" : null
    ].filter((reason): reason is string => reason !== null);
}
