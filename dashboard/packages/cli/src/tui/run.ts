/**
 * `plr tui` (and `plr` alone at a terminal): the full-screen terminal UI.
 *
 * Drawn with plain ANSI over Node's own keypress events rather than a TUI
 * library: Ink needs React 19.1 or newer (this repo pins 19.0), OpenTUI needs
 * Bun or Node 26 and a native binary, and blessed/neo-blessed have not had a
 * release since 2015/2022 - none of them bundle into one Node 20 file that runs
 * on Windows Terminal, PowerShell and macOS/Linux terminals alike.
 *
 * Every key goes through `state.ts` (pure), every frame through `render.ts`
 * (pure); this file only reads keys, draws frames and makes the calls - with
 * the same API client and schemas as every other command.
 */

import { call } from "../api.js";
import { usage } from "../errors.js";
import { render } from "./render.js";
import type { Flags } from "../args.js";
import { CliError } from "../errors.js";
import { loadConfig } from "../config.js";
import { requireSession, type Context, type Session } from "../context.js";
import { FOLLOW_MS, lastStamp, restartService, startDeploy } from "../commands/deploy.js";
import {
    initial,
    nameKey,
    parseKeys,
    reduce,
    type Effect,
    type Event,
    type State
} from "./state.js";
import {
    deploymentsSchema,
    envNamesSchema,
    projectsSchema,
    runtimeLogSchema,
    serviceSchema
} from "../schemas.js";

const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_SCREEN = "\u001b[?25h\u001b[?1049l";

/** A failure as one line for the bottom of the screen. Ours are written to be
 *  read; anything else is not repeated, the way `main` does not. */
function failure(caught: unknown): string {
    if (caught instanceof CliError) return caught.message.split("\n")[0] ?? caught.message;
    return "Something went wrong that this CLI did not expect. Run it again with POLARIS_DEBUG=1 for details.";
}

export async function tui(context: Context, flags: Flags): Promise<void> {
    const input = process.stdin;
    const output = process.stdout;
    if (!context.io.interactive || !input.isTTY || !output.isTTY)
        throw usage(
            "plr tui needs a terminal. In a script, use the commands themselves, e.g. plr project list --json."
        );

    const config = await loadConfig(context.configDir);
    const byToken = Boolean(context.host.env.POLARIS_TOKEN);
    const profiles = byToken
        ? []
        : Object.keys(config.profiles)
              .sort()
              .map((name) => ({
                  name,
                  url: config.profiles[name]!.url,
                  account: config.profiles[name]!.account.email,
                  current: name === config.current
              }));
    const chosen = flags.profile ?? context.host.env.POLARIS_PROFILE ?? null;
    if (!byToken && profiles.length === 0)
        throw new CliError("Not signed in. Run plr login --url https://your-polaris-address");

    let session: Session | null = byToken ? await requireSession(context, flags) : null;
    const start = initial(
        profiles,
        byToken ? null : (chosen ?? (profiles.length === 1 ? profiles[0]!.name : null))
    );
    let state: State = start.state;
    let logTimer: ReturnType<typeof setTimeout> | null = null;
    // Bumped whenever the log being followed changes, so a read that comes back
    // after the person left that log is dropped.
    let logGeneration = 0;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));

    const draw = () => {
        const lines = render(state, output.columns || 80, output.rows || 24);
        output.write(`\u001b[H${lines.join("\u001b[K\r\n")}\u001b[K`);
    };

    const dispatch = (event: Event) => {
        const step = reduce(state, event);
        state = step.state;
        draw();
        void performAll(step.effects);
    };

    // In order: a profile's sign-in is read before its projects are asked for.
    const performAll = async (effects: readonly Effect[]) => {
        for (const effect of effects) await perform(effect);
    };

    const get = async <Schema extends Parameters<typeof call>[3]>(path: string, schema: Schema) => {
        if (!session) throw new CliError("Choose a profile first.");
        return call(session.connection, "GET", path, schema, { fetch: context.fetch });
    };

    const stopLog = () => {
        logGeneration += 1;
        if (logTimer) clearTimeout(logTimer);
        logTimer = null;
    };

    const followLog = async (serviceId: string) => {
        stopLog();
        const generation = logGeneration;
        const path = `/api/v1/deploy/services/${serviceId}/logs`;
        let since: string | null = null;
        const read = async (first: boolean) => {
            try {
                const query =
                    first || !since ? "?tail=200" : `?tail=1000&since=${encodeURIComponent(since)}`;
                const { log } = await get(`${path}${query}`, runtimeLogSchema);
                if (generation !== logGeneration) return;
                if (first || log) dispatch({ type: "log", text: log, append: !first });
                since = lastStamp(log, since);
            } catch (caught) {
                if (generation === logGeneration)
                    dispatch({ type: "failed", text: failure(caught) });
            }
            if (generation === logGeneration)
                logTimer = setTimeout(() => void read(false), FOLLOW_MS);
        };
        await read(true);
    };

    const perform = async (effect: Effect): Promise<void> => {
        try {
            switch (effect.type) {
                case "quit":
                    finish();
                    return;
                case "use-profile":
                    session = null;
                    session = await requireSession(context, { ...flags, profile: effect.name });
                    return;
                case "load-projects": {
                    const { projects } = await get("/api/v1/deploy/projects", projectsSchema);
                    return dispatch({ type: "projects", projects });
                }
                case "load-service": {
                    const { service } = await get(
                        `/api/v1/deploy/services?ref=${encodeURIComponent(effect.serviceId)}`,
                        serviceSchema
                    );
                    return dispatch({ type: "service", service });
                }
                case "load-deployments": {
                    const { deployments } = await get(
                        `/api/v1/deploy/services/${effect.serviceId}/deployments`,
                        deploymentsSchema
                    );
                    return dispatch({ type: "deployments", deployments });
                }
                case "load-variables": {
                    const { variables } = await get(
                        `/api/v1/deploy/services/${effect.serviceId}/env`,
                        envNamesSchema
                    );
                    return dispatch({ type: "variables", variables });
                }
                case "follow-log":
                    return followLog(effect.serviceId);
                case "stop-log":
                    return stopLog();
                case "run": {
                    if (!session) throw new CliError("Choose a profile first.");
                    const target = { id: effect.serviceId };
                    if (effect.action === "deploy") {
                        const { deploymentId } = await startDeploy(context, session, target);
                        return dispatch({
                            type: "done",
                            text: `Deployment ${deploymentId} started. Its build log: plr deployment logs ${deploymentId} --follow`
                        });
                    }
                    await restartService(context, session, target);
                    return dispatch({ type: "done", text: "Restarted." });
                }
            }
        } catch (caught) {
            dispatch({ type: "failed", text: failure(caught) });
        }
    };

    const onKey = (chunk: Buffer | string) => {
        for (const key of parseKeys(chunk.toString())) {
            const named = nameKey(state, key.text, key);
            if (named) dispatch({ type: "key", key: named });
        }
    };
    const restore = () => {
        input.off("data", onKey);
        output.off("resize", draw);
        input.setRawMode(false);
        input.pause();
        output.write(LEAVE_SCREEN);
    };
    // Whatever ends the process, the terminal is handed back as it was.
    process.once("exit", restore);

    input.setRawMode(true);
    input.resume();
    input.on("data", onKey);
    output.on("resize", draw);
    output.write(ENTER_SCREEN);
    draw();
    void performAll(start.effects);

    try {
        await done;
    } finally {
        stopLog();
        process.off("exit", restore);
        restore();
    }
}
