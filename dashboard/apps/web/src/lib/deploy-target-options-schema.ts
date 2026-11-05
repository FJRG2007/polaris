/**
 * What a deploy-server or service picker may ask for: a search, a cursor, a page
 * size and which list. Shared by the pickers and the actions that answer them,
 * and free of anything server-only so the pickers can import it.
 */

import { z } from "zod";
import {
    pageCursorSchema,
    SERVER_OPTIONS_MAX_PAGE,
    SERVER_OPTIONS_PAGE
} from "@/lib/server-options-schema";

/** The search, cursor, size and ids every paged option list takes. */
export const pageFields = {
    query: z.string().trim().max(120).default(""),
    cursor: pageCursorSchema,
    limit: z.number().int().min(1).max(SERVER_OPTIONS_MAX_PAGE).default(SERVER_OPTIONS_PAGE),
    /** Read these back by id - how a picker names what is chosen. */
    ids: z.array(z.string().uuid()).min(1).max(50).optional()
};

/**
 * Which deploy servers: `mine` is the caller's active ones, what a tunnel's
 * public end may be; `relay` is any admin's active non-local one, what the
 * backup way in may run through; `project` is every server of a project's
 * owner, what a service moved home to that project may run on.
 */
export const deployTargetScopeSchema = z.enum(["mine", "relay", "project"]);
export type DeployTargetScope = z.infer<typeof deployTargetScopeSchema>;

export const deployTargetOptionsRequestSchema = z
    .object({
        ...pageFields,
        scope: deployTargetScopeSchema.default("mine"),
        /** The project whose owner's servers `project` reads. */
        projectId: z.string().uuid().optional()
    })
    .strict()
    .refine((value) => (value.scope === "project") === Boolean(value.projectId));

export type DeployTargetOptionsRequest = z.input<typeof deployTargetOptionsRequestSchema>;

export const serviceOptionsRequestSchema = z
    .object({
        ...pageFields,
        /** Services not running on this deploy server. */
        excludeTargetId: z.string().uuid().optional()
    })
    .strict();

export type ServiceOptionsRequest = z.input<typeof serviceOptionsRequestSchema>;

/** One deploy server as a picker shows it. */
export interface DeployTargetOption {
    readonly id: string;
    readonly name: string;
    /** The machine Polaris runs on. */
    readonly local: boolean;
}

/** One service as a picker shows it. */
export interface ServiceOption {
    readonly id: string;
    readonly name: string;
    readonly project: string;
    readonly targetId: string;
}
