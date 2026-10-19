/**
 * plr / polaris - the Polaris command-line client for developers.
 *
 * Sign in once with `plr login` (in the browser, or with a code on a machine
 * that has none) and every command after that uses that sign-in. One file, run
 * by the developer's own Node, installed from the project's GitHub releases.
 *
 * Commands are `plr <noun> <verb>` (`commands.ts`). Only what the command line
 * names is evaluated: this file imports nothing heavy, and each command's module,
 * the sign-in code and the server-install guard are loaded when first needed.
 */

import { parse, type Parsed } from "./args.js";
import { CLI_VERSION } from "./version.js";
import { CliError, usage } from "./errors.js";
import type { Probe } from "./guard.js";
import type { Context } from "./context.js";
import { mark, timed, timingReport } from "./timing.js";
import { helpText, resolve, type Resolved } from "./commands.js";

/** The whole help, grouped by noun. */
export const HELP = helpText();

/** What `--version` and the help print: answered without a sign-in, a context
 *  or any command's code. Null for everything else. */
function localAnswer(parsed: Parsed, resolved: Resolved): string | null {
    if (parsed.flags.version || parsed.positionals[0] === "version") return `${CLI_VERSION}\n`;
    if (parsed.flags.help || resolved.kind === "help")
        return helpText(resolved.kind === "unknown" ? undefined : resolved.group);
    return null;
}

/** Run one command line. Separate from `main` so a test can drive it. */
export async function run(argv: readonly string[], context: Context, probe?: Probe): Promise<void> {
    const parsed = parse(argv);
    const resolved = resolve(parsed.positionals, context.host.env);
    const answer = localAnswer(parsed, resolved);
    if (answer !== null) {
        context.io.out(answer);
        return;
    }
    if (resolved.kind === "unknown") throw usage(resolved.message);
    if (resolved.kind !== "run") return;
    const { flags } = parsed;
    if (resolved.notice) context.io.err(resolved.notice);

    // Before anything that reads or writes a sign-in: on a machine with a
    // Polaris server, this CLI is the one that steps aside.
    const guard = await import("./guard.js");
    const server = await timed("server-install check", async () =>
        guard.detectServerInstall(context.host, probe ?? guard.diskProbe)
    );
    if (server.found) throw new CliError(guard.serverInstallMessage(server));

    await resolved.command.run(context, flags, resolved.args);
}

/** The process entry: run argv, print a failure as a sentence, set the exit code. */
export async function main(): Promise<void> {
    // From the process starting to here: Node itself and loading the bundle.
    mark("startup (node and the bundle)", 0);
    const argv = process.argv.slice(2);
    // The help and --version need none of the rest of the CLI loaded. A line
    // that does not parse is left to `run`, which says what is wrong with it.
    try {
        const parsed = parse(argv);
        const answer = localAnswer(parsed, resolve(parsed.positionals, process.env));
        if (answer !== null) {
            process.stdout.write(answer);
            process.stderr.write(timingReport());
            return;
        }
    } catch {
        // Reported by `run` below.
    }
    const context = (await import("./context.js")).processContext();
    try {
        await run(argv, context);
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
    } finally {
        // PLR_DEBUG=1: where the time went, after the command's own output.
        context.io.err(timingReport());
    }
}
