/**
 * What an operator-added AI provider must look like.
 *
 * Client-safe on purpose: the Add provider dialog validates every keystroke
 * against the same schema the server action parses, so a field the server
 * would refuse is marked while it is typed, not after Save. Nothing here reads
 * the store; the rules that need it (a slug or a variable already taken) live
 * in `provider-catalog.ts`.
 */

import { z } from "zod";

/** Hosts an operator-added endpoint may not name: this machine and the
 *  networks it sits in, which a server-side request would otherwise probe.
 *  A first, syntactic gate; every request to the endpoint also goes through
 *  the guarded fetch, which refuses a name that resolves somewhere private. */
export function isPublicHttpsHost(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
    return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host);
}

const publicUrl = z
    .string()
    .trim()
    .max(500)
    .refine(isPublicHttpsHost, { message: "publicHttps" });

/** An optional link: empty is "none", anything else must be a public https one. */
const optionalPublicUrl = z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === "" || isPublicHttpsHost(value), { message: "publicHttps" })
    .transform((value) => (value === "" ? undefined : value))
    .optional();

/** What the Add provider form sends. */
export const customProviderSchema = z.object({
    name: z.string().trim().min(2, { message: "name" }).max(60, { message: "name" }),
    baseUrl: publicUrl,
    wire: z.enum(["openai", "anthropic"]),
    envVar: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9_]{2,62}$/, { message: "envVar" })
        .refine((value) => !/^(POLARIS_|OPENCODE_|PATH$|HOME$|NODE_)/.test(value), {
            message: "envVarReserved"
        }),
    defaultModel: z
        .string()
        .trim()
        .min(1, { message: "model" })
        .max(200, { message: "model" })
        .regex(/^[^\s/][^\s]*$/, { message: "model" }),
    probe: optionalPublicUrl,
    docsUrl: optionalPublicUrl
});

export type CustomProviderInput = z.input<typeof customProviderSchema>;

/** Why a custom provider was not stored. */
export type CustomProviderRefusal = "taken" | "envTaken" | "invalid";

/** A display name as a slug: lowercase words joined by dashes. */
export function slugifyProviderName(name: string): string {
    return name
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}
