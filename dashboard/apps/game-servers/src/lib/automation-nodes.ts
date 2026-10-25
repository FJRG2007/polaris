/**
 * Game servers in the central automations engine: start, stop or restart a
 * server, and send a line to its console.
 *
 * Each step acts as the automation's run-as account, its standing on the
 * server read again on every run by the rule the server's own page uses
 * (`gameServerAccess`): power needs `games.manage`, the console
 * `games.console`. The work is the same call the page's buttons make, so a
 * stop still saves the world first and a console line is still audited.
 *
 * Server-only.
 */

import { interpolate } from "@polaris/core";
import type { ZodType, ZodTypeDef } from "zod";
import { MAX_CONSOLE_LINE } from "./console-queue";
import * as types from "./automation-node-types";
import { host, type AppHostTypes } from "@polaris/app-host";
import { restartServerNow, runConsoleCommand, setServerRunning } from "./games-operations";

type AnyServerNode = Awaited<
    ReturnType<NonNullable<AppHostTypes["AppExtension"]["automationNodes"]>>
>[number];
type NodeRun = NonNullable<AnyServerNode["run"]>;
type RunContext = Parameters<NodeRun>[1];
/** The engine's node with its config typed, as Places declares its own. */
type ServerNode<Config> = Omit<AnyServerNode, "config" | "run"> & {
    readonly config: ZodType<Config, ZodTypeDef, unknown>;
    readonly run: (
        config: Config,
        context: RunContext,
        io: Parameters<NodeRun>[2]
    ) => ReturnType<NodeRun>;
};

const ACTION_META = { role: "action", ports: [], idempotent: false } as const;

/** The run-as account's standing on the server, or the run refused. */
async function standing(
    actorId: string,
    installId: string,
    permission: "games.manage" | "games.console"
) {
    const { StepRefusal } = host.automations;
    const user = await host.mcp.actingUser(actorId);
    if (!user) throw new StepRefusal("runAsGone");
    const access = await host.appsInstallAccess.gameServerAccess(user, installId, permission);
    if (!access) throw new StepRefusal("gameServerForbidden");
    return { user, access };
}

/** A failure from the server's own call, as a step failure rather than an internal error. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (caught) {
        if (caught instanceof host.automations.StepError) throw caught;
        console.error("polaris: an automation's game server step failed:", caught);
        throw new host.automations.StepError("gameServerFailed");
    }
}

/**
 * The console line a run sends: the template with its values filled in, one
 * line, no control characters, no longer than the console takes.
 */
export function consoleLine(template: string, context: RunContext): string {
    const line = interpolate(template, context).trim();
    if (!line) throw new host.automations.StepError("commandEmpty");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(line)) throw new host.automations.StepError("commandInvalid");
    if (line.length > MAX_CONSOLE_LINE) throw new host.automations.StepError("commandTooLong");
    return line;
}

const powerNode: ServerNode<types.PowerNodeConfig> = {
    type: types.POWER_NODE_TYPE,
    meta: ACTION_META as never,
    config: types.powerNodeConfig,
    run: async (config, _context, io) => {
        const { user, access } = await standing(io.actor.id, config.installId, "games.manage");
        io.recordInput({ installId: config.installId, action: config.action });
        if (config.action === "restart") await attempt(() => restartServerNow(user, access));
        else await attempt(() => setServerRunning(user, access, config.action === "start"));
        return {
            output: {
                installId: config.installId,
                name: access.install.name,
                action: config.action
            }
        };
    }
};

const commandNode: ServerNode<types.CommandNodeConfig> = {
    type: types.COMMAND_NODE_TYPE,
    meta: ACTION_META as never,
    config: types.commandNodeConfig,
    run: async (config, context, io) => {
        const line = consoleLine(config.command, context);
        io.recordInput({ installId: config.installId, command: line });
        const { user, access } = await standing(io.actor.id, config.installId, "games.console");
        const answer = await attempt(() => runConsoleCommand(user, access, line));
        return {
            output: { installId: config.installId, name: access.install.name, output: answer }
        };
    }
};

export function gameServerAutomationNodes(): AnyServerNode[] {
    return [powerNode, commandNode] as unknown as AnyServerNode[];
}
