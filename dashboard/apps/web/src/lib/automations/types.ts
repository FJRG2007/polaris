/**
 * What a node type is on the server: its descriptor from `@polaris/core` plus
 * the function that does its work. Core's nodes and an app's (through
 * `AppExtension.automationNodes`) share this one shape, so the engine never
 * knows which it is running.
 */

import type * as core from "@polaris/core";
import type { ZodType, ZodTypeDef } from "zod";

/** The account a run acts as, re-checked on every run. */
export interface RunActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** Everything a node may read: the firing trigger, earlier steps, the run itself. */
export interface RunContext {
    readonly trigger: Record<string, unknown>;
    readonly steps: Record<string, unknown>;
    readonly run: {
        readonly id: string;
        readonly startedAt: string | null;
        readonly status: string | null;
        readonly error: string | null;
    };
    readonly automation: { readonly id: string; readonly name: string };
    readonly now: string;
    /** Inside a For each: the item (or batch) of this pass; inside a Repeat: the pass number. */
    readonly item?: unknown;
    readonly index?: number;
    /** A called automation's typed inputs. */
    readonly inputs?: Record<string, unknown>;
}

export interface NodeIo {
    readonly actor: RunActor;
    readonly runId: string;
    readonly automationId: string;
    /** Sent to receivers that can recognise a repeat: `<runId>:<nodeId>:<iteration>`. */
    readonly idempotencyKey: string;
    /** How many automations in a chain led to this run (0 for a direct start). */
    readonly depth: number;
    /** The automation's shelf: an org, or a person. */
    readonly shelf: { readonly orgId: string | null; readonly userId: string | null };
    readonly timeZone: string;
    readonly signal: AbortSignal;
    /** Whether this automation was allowed onto the local network by an administrator. */
    readonly allowLocalNetwork: boolean;
    /** A secret's value, from the automation's own shelf. Every value read is redacted from stored data. */
    secret(id: string): Promise<string>;
    /** What the step was asked to do, stored (redacted) on the step for the runs view. */
    recordInput(input: unknown): void;
}

/** `port` may list several ports joined by commas: every one of them is taken. */
export type NodeResult =
    | { readonly output: unknown; readonly port?: string }
    | { readonly wait: { readonly until: Date } };

export interface ServerNode<Config = unknown> {
    readonly type: string;
    readonly meta: core.CoreNodeMeta;
    readonly config: ZodType<Config, ZodTypeDef, unknown>;
    /** How long one execution may take; the engine's ceiling otherwise. */
    readonly timeoutMs?: number;
    /** Absent on triggers: their step is written when the run starts. */
    readonly run?: (config: Config, context: RunContext, io: NodeIo) => Promise<NodeResult>;
}

/**
 * A failure with a code the screens can put into words. `detail` is safe to
 * show (a status code, a field), never a URL or a secret.
 */
export class StepError extends Error {
    constructor(
        readonly code: string,
        readonly output?: unknown
    ) {
        super(code);
        this.name = "StepError";
    }
}

/** The node may not do this at all for this actor: the run is refused, not failed. */
export class StepRefusal extends StepError {
    constructor(code: string) {
        super(code);
        this.name = "StepRefusal";
    }
}
