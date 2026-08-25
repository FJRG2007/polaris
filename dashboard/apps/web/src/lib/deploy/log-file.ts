/**
 * Where a deploy's log lives, and the one way to write a line into it from
 * outside the runner.
 *
 * Its own module because both ends of the deploy need it. The runner streams the
 * build into this file; the GitHub announcement writes into the same file when
 * GitHub refuses one, and it runs before the runner has opened anything. Reaching
 * back into deploy-service for the path would be a cycle, and a second copy of
 * the path would be a log written to two different places.
 */

import { join } from "node:path";
import { loadEnv } from "@polaris/config";
import { appendFile, mkdir } from "node:fs/promises";

/** Directory the web process writes deploy log files to (tailed by the UI). */
export function deployLogDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "deploy-logs");
}

export function deployLogPath(deploymentId: string): string {
    return join(deployLogDir(), `${deploymentId}.log`);
}

/**
 * Put a line in front of whoever opens this deploy.
 *
 * The log is the only screen that says what happened to one deploy, so anything
 * its operator has to know goes here - a console line is a line nobody using
 * this product will ever see. Appended rather than written, so it takes its place
 * among the build output whether it is added before the build or during it.
 *
 * Best-effort: a note that could not be written is not a reason for the deploy
 * to stop.
 */
export async function noteOnDeploy(deploymentId: string, line: string): Promise<void> {
    try {
        await mkdir(deployLogDir(), { recursive: true });
        await appendFile(deployLogPath(deploymentId), `${line}\n`);
    } catch {
        // Nothing to fall back to, and nothing that depends on it.
    }
}
