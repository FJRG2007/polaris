/**
 * Whether this CLI and a Polaris speak the same API.
 *
 * The CLI is installed from the project's GitHub releases rather than from the
 * server, so the two are updated on their own schedules and can drift apart.
 * Every Polaris that knows about this sends the range of CLI protocol versions
 * it answers in one header (`<oldest>-<newest>`, written in
 * `apps/web/next.config.mjs`); the CLI compares its own against it on every
 * call, which costs no extra round trip. A server that sends no header predates
 * the header and speaks protocol 1, which is what every CLI before it spoke.
 *
 * Bump `CLI_PROTOCOL` (and the server's newest) only for a change an older CLI
 * or an older server would misread, never for an added field.
 */

/** The API this CLI speaks. */
export const CLI_PROTOCOL = 1;

/** The header the server names its range in. */
export const PROTOCOL_HEADER = "x-polaris-cli-protocol";

/**
 * What is wrong between this CLI and the server, as a sentence that names the
 * command that fixes it; null when they match or the server does not say.
 */
export function compatibilityProblem(
    url: string,
    header: string | null,
    protocol: number = CLI_PROTOCOL
): string | null {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(header ?? "");
    if (!range) return null;
    const oldest = Number(range[1]);
    const newest = Number(range[2]);
    if (protocol < oldest) {
        return `This CLI is too old for Polaris at ${url}. Update it with plr update, then try again.`;
    }
    if (protocol > newest) {
        return `Polaris at ${url} is older than this CLI. Update Polaris from Settings > Update, or install the CLI it serves with plr update --url ${url}.`;
    }
    return null;
}
