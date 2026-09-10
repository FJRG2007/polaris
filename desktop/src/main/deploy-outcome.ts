/**
 * How a finished deployment is announced. Pure, for the tests.
 *
 * The statuses are the dashboard's own (`lib/deploy/status.ts`): a deployment
 * that ends `running` or `success` is serving; every other final state is a
 * failure worth a notice. The words match the dashboard's alert for the same
 * event (`lib/notifications/deploy-events.ts`), so the notice pushed from here and
 * the one the dashboard raises read the same.
 */

const SERVING = new Set(["running", "success"]);

export interface Outcome {
    readonly ok: boolean;
    readonly title: string;
    readonly body: string;
}

/** The first line of a failure, short enough for a notice. */
export function firstLine(error: string | null | undefined): string {
    const line = (error ?? "")
        .split("\n")
        .map((part) => part.trim())
        .find((part) => part.length > 0);
    if (!line) return "No reason was reported. Open the deploy log for the detail.";
    return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

export function deployOutcome(service: string, status: string, error: string | null | undefined): Outcome {
    return SERVING.has(status)
        ? { ok: true, title: `Deployed ${service}`, body: `${service} is serving the new release.` }
        : { ok: false, title: `Deploy failed: ${service}`, body: firstLine(error) };
}
