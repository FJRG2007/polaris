/**
 * `plr status`: everything worth knowing before filing "it does not work" -
 * which CLI this is, which Polaris and account it is pointed at, whether that
 * sign-in still works, and whether a newer CLI has been released.
 *
 * Never fails for the things it reports on: an unreachable server or a revoked
 * key is a line in the report, not an exit.
 */

import { call } from "../api.js";
import { CliError } from "../errors.js";
import type { Flags } from "../args.js";
import { meSchema } from "../schemas.js";
import { configFile } from "../config.js";
import { CLI_VERSION } from "../version.js";
import { line, printJson } from "../output.js";
import { DEFAULT_REPO, isNewerVersion, newestRelease } from "../releases.js";
import { bundlePath, readMarker } from "./install.js";
import { requireSession, type Context, type Session } from "../context.js";

interface Report {
    cli: { version: string; path: string; installed: boolean; updateAvailable: boolean | null };
    config: string;
    profile: string | null;
    url: string | null;
    signedIn: { name: string | null; email: string; scopes: string[] } | null;
    problem: string | null;
}

/** Whether a newer CLI release is out than this copy; null when it cannot be
 *  told (not installed with the install line, or GitHub could not be asked). */
async function updateAvailable(context: Context): Promise<boolean | null> {
    const bundle = bundlePath();
    const marker = await readMarker(bundle);
    if (!marker) return null;
    try {
        const release = await newestRelease(context.fetch, marker.repo ?? DEFAULT_REPO);
        return isNewerVersion(release.version, CLI_VERSION);
    } catch {
        return null;
    }
}

export async function status(context: Context, flags: Flags): Promise<void> {
    const report: Report = {
        cli: {
            version: CLI_VERSION,
            path: bundlePath(),
            installed: Boolean(await readMarker(bundlePath())),
            updateAvailable: null
        },
        config: configFile(context.configDir),
        profile: null,
        url: null,
        signedIn: null,
        problem: null
    };

    let session: Session | null = null;
    try {
        session = await requireSession(context, flags);
    } catch (caught) {
        if (!(caught instanceof CliError)) throw caught;
        report.problem = caught.message;
    }
    if (session) {
        report.profile = session.profileName;
        report.url = session.connection.url;
        try {
            const me = await call(session.connection, "GET", "/api/v1/me", meSchema, {
                fetch: context.fetch,
                timeoutMs: 15_000
            });
            report.signedIn = { name: me.user.name, email: me.user.email, scopes: me.key.scopes };
        } catch (caught) {
            if (!(caught instanceof CliError)) throw caught;
            report.problem = caught.message;
        }
    }
    report.cli.updateAvailable = await updateAvailable(context);

    if (flags.json) return printJson(context.io, report);

    line(context.io, `CLI:      ${report.cli.version} (${report.cli.path})`);
    line(context.io, `Config:   ${report.config}`);
    if (report.url)
        line(
            context.io,
            `Polaris:  ${report.url}${report.profile ? ` (profile ${report.profile})` : " (POLARIS_TOKEN)"}`
        );
    if (report.signedIn) {
        const who = report.signedIn.name
            ? `${report.signedIn.name} <${report.signedIn.email}>`
            : report.signedIn.email;
        line(context.io, `Signed in as ${who}`);
        line(context.io, `Allowed to: ${report.signedIn.scopes.join(", ") || "nothing"}`);
    }
    if (report.cli.updateAvailable) line(context.io, "A newer CLI is out. Run plr update.");
    if (report.problem) line(context.io, report.problem);
}
