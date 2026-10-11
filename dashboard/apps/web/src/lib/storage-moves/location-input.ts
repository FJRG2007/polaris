/**
 * The form that adds a NAS location, shared by the browser and the server so both
 * normalize and check it the same way. Pure: no I/O, safe in a client bundle.
 */

import { z } from "zod";

/** A host name, an IPv4 address or a bracketless IPv6 address. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;

export const locationInputSchema = z
    .object({
        name: z.string().min(1, "nameRequired").max(120, "nameTooLong"),
        protocol: z.enum(["smb", "nfs"]),
        host: z.string().min(1, "hostRequired").max(253, "hostInvalid").regex(HOST, "hostInvalid"),
        /** The SMB share name, or the NFS export path. */
        path: z.string().min(1, "pathRequired").max(500, "pathInvalid"),
        username: z.string().max(256, "usernameInvalid").optional(),
        password: z.string().max(1024, "passwordInvalid").optional(),
        domain: z.string().max(256, "domainInvalid").optional()
    })
    .superRefine((value, context) => {
        if (value.protocol === "smb" && /[\\/]/.test(value.path))
            context.addIssue({ code: "custom", path: ["path"], message: "shareInvalid" });
        if (value.protocol === "nfs" && (!value.path.startsWith("/") || value.path.includes("..")))
            context.addIssue({ code: "custom", path: ["path"], message: "exportInvalid" });
        if (/[\u0000-\u001f\u007f]/.test(`${value.host}${value.path}${value.username ?? ""}${value.domain ?? ""}`))
            context.addIssue({ code: "custom", path: ["path"], message: "pathInvalid" });
    });

export type LocationInput = z.infer<typeof locationInputSchema>;

/** Every reason the schema gives, which is also its translation key. */
export const LOCATION_ERRORS = [
    "nameRequired",
    "nameTooLong",
    "hostRequired",
    "hostInvalid",
    "pathRequired",
    "pathInvalid",
    "shareInvalid",
    "exportInvalid",
    "usernameInvalid",
    "passwordInvalid",
    "domainInvalid"
] as const;
export type LocationError = (typeof LOCATION_ERRORS)[number];

/** A schema issue's message as one of the known reasons. */
export function locationError(message: string | undefined): LocationError {
    return (LOCATION_ERRORS as readonly string[]).includes(message ?? "") ? (message as LocationError) : "pathInvalid";
}

/**
 * Trim everything but the password, and take the forms people paste: a share
 * given as `\\host\share` or `//host/share` keeps only the share, an export
 * without its leading slash gets one.
 */
export function normalizeLocationInput(raw: {
    name?: unknown;
    protocol?: unknown;
    host?: unknown;
    path?: unknown;
    username?: unknown;
    password?: unknown;
    domain?: unknown;
}): Record<string, unknown> {
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const optional = (value: unknown) => {
        const trimmed = text(value);
        return trimmed.length > 0 ? trimmed : undefined;
    };
    const protocol = raw.protocol === "nfs" ? "nfs" : "smb";
    let path = text(raw.path);
    if (protocol === "smb") {
        const parts = path.split(/[\\/]+/).filter(Boolean);
        // `\\host\share` or `//host/share`: the share is the part after the host.
        if (/^[\\/]{2}/.test(path) && parts.length >= 2) path = parts.slice(1).join("/");
        else path = path.replace(/^[\\/]+|[\\/]+$/g, "");
    } else if (path && !path.startsWith("/")) {
        path = `/${path}`;
    }
    return {
        name: text(raw.name),
        protocol,
        host: text(raw.host).replace(/^[\\/]+/, "").replace(/\/+$/, ""),
        path,
        username: optional(raw.username),
        password: typeof raw.password === "string" && raw.password.length > 0 ? raw.password : undefined,
        domain: optional(raw.domain)
    };
}
