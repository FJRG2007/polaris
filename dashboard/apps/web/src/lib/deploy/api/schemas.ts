/**
 * The shapes the programmatic Deploy surface accepts.
 *
 * Shared by the REST routes and the MCP tools, so a caller that sends the same
 * thing through either is refused for the same reason. Server-side only: nothing
 * in the dashboard renders a form for these, and the CLI is a shell script that
 * reads the refusal the API sends back.
 */

import { z } from "zod";

/**
 * How a service is named by somebody who does not have its id to hand.
 *
 * An id, or a path of names: `project/service` for the project's default
 * environment, or `project/environment/service` for another one. Slugs and names
 * both match, case-insensitively, because the dashboard shows names and the URLs
 * and container names show slugs, and a person copies whichever is in front of
 * them.
 */
export const serviceRefSchema = z
    .string()
    .trim()
    .min(1, "Name a service: its id, project/service or project/environment/service")
    .max(400)
    .refine(
        (value) => value.split("/").length <= 3 && !value.split("/").some((part) => !part.trim()),
        "A service is named project/service or project/environment/service"
    );

export const idSchema = z.string().uuid("That is not an id Polaris issues");

/** How many lines of a log to hand back, bounded by what one read may cost. */
export const tailSchema = z.coerce.number().int().min(1).max(5000).default(500);

/** Where a build log was read up to, so a poller asks only for what is new. */
export const offsetSchema = z.coerce.number().int().min(0).default(0);

/** A variable's name, the same rule the service layer enforces on save. */
export const variableKeySchema = z
    .string()
    .trim()
    .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "A variable name is letters, digits and underscores, and does not start with a digit"
    )
    .max(256);

export const setVariableSchema = z.object({
    key: variableKeySchema,
    // Values are whatever the service needs, newlines included - a PEM key is a
    // variable. Bounded so one call cannot write a megabyte into every deploy.
    value: z.string().max(65_536),
    secret: z.boolean().default(true)
});

export const importVariablesSchema = z.object({
    /** A `.env` file's contents: quotes, `export` and comments are handled. */
    text: z.string().min(1, "There is nothing to import").max(262_144),
    secret: z.boolean().default(true)
});

export const addDomainSchema = z.object({
    /** A hostname to attach. Absent means the service's free subdomain. */
    hostname: z
        .string()
        .trim()
        .toLowerCase()
        .regex(
            /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/,
            "That is not a hostname"
        )
        .optional(),
    /** The port inside the container. Absent means the port the service declares. */
    targetPort: z.coerce.number().int().min(1).max(65_535).optional(),
    /** How the edge secures it: Let's Encrypt, the local CA, or plain HTTP behind
     *  a proxy or tunnel that terminates TLS itself. */
    certificate: z.enum(["le", "internal", "none"]).optional()
});

export const rollbackSchema = z.object({
    deploymentId: idSchema
});

export type SetVariableInput = z.infer<typeof setVariableSchema>;
export type ImportVariablesInput = z.infer<typeof importVariablesSchema>;
export type AddDomainInput = z.infer<typeof addDomainSchema>;
