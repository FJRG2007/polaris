/**
 * Kept runtime logs, searched: across the services named, inside a time range,
 * for a phrase, a page at a time and newest first. `next` is handed back for the
 * page before this one, so a reader scrolling up asks for one page at a time.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { readableServices, searchRuntimeLogs } from "@/lib/deploy/runtime-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z
    .object({
        services: z
            .string()
            .transform((raw) =>
                raw
                    .split(",")
                    .map((id) => id.trim())
                    .filter(Boolean)
            )
            .pipe(z.array(z.string().uuid()).min(1).max(50)),
        q: z
            .string()
            .transform((raw) => raw.trim())
            .pipe(z.string().max(200))
            .optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        before: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200)
    })
    .refine((query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to), {
        message: "The start of the range is after its end."
    });

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;

    const params = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse({
        services: params.get("services") ?? "",
        q: params.get("q") ?? undefined,
        from: params.get("from") || undefined,
        to: params.get("to") || undefined,
        before: params.get("before") || undefined,
        limit: params.get("limit") ?? undefined
    });
    if (!parsed.success) {
        return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? "Invalid search" },
            { status: 400 }
        );
    }

    const services = await readableServices(user.id, parsed.data.services);
    if (services.length === 0)
        return NextResponse.json({ error: "Service not found" }, { status: 404 });

    const page = await searchRuntimeLogs({
        serviceIds: services.map((service) => service.id),
        ...(parsed.data.q ? { text: parsed.data.q } : {}),
        ...(parsed.data.from ? { from: new Date(parsed.data.from) } : {}),
        ...(parsed.data.to ? { to: new Date(parsed.data.to) } : {}),
        ...(parsed.data.before ? { before: parsed.data.before } : {}),
        limit: parsed.data.limit
    });
    return NextResponse.json(page);
}
