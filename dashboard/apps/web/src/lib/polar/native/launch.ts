/**
 * How the `polaris-agent` process builds its session from the environment the
 * boot script (container) or the runner (computer) gives it: the session's id
 * and reporting token, this Polaris's address, the model, and where to work.
 *
 * The model is called through Polaris's own compatible API with the session
 * token (`compat/auth.ts`, `nativeSessionForToken`), so no provider key ever
 * enters the machine. Hooks go to the session's `events` and `permission`
 * routes with the same token, exactly as a CLI's hook relay does.
 *
 * Every value is validated before use; a missing or malformed one fails the
 * start naming the variable, never its value.
 */

import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { httpHookSink, type HookSink } from "@/lib/polar/native/hooks";
import { nodeWorkspace, type Workspace } from "@/lib/polar/native/workspace";
import { NativeSession, type NativeSessionOptions } from "@/lib/polar/native/engine";

/** The variables the engine reads, and what each must look like. */
export const launchEnvSchema = z.object({
    POLARIS_URL: z
        .string()
        .trim()
        .url()
        .refine((value) => /^https?:\/\//.test(value), "must be http(s)")
        .transform((value) => value.replace(/\/+$/, "")),
    POLARIS_SESSION_ID: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/),
    POLARIS_SESSION_TOKEN: z.string().trim().min(16).max(512),
    /** The model as the compatible API names it (`provider/model`, or a tier). */
    POLARIS_MODEL: z.string().trim().min(1).max(200),
    POLARIS_WORKDIR: z.string().trim().min(1).max(4096),
    POLARIS_PLACE: z.enum(["container", "computer"]).default("container"),
    POLARIS_BRANCH: z.string().trim().max(255).optional(),
    POLARIS_REPOSITORY: z.string().trim().max(255).optional(),
    /** Where the Claude-shaped JSONL transcript is written. */
    POLARIS_TRANSCRIPT: z.string().trim().min(1).max(4096).optional()
});

export type LaunchConfig = z.infer<typeof launchEnvSchema>;

/** The config, or the names of the variables that are missing or malformed. */
export function readLaunchEnv(env: NodeJS.ProcessEnv): { config: LaunchConfig } | { invalid: string[] } {
    const parsed = launchEnvSchema.safeParse(env);
    if (parsed.success) return { config: parsed.data };
    return { invalid: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort() };
}

/** The session's routes on this Polaris. */
export function sessionRoutes(config: Pick<LaunchConfig, "POLARIS_URL" | "POLARIS_SESSION_ID">) {
    const base = `${config.POLARIS_URL}/api/agents/sessions/${encodeURIComponent(config.POLARIS_SESSION_ID)}`;
    return {
        events: `${base}/events`,
        permission: `${base}/permission`,
        tools: `${base}/tools`,
        models: `${config.POLARIS_URL}/api/v1`
    };
}

/** The transcript's path: the one given, or one beside the CLIs' own. */
export function transcriptPathOf(config: LaunchConfig, conversationId: string = config.POLARIS_SESSION_ID): string {
    return config.POLARIS_TRANSCRIPT ?? path.join(transcriptDir(), `${conversationId}.jsonl`);
}

/** Where every native conversation's transcript is kept, in the home that
 *  outlives the session (`readableTranscriptPath` accepts this shape). */
export function transcriptDir(): string {
    return path.join(os.homedir(), ".polaris-agent", "sessions");
}

/** The model, called through Polaris's compatible API with the session token. */
export function launchModel(config: LaunchConfig, fetchImpl?: typeof fetch) {
    return createOpenAICompatible({
        name: "polaris",
        baseURL: sessionRoutes(config).models,
        apiKey: config.POLARIS_SESSION_TOKEN,
        ...(fetchImpl ? { fetch: fetchImpl } : {})
    })(config.POLARIS_MODEL);
}

/** The pieces a launch puts together; replaceable in tests. */
export interface LaunchParts {
    readonly ws?: Workspace;
    readonly hooks?: HookSink;
    readonly fetchImpl?: typeof fetch;
    readonly writeTranscript: (line: string) => void;
    readonly memory?: NativeSessionOptions["environment"]["memory"];
    readonly task?: string | null;
    /** The conversation's own id, as hooks report it; the session's when absent. */
    readonly conversationId?: string;
    /** The person's custom tools (`fetchCustomTools`). */
    readonly customTools?: NativeSessionOptions["customTools"];
}

/** A session ready to `start()`, from a validated config. */
export function launchSession(config: LaunchConfig, parts: LaunchParts): NativeSession {
    const routes = sessionRoutes(config);
    const conversationId = parts.conversationId ?? config.POLARIS_SESSION_ID;
    return new NativeSession({
        sessionId: conversationId,
        ws: parts.ws ?? nodeWorkspace(config.POLARIS_WORKDIR),
        model: launchModel(config, parts.fetchImpl),
        modelName: config.POLARIS_MODEL,
        hooks:
            parts.hooks ??
            httpHookSink({
                eventsUrl: routes.events,
                permissionUrl: routes.permission,
                token: config.POLARIS_SESSION_TOKEN,
                ...(parts.fetchImpl ? { fetchImpl: parts.fetchImpl } : {})
            }),
        writeTranscript: parts.writeTranscript,
        ...(parts.customTools ? { customTools: parts.customTools } : {}),
        transcriptPath: transcriptPathOf(config, conversationId),
        environment: {
            platform: process.platform,
            // What the Bash tool runs (`tools.ts`): bash on Windows, sh elsewhere.
            shell: process.platform === "win32" ? "bash" : "sh",
            branch: config.POLARIS_BRANCH || null,
            repository: config.POLARIS_REPOSITORY || null,
            place: config.POLARIS_PLACE,
            date: new Date().toISOString().slice(0, 10),
            memory: parts.memory ?? [],
            task: parts.task ?? null
        }
    });
}
