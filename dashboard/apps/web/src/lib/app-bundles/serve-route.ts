/**
 * An installed app's route handlers, answered by the catch-all route of the
 * surface they live under (`/api/home/...`, `/api/minecraft/...`).
 *
 * The app's handler is called exactly as Next would have called it, with the
 * parameters its own path names rather than the catch-all's.
 *
 * Server-only.
 */

import { findAppRoute } from "./code";
import type { NextRequest } from "next/server";

type Handler = (
    request: NextRequest,
    context: { params: Promise<unknown> }
) => Promise<Response> | Response;

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** The handler a catch-all exports for one method. */
export function appRouteHandler(method: (typeof METHODS)[number]) {
    return async (request: NextRequest): Promise<Response> => {
        const hit = findAppRoute("route", request.nextUrl.pathname);
        if (!hit) return new Response("Not found", { status: 404 });
        const module = await hit.load();
        const handler = (module[method] ?? (method === "HEAD" ? module.GET : undefined)) as
            | Handler
            | undefined;
        if (typeof handler !== "function") {
            const allow = METHODS.filter((name) => typeof module[name] === "function");
            return new Response(null, { status: 405, headers: { allow: allow.join(", ") } });
        }
        return handler(request, { params: Promise.resolve(hit.params) });
    };
}
