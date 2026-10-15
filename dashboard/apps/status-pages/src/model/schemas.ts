/**
 * Every input the status pages take, normalized and then validated. Shared by
 * the server actions and the forms, so a field is held to the same rule on
 * both sides.
 */

import { z } from "zod";
import { INCIDENT_IMPACTS, INCIDENT_STATES } from "./incidents";
import {
    CHECK_KINDS,
    DNS_TYPES,
    MAX_INTERVAL_SEC,
    MAX_TIMEOUT_MS,
    MIN_INTERVAL_SEC,
    MIN_TIMEOUT_MS
} from "./checks";

const trimmed = (max: number) => z.string().trim().max(max);
const required = (max: number) => trimmed(max).min(1);
const id = z.string().uuid();

/** A slug as typed: lowercased, spaces to dashes, then held to the shape. */
export function normalizeSlug(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-");
}

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

const slug = z.preprocess(
    (value) => (typeof value === "string" ? normalizeSlug(value) : value),
    z.string().regex(SLUG_PATTERN)
);

export const pageInput = z.object({
    title: required(80),
    slug,
    description: trimmed(500).default(""),
    published: z.boolean().default(false)
});
export type PageInput = z.infer<typeof pageInput>;

export const componentInput = z.object({
    pageId: id,
    name: required(80),
    description: trimmed(300).default("")
});

const host = z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.:[\]-]+$/);

const httpUrl = z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((value) => {
        const url = new URL(value);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            !url.username &&
            !url.password
        );
    });

const checkBase = {
    componentId: id,
    intervalSec: z.coerce.number().int().min(MIN_INTERVAL_SEC).max(MAX_INTERVAL_SEC).default(60),
    timeoutMs: z.coerce.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(10_000),
    enabled: z.boolean().default(true)
};

const port = z.coerce.number().int().min(1).max(65_535);

export const checkInput = z.discriminatedUnion("kind", [
    z.object({
        ...checkBase,
        kind: z.literal("http"),
        target: httpUrl,
        expectStatus: z.coerce.number().int().min(100).max(599).nullable().default(null),
        keyword: trimmed(200).default("")
    }),
    z.object({ ...checkBase, kind: z.literal("tcp"), target: host, port }),
    z.object({ ...checkBase, kind: z.literal("ping"), target: host, port: port.default(443) }),
    z.object({
        ...checkBase,
        kind: z.literal("dns"),
        target: host,
        dnsType: z.enum(DNS_TYPES),
        dnsExpect: trimmed(255).default("")
    })
]);
export type CheckInput = z.infer<typeof checkInput>;

export const checkKind = z.enum(CHECK_KINDS);

export const incidentInput = z.object({
    pageId: id,
    title: required(120),
    impact: z.enum(INCIDENT_IMPACTS),
    state: z.enum(INCIDENT_STATES).default("investigating"),
    body: required(2000),
    componentIds: z.array(id).max(50).default([])
});

export const incidentUpdateInput = z.object({
    incidentId: id,
    state: z.enum(INCIDENT_STATES),
    body: required(2000)
});

export const maintenanceInput = z
    .object({
        pageId: id,
        title: required(120),
        body: trimmed(2000).default(""),
        componentIds: z.array(id).max(50).default([]),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date()
    })
    .refine((value) => value.endsAt.getTime() > value.startsAt.getTime(), {
        path: ["endsAt"],
        message: "endsBeforeStart"
    });

export const idInput = z.object({ id });

/** Names that never get a public certificate, so they cannot serve a page. */
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa"];

/** A typed domain as a bare hostname: no scheme, path, port or trailing dot. */
export function normalizeHostname(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.$/, "");
}

/** Whether a hostname can be a page's public address: a full public name, no
 *  wildcard, no IP, no private suffix. */
export function isCustomHostname(value: string): boolean {
    if (value.length > 253) return false;
    if (
        !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)
    ) {
        return false;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
    if (!/[a-z]/.test(value.slice(value.lastIndexOf(".") + 1))) return false;
    return !PRIVATE_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

export const customDomainInput = z.object({
    id,
    domain: z
        .preprocess(
            (value) => (typeof value === "string" ? normalizeHostname(value) : value),
            z.string().refine(isCustomHostname, { message: "hostname" })
        )
        .nullable()
});
