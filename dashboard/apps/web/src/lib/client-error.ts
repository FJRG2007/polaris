/**
 * What a page that could not be drawn reports to the server
 * (`/api/client-error`), and the one line the server logs it as.
 *
 * Kept to what says where to look: the error's name, its first line, the
 * digest, the page's path and the first frames of the stack, each address cut
 * to its path and anything that reads like an email, a token or a long number
 * masked - on the way out and again on the way in.
 */

import { z } from "zod";

export const CLIENT_ERROR_PATH = "/api/client-error";

const MAX_FRAMES = 8;

export const clientErrorSchema = z.object({
    name: z.string().trim().max(120).optional(),
    message: z.string().max(2_048).optional(),
    digest: z.string().trim().max(120).optional(),
    stack: z.string().max(8_192).optional(),
    path: z.string().trim().max(2_048).optional(),
    boundary: z.enum(["global", "app"]).optional()
});

export type ClientErrorReport = z.infer<typeof clientErrorSchema>;

/** A text with what could name somebody or open something masked: addresses
 *  down to their path, emails, and long numbers or tokens. */
export function redact(text: string): string {
    return text
        .replace(/\bhttps?:\/\/[^\s)'"]+/gi, (url) => {
            try {
                return new URL(url).pathname;
            } catch {
                return "<url>";
            }
        })
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
        .replace(/\b[a-f0-9-]{24,}\b/gi, "<id>")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<token>")
        .replace(/\b\d{7,}\b/g, "<n>");
}

/** The one line a report is logged as. */
export function clientErrorLine(report: ClientErrorReport): string {
    const first = redact((report.message ?? "").split("\n")[0] ?? "").slice(0, 300);
    const path = redact((report.path ?? "").split(/[?#]/)[0] ?? "").slice(0, 200);
    const frames = (report.stack ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("at ") || line.includes("@"))
        .slice(0, MAX_FRAMES)
        .map((line) => redact(line).slice(0, 200));
    return [
        `polaris: page error (${report.boundary ?? "global"}) on ${path || "?"}:`,
        `${(report.name ?? "Error").slice(0, 60)}: ${first || "(no message)"}`,
        report.digest ? `digest=${redact(report.digest)}` : "",
        frames.length > 0 ? `| ${frames.join(" | ")}` : ""
    ]
        .filter(Boolean)
        .join(" ");
}

/** The errors already reported, so a boundary drawn twice reports once. */
const sent = new WeakSet<object>();

/** Tell the server what `error` was, once per error object. Never throws: it
 *  runs on the screen that is already reporting a failure. */
export function reportClientError(error: unknown, boundary: "global" | "app"): void {
    try {
        if (typeof window === "undefined" || typeof fetch !== "function") return;
        const value = error instanceof Error ? error : new Error(String(error));
        if (sent.has(value)) return;
        sent.add(value);
        const report: ClientErrorReport = {
            name: value.name.slice(0, 120),
            message: redact(value.message).slice(0, 2_048),
            digest: (value as { digest?: unknown }).digest
                ? String((value as { digest?: unknown }).digest).slice(0, 120)
                : undefined,
            stack: redact(value.stack ?? "").slice(0, 8_192),
            path: window.location.pathname.slice(0, 2_048),
            boundary
        };
        void fetch(CLIENT_ERROR_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
            keepalive: true
        }).catch(() => undefined);
    } catch {
        // Reporting is a courtesy; the screen does not depend on it.
    }
}
