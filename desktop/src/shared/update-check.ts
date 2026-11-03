/**
 * The answer to "Check for updates", pressed by somebody who wants to know now
 * rather than at the next six-hourly check. Pure, so the sentences are tested
 * without Electron.
 */

import { z } from "zod";

export const updateCheckSchema = z.discriminatedUnion("kind", [
    /** Nothing newer is out; `version` is the one running. */
    z.object({ kind: z.literal("current"), version: z.string().max(40) }),
    /** A newer version is being downloaded and installed. */
    z.object({ kind: z.literal("downloading"), version: z.string().max(40) }),
    /** Installed; it opens on the next start, or now with a restart. */
    z.object({ kind: z.literal("ready"), version: z.string().max(40) }),
    /** Out, but this copy cannot install it itself: its page has the download. */
    z.object({ kind: z.literal("available"), version: z.string().max(40) }),
    /** The question could not be asked; `reason` says why, in words. */
    z.object({ kind: z.literal("failed"), reason: z.string().max(300) }),
    /** A build that does not update itself, such as one run from the source. */
    z.object({ kind: z.literal("unsupported") })
]);

export type UpdateCheck = z.infer<typeof updateCheckSchema>;

/** What a page was handed, or a failure when it is not one of the answers. */
export function readUpdateCheck(raw: unknown): UpdateCheck {
    const parsed = updateCheckSchema.safeParse(raw);
    return parsed.success ? parsed.data : { kind: "failed", reason: "Polaris did not answer." };
}

/** The sentence under the button. */
export function describeUpdateCheck(check: UpdateCheck): string {
    switch (check.kind) {
        case "current":
            return `Polaris ${check.version} is the newest version.`;
        case "downloading":
            return `Downloading Polaris ${check.version}. It installs by itself; you can keep working.`;
        case "ready":
            return `Polaris ${check.version} is installed. Restart Polaris to start using it.`;
        case "available":
            return `Polaris ${check.version} is available. This copy cannot install it by itself: download it from its page.`;
        case "failed":
            return `Could not check for updates. ${check.reason}`;
        case "unsupported":
            return "This copy of Polaris does not update itself.";
    }
}
