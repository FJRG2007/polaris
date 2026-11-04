/**
 * What a server picker may ask the server for: a search, a cursor, a page size
 * and the filters a screen needs applied to the list. Shared by the picker and
 * the action that answers it, and free of anything server-only so the picker
 * can import it.
 */

import { z } from "zod";

/** The largest page a picker is ever given, whatever it asks for. */
export const SERVER_OPTIONS_MAX_PAGE = 100;
/** The page a picker is given when it does not say. */
export const SERVER_OPTIONS_PAGE = 50;

export const serverFilterSchema = z
    .object({
        /** Only servers whose Polaris login may act as root. */
        root: z.boolean().optional(),
        /** Only servers that are enrolled and not switched off, answering or not. */
        active: z.boolean().optional(),
        /** Only servers answering now. */
        online: z.boolean().optional(),
        /** Only servers with a container engine Polaris has reached. */
        docker: z.boolean().optional(),
        /** Only servers that are not already a VPN node. */
        withoutVpnNode: z.boolean().optional(),
        /** Servers left out, such as the one being moved away from. */
        exclude: z.array(z.string().uuid()).max(200).optional()
    })
    .strict();

export type ServerFilter = z.infer<typeof serverFilterSchema>;

/** Features that pick a server under their own grant rather than the server tools'. */
export const serverPurposeSchema = z.enum(["agentSession", "mailServer"]);
export type ServerPurpose = z.infer<typeof serverPurposeSchema>;

/** The machine Polaris runs on, offered under this id where a screen deploys to it
 *  without it being enrolled. */
export const LOCAL_SERVER_OPTION = "local";

/** Where the next page starts, as the last page handed it out. Room for the
 *  longest name escaped and base64-encoded with its id. */
export const pageCursorSchema = z.string().max(2048).nullable().default(null);

export const serverOptionsRequestSchema = z
    .object({
        query: z.string().trim().max(120).default(""),
        cursor: pageCursorSchema,
        limit: z.number().int().min(1).max(SERVER_OPTIONS_MAX_PAGE).default(SERVER_OPTIONS_PAGE),
        /** Read these servers back by id - how a picker names what is chosen. */
        ids: z
            .array(z.union([z.string().uuid(), z.literal(LOCAL_SERVER_OPTION)]))
            .min(1)
            .max(50)
            .optional(),
        filter: serverFilterSchema.default({}),
        /** Offer the machine Polaris runs on first, as `local`. */
        includeLocal: z.boolean().optional(),
        /** The servers of the project this environment belongs to, rather than the
         *  caller's own: what a service in it may be deployed to. */
        environmentId: z.string().uuid().optional(),
        /** What the choice is for, when that is not a server tool: the list is then
         *  read under that feature's grant and narrowed to what it accepts. */
        purpose: serverPurposeSchema.optional()
    })
    .strict();

export type ServerOptionsRequest = z.input<typeof serverOptionsRequestSchema>;

/** One server as a picker shows it. */
export interface ServerOption {
    readonly id: string;
    readonly name: string;
    readonly address: string;
    readonly os: string | null;
    readonly environment: string;
    readonly root: boolean;
    readonly online: boolean;
}
