/**
 * What a website form post is, read without trusting the page that sent it.
 *
 * The conventions are the ones static-site form services settled on (Formspree,
 * Basin, Getform, Netlify Forms): a plain `<form method="POST">` is answered
 * with a redirect, a `fetch` asking for JSON gets JSON, a hidden field is the
 * honeypot, and fields beginning with `_` steer the post rather than being part
 * of it. Files are not kept: a form trigger takes text fields only.
 *
 * Pure: no database, no request context, so every rule is asserted in a test.
 */

import * as core from "@polaris/core";

/** Bounds on what one post may carry. */
export const FORM_LIMITS = {
    fields: 50,
    nameLength: 100,
    valueLength: 10_000,
    totalText: 64 * 1024
} as const;

export type FormReading =
    | { ok: true; fields: Record<string, string>; spam: boolean }
    | { ok: false; reason: "invalidJson" | "tooLarge" };

/** Sort name/value pairs into the fields kept, bounded; the honeypot says whether it is spam. */
export function collectFields(pairs: Iterable<[string, string]>, honeypotField: string): FormReading {
    const fields: Record<string, string> = {};
    let total = 0;
    let spam = false;
    for (const [rawName, rawValue] of pairs) {
        const name = rawName.trim();
        if (!name || name.length > FORM_LIMITS.nameLength) continue;
        const value = rawValue.slice(0, FORM_LIMITS.valueLength);
        if (name === honeypotField) {
            if (value.trim()) spam = true;
            continue;
        }
        if (name.startsWith("_")) continue;
        if (!(name in fields) && Object.keys(fields).length >= FORM_LIMITS.fields) continue;
        total += value.length;
        if (total > FORM_LIMITS.totalText) return { ok: false, reason: "tooLarge" };
        // A repeated name (checkboxes) is one field, its values joined.
        fields[name] = name in fields ? `${fields[name]}, ${value}` : value;
    }
    return { ok: true, fields, spam };
}

function flatValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(flatValue).join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

/** Read a body in any of the three encodings a form posts with. */
export async function readFormBody(
    bytes: Uint8Array,
    contentType: string,
    honeypotField: string
): Promise<FormReading> {
    const type = contentType.toLowerCase();
    if (bytes.length === 0) return collectFields([], honeypotField);
    if (type.includes("multipart/form-data")) {
        let data: FormData;
        try {
            data = await new Response(Buffer.from(bytes), { headers: { "content-type": contentType } }).formData();
        } catch {
            return { ok: false, reason: "invalidJson" };
        }
        const pairs: [string, string][] = [];
        for (const [name, value] of data.entries()) if (typeof value === "string") pairs.push([name, value]);
        return collectFields(pairs, honeypotField);
    }
    const text = new TextDecoder().decode(bytes);
    if (type.includes("json")) {
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            return { ok: false, reason: "invalidJson" };
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalidJson" };
        return collectFields(
            Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, flatValue(value)]),
            honeypotField
        );
    }
    return collectFields(new URLSearchParams(text).entries(), honeypotField);
}

/** JSON for `fetch`/XHR (it asks for it, or posts JSON), a redirect for a plain form. */
export function formAnswerMode(headers: Headers): "json" | "redirect" {
    const accept = headers.get("accept") ?? "";
    const type = headers.get("content-type") ?? "";
    if (accept.includes("application/json") || type.includes("application/json")) return "json";
    if (headers.get("x-requested-with")?.toLowerCase() === "xmlhttprequest") return "json";
    return "redirect";
}

/** The origin a browser says the post came from, from Origin or else Referer. */
export function requestOrigin(headers: Headers): string {
    const origin = headers.get("origin");
    if (origin && origin !== "null") return origin.toLowerCase();
    const referer = headers.get("referer");
    if (!referer) return "";
    try {
        return new URL(referer).origin.toLowerCase();
    } catch {
        return "";
    }
}

/** CORS headers for an origin: echoed only when the form takes posts from it. */
export function formCorsHeaders(form: core.WebhookForm, origin: string): Record<string, string> {
    if (!origin || !core.formOriginAllowed(form.allowedOrigins, origin)) return { vary: "Origin" };
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Accept, X-Requested-With",
        "access-control-max-age": "600",
        vary: "Origin"
    };
}

/** One CSV cell, quoted, with a leading formula character defused. */
export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
}

/** Submissions as CSV, every field any of them sent as a column. */
export function submissionsCsv(rows: readonly { at: string; fields: Record<string, string> }[]): string {
    const columns: string[] = [];
    for (const row of rows) for (const key of Object.keys(row.fields)) if (!columns.includes(key)) columns.push(key);
    const header = ["submitted", ...columns].map(csvCell).join(",");
    const lines = rows.map((row) => [row.at, ...columns.map((key) => row.fields[key] ?? "")].map(csvCell).join(","));
    return `${[header, ...lines].join("\r\n")}\r\n`;
}
