/**
 * Polaris as an Agent Client Protocol client (https://agentclientprotocol.com),
 * on the official TypeScript SDK (`@agentclientprotocol/sdk`).
 *
 * Polaris advertises neither the client file system nor the client terminal:
 * the agent runs inside the session's own machine with its own tools, and
 * routing its reads, writes and commands through the dashboard would be a
 * second execution and permission model beside the one the session already
 * has. An agent that asks anyway is answered "method not found" by the SDK.
 *
 * What the agent reports (`session/update`) is handed on in the order it
 * arrived, one at a time; what it asks (`session/request_permission`) is
 * answered with an option it offered, or cancelled. Both are the caller's to
 * decide: this module is the protocol, not the session.
 */

import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

/** How long a setup request (initialize, a new or loaded session, a mode) may
 *  take before the agent is treated as not answering. A prompt has none: a
 *  turn takes as long as it takes, and `cancel` is how it is stopped. */
export const SETUP_TIMEOUT_MS = 60_000;

export interface AcpHandlers {
    /** One update, after the one before it was handled. */
    onUpdate(notification: acp.SessionNotification): void | Promise<void>;
    /**
     * The id of the option to answer a permission request with, or null to
     * cancel it. Anything that is not one of the offered ids is cancelled.
     */
    onPermission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<string | null>;
    /** A handler that threw: logged by the caller, never shown to anybody. */
    onHandlerError?(what: "update" | "permission", error: unknown): void;
}

export interface AcpClient {
    initialize(): Promise<acp.InitializeResponse>;
    newSession(cwd: string, mcpServers?: acp.McpServer[]): Promise<acp.NewSessionResponse>;
    loadSession(
        sessionId: string,
        cwd: string,
        mcpServers?: acp.McpServer[]
    ): Promise<acp.LoadSessionResponse>;
    prompt(sessionId: string, text: string): Promise<acp.PromptResponse>;
    cancel(sessionId: string): Promise<void>;
    /** Deliver a message into the turn that is running (`STEER_METHOD`):
     *  `injected` when the agent took it into that turn, `promptRequired`
     *  when no turn was running, anything else when it answered otherwise. */
    steer(sessionId: string, text: string): Promise<string>;
    setMode(sessionId: string, modeId: string): Promise<void>;
    /** Closes the connection; requests still waiting are rejected. */
    close(error?: unknown): void;
    readonly closed: Promise<void>;
}

/**
 * The ACP steering extension: a message delivered into the running turn
 * instead of queued behind it as another `session/prompt`. Advertised in
 * `InitializeResponse._meta.steering.supported`; Claude Code's adapter
 * (@agentclientprotocol/claude-agent-acp, src/acp-agent.ts `STEER_METHOD`)
 * hands it to the SDK at priority "now", which a foreground tool call answers
 * by moving to the background, so the model reads it at the next step.
 * `idleBehavior: "promptRequired"` keeps an idle agent from starting a turn
 * of its own with it: Polaris sends that one as a normal prompt.
 */
export const STEER_METHOD = "_session/steering";

const steerResponseSchema = z.object({ outcome: z.string() });

/** Whether the agent said it takes `STEER_METHOD`. Pure. */
export function supportsSteering(init: acp.InitializeResponse): boolean {
    const meta = (init as { _meta?: unknown })._meta;
    const steering = meta && typeof meta === "object" ? (meta as Record<string, unknown>).steering : null;
    return Boolean(steering && typeof steering === "object" && (steering as Record<string, unknown>).supported === true);
}

/** What Polaris tells the agent it can do. */
export const CLIENT_CAPABILITIES: acp.ClientCapabilities = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false
};

/** The answer to a permission request for an option id, or a cancellation
 *  when the id is not one the agent offered. Pure. */
export function permissionOutcome(
    request: acp.RequestPermissionRequest,
    chosen: string | null
): acp.RequestPermissionResponse {
    if (chosen !== null && request.options.some((option) => option.optionId === chosen))
        return { outcome: { outcome: "selected", optionId: chosen } };
    return { outcome: { outcome: "cancelled" } };
}

/** Connect to an agent over `stream`. */
export function connectAcp(stream: acp.Stream, handlers: AcpHandlers): AcpClient {
    // Updates are applied in arrival order: the SDK starts each handler as its
    // notification arrives and does not wait for the one before.
    let updates: Promise<void> = Promise.resolve();

    const app = acp
        .client({ name: "polaris" })
        .onNotification(acp.methods.client.session.update, ({ params }) => {
            updates = updates
                .then(() => handlers.onUpdate(params))
                .catch((error: unknown) => handlers.onHandlerError?.("update", error));
        })
        .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
            if (params.options.length === 0) return permissionOutcome(params, null);
            try {
                return permissionOutcome(params, await handlers.onPermission(params, signal));
            } catch (error) {
                handlers.onHandlerError?.("permission", error);
                return permissionOutcome(params, null);
            }
        });

    const connection = app.connect(stream);
    const agent = connection.agent;

    /** A setup request, given up on (and the connection with it) after the
     *  timeout: cancellation is cooperative, so an agent that never answers
     *  would otherwise hold the request open forever. */
    async function setup<T>(work: Promise<T>, what: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`The agent did not answer ${what} in time.`);
                connection.close(error);
                reject(error);
            }, SETUP_TIMEOUT_MS);
        });
        try {
            return await Promise.race([work, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async initialize() {
            const response = await setup(
                agent.request(acp.methods.agent.initialize, {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientCapabilities: CLIENT_CAPABILITIES
                }),
                "its start"
            );
            if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
                const error = new Error(
                    `The agent speaks version ${response.protocolVersion} of the protocol, and Polaris speaks ${acp.PROTOCOL_VERSION}.`
                );
                connection.close(error);
                throw error;
            }
            return response;
        },
        newSession(cwd, mcpServers = []) {
            return setup(agent.request(acp.methods.agent.session.new, { cwd, mcpServers }), "a new conversation");
        },
        loadSession(sessionId, cwd, mcpServers = []) {
            return setup(
                agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers }),
                "reopening its conversation"
            );
        },
        prompt(sessionId, text) {
            return agent.request(acp.methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: "text", text }]
            });
        },
        cancel(sessionId) {
            return agent.notify(acp.methods.agent.session.cancel, { sessionId });
        },
        async steer(sessionId, text) {
            const response = await agent.request<unknown>(STEER_METHOD, {
                sessionId,
                prompt: [{ type: "text", text }],
                _meta: { steering: { idleBehavior: "promptRequired" } }
            });
            const parsed = steerResponseSchema.safeParse(response);
            return parsed.success ? parsed.data.outcome : "unknown";
        },
        async setMode(sessionId, modeId) {
            await setup(agent.request(acp.methods.agent.session.setMode, { sessionId, modeId }), "a mode change");
        },
        close(error) {
            connection.close(error);
        },
        closed: connection.closed
    };
}
