/**
 * plr / polaris - the Polaris command-line client for developers.
 *
 * Sign in once with `plr login` (in the browser, or with a code on a machine
 * that has none) and every command after that uses that sign-in. One file, run
 * by the developer's own Node, handed out by each Polaris at `/cli`.
 */

import { open } from "./commands/open.js";
import { CLI_VERSION } from "./version.js";
import { CliError, usage } from "./errors.js";
import { parse, type Flags } from "./args.js";
import { status } from "./commands/status.js";
import { profile } from "./commands/profile.js";
import { existsSync, readFileSync } from "node:fs";
import { update, uninstall } from "./commands/install.js";
import { login, logout, whoami } from "./commands/auth.js";
import { processContext, type Context } from "./context.js";
import { detectServerInstall, serverInstallMessage, type Probe } from "./guard.js";
import {
    buildLog,
    deploy,
    deployments,
    logs,
    projects,
    restart,
    service
} from "./commands/deploy.js";

export const HELP = `plr - the Polaris command line (also installed as polaris)

Signing in
  plr login [--url URL] [--profile NAME] [--browserless]
                         Sign in from your browser, or with a code on another device
  plr logout             Sign out and revoke this computer's key
  plr whoami             Who you are signed in as, and what you may do
  plr status             CLI version, Polaris, sign-in, and whether an update is out
  plr profile [list|use NAME|remove NAME]
                         One profile per Polaris or account; switch between them

Deploy
  plr projects           Every service you can reach
  plr service SERVICE    Status, source and domains
  plr deployments SERVICE
                         Recent deployments
  plr deploy SERVICE [--follow]
                         Deploy it again, and watch the build
  plr build-log DEPLOYMENT [--follow] [--tail N]
  plr logs SERVICE [--follow] [--tail N]
  plr restart SERVICE

Other
  plr open [home|deploy|keys|downloads]
                         Open the dashboard in your browser
  plr update             Get the CLI your Polaris serves
  plr uninstall [--yes]  Sign out everywhere and remove the CLI

SERVICE is project/service, project/environment/service, or its id.
--json prints read commands as JSON. --profile (or POLARIS_PROFILE) picks a
profile for one command. POLARIS_TOKEN with POLARIS_URL uses an API key instead
of a sign-in, for CI.
`;

/** The real disk, for the server-install guard. */
const diskProbe: Probe = {
    exists: (path) => existsSync(path),
    read: (path) => {
        try {
            return readFileSync(path, "utf8");
        } catch {
            return null;
        }
    }
};

/** Run one command line. Separate from `main` so a test can drive it. */
export async function run(
    argv: readonly string[],
    context: Context,
    probe: Probe = diskProbe
): Promise<void> {
    const { positionals, flags } = parse(argv);
    const [command = "help", ...args] = positionals;

    if (flags.version || command === "version") {
        context.io.out(`${CLI_VERSION}\n`);
        return;
    }
    if (flags.help || command === "help") {
        context.io.out(HELP);
        return;
    }

    // Before anything that reads or writes a sign-in: on a machine with a
    // Polaris server, this CLI is the one that steps aside.
    const server = detectServerInstall(context.host, probe);
    if (server.found) throw new CliError(serverInstallMessage(server));

    await dispatch(command, args, flags, context);
}

async function dispatch(
    command: string,
    args: readonly string[],
    flags: Flags,
    context: Context
): Promise<void> {
    const [first] = args;
    switch (command) {
        case "login":
            return login(context, flags);
        case "logout":
            return logout(context, flags);
        case "whoami":
            return whoami(context, flags);
        case "status":
            return status(context, flags);
        case "profile":
        case "profiles":
            return profile(context, flags, args);
        case "projects":
            return projects(context, flags);
        case "service":
            return service(context, flags, first);
        case "deployments":
            return deployments(context, flags, first);
        case "deploy":
        case "redeploy":
            return deploy(context, flags, first);
        case "build-log":
            return buildLog(context, flags, first);
        case "logs":
            return logs(context, flags, first);
        case "restart":
            return restart(context, flags, first);
        case "open":
            return open(context, flags, first);
        case "update":
            return update(context, flags);
        case "uninstall":
            return uninstall(context, flags);
        default:
            throw usage(`"${command}" is not a plr command.`);
    }
}

/** The process entry: run argv, print a failure as a sentence, set the exit code. */
export async function main(): Promise<void> {
    const context = processContext();
    try {
        await run(process.argv.slice(2), context);
    } catch (caught) {
        if (caught instanceof CliError) {
            context.io.err(`plr: ${caught.message}\n`);
            process.exitCode = caught.exitCode;
            return;
        }
        // Not one of ours: say so without a stack, which names paths and
        // internals nobody asked for. POLARIS_DEBUG=1 prints it.
        context.io.err(
            "plr: something went wrong that this CLI did not expect. Run it again with POLARIS_DEBUG=1 for details.\n"
        );
        if (process.env.POLARIS_DEBUG === "1")
            context.io.err(
                `${caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)}\n`
            );
        process.exitCode = 1;
    }
}
