/**
 * Serving a domain through Cloudflare's proxy, and emptying its cache.
 */

import { z } from "zod";

export const domainCdnSchema = z.object({
    domainId: z.string().uuid(),
    enabled: z.boolean()
});

/** A path under a hostname to purge: relative, no query, no traversal. Empty
 *  purges the whole hostname. */
export function isPurgePrefix(value: string): boolean {
    return value === "" || (/^[A-Za-z0-9._~\/-]{1,512}$/.test(value) && !value.startsWith("/") && !value.split("/").includes(".."));
}

export const cachePurgeSchema = z.object({
    domainId: z.string().uuid(),
    prefix: z
        .string()
        .trim()
        .transform((value) => value.replace(/^\/+/, ""))
        .refine(isPurgePrefix, "Use a path like assets/ or images/logo, without the domain")
        .optional()
});
