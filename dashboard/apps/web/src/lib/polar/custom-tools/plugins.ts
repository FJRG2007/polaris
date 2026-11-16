/**
 * Plugins hearing a session's events (OpenCode's plugin hooks, ported): the
 * person's own reactions to a tool about to run or just run, a session
 * starting or ending, a permission asked, a message sent.
 *
 * A plugin's action is a webhook POST, sent through the guarded fetch that
 * re-checks every hop against private addresses, or one of the person's custom
 * tools, run in the same session's sandbox like any other call of it. Neither
 * runs code in this process. A plugin never changes what the agent does: its
 * failures are logged and dropped, and it runs after the event is recorded.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { follow } from "@/lib/safe-fetch";
import * as store from "@/lib/polar/custom-tools/store";
import * as shared from "@/lib/polar/custom-tools/shared";
import { runTool, sandboxFor } from "@/lib/polar/custom-tools/runtime";

export interface PluginFacts {
    sessionId?: string;
    threadId?: string;
    tool?: string;
    detail?: string;
}

/** The pieces a dispatch reaches out with, replaceable in a test. */
export interface PluginPorts {
    plugins: (userId: string) => Promise<store.StoredPlugin[]>;
    tools: (userId: string) => Promise<store.StoredTool[]>;
    post: (url: string, body: string) => Promise<void>;
    runTool: typeof runTool;
    sandbox: typeof sandboxFor;
}

const PORTS: PluginPorts = {
    plugins: store.listPlugins,
    tools: store.listTools,
    async post(url, body) {
        const target = new URL(url);
        await follow(target, "application/json", { contentType: "application/json", body });
    },
    runTool,
    sandbox: sandboxFor
};

/** Runs every plugin of the person's that hears this event. Never throws. */
export async function dispatchPluginEvent(
    userId: string,
    event: shared.PluginEvent,
    facts: PluginFacts,
    ports: PluginPorts = PORTS
): Promise<number> {
    const plugins = shared.pluginsFor(await ports.plugins(userId).catch(() => []), event);
    if (plugins.length === 0) return 0;
    const payload = shared.pluginPayload(event, facts);
    let ran = 0;
    for (const plugin of plugins) {
        try {
            if (plugin.action.kind === "webhook") {
                await ports.post(plugin.action.url, JSON.stringify(payload));
                ran += 1;
                continue;
            }
            const name = plugin.action.tool;
            const definition = (await ports.tools(userId)).find((entry) => entry.name === name);
            // A tool set to "deny" or switched off is not run by a plugin
            // either; "ask" has nobody to ask from an event, so only "allow" runs.
            if (!definition || !definition.enabled || definition.permission !== "allow") continue;
            const sandbox = await ports.sandbox(userId, facts.sessionId ?? null);
            if (!sandbox) continue;
            // The event arrives as the tool's input when it declares `event`.
            const input = "event" in definition.input.properties ? { event: JSON.stringify(payload) } : {};
            await ports.runTool(sandbox, definition, input);
            ran += 1;
        } catch (error) {
            console.error(`[polar-plugins] ${plugin.name} failed on ${event}`, error);
        }
    }
    return ran;
}

/** A session's hook, heard by its owner's plugins. */
export async function dispatchSessionHook(sessionId: string, kind: string, facts: Omit<PluginFacts, "sessionId">): Promise<void> {
    const event = shared.pluginEventOfHook(kind);
    if (!event) return;
    const session = await prisma.agentSession
        .findUnique({ where: { id: sessionId }, select: { startedById: true } })
        .catch(() => null);
    if (!session?.startedById) return;
    await dispatchPluginEvent(session.startedById, event, { ...facts, sessionId });
}
