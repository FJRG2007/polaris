/**
 * The scheduled pass over the mail servers Polaris runs: whether each still
 * answers, and the DMARC reports that arrived since the last pass.
 *
 * Asks first whether the Mail server app is installed at all, and stops there
 * when it is not - one cached lookup, so a Polaris that never installed it pays
 * nothing every quarter of an hour for a feature it does not have.
 *
 * Server-only.
 */

import { sweepMailServers } from "./health";
import { collectAllReports } from "./dmarc-report";
import { mailServerAppInstalled } from "./app-install";

export type MailServerPass =
    | { readonly skipped: "not installed" }
    | { readonly checked: number; readonly changed: number; readonly filed: number };

export async function runMailServerPass(): Promise<MailServerPass> {
    if (!(await mailServerAppInstalled())) return { skipped: "not installed" };
    const health = await sweepMailServers();
    const reports = await collectAllReports();
    return { ...health, filed: reports.filed };
}
