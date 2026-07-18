/**
 * Streaming upload. The request body is piped straight into the connection's
 * driver, so an arbitrarily large file never lands in memory. An optional offset
 * query resumes an interrupted upload on drivers that support random writes.
 * Node runtime; Server Actions are avoided here because they buffer the body.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriver } from "@/lib/storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.write"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    const rawPath = url.searchParams.get("p") ?? "";
    const name = url.searchParams.get("name");
    const offsetParam = url.searchParams.get("offset");
    if (!connectionId || !name) return new Response("Missing parameters", { status: 400 });
    if (!request.body) return new Response("Empty body", { status: 400 });

    let target: string;
    try {
        target = normalizeRelPath(rawPath ? `${rawPath}/${name}` : name);
    } catch {
        return new Response("Invalid path", { status: 400 });
    }

    const offset = offsetParam ? Number(offsetParam) : undefined;
    const driver = await getDriver(connectionId, user.id);
    try {
        const stat = await driver.writeStream(target, request.body, { offset });
        return Response.json({ ok: true, path: stat.path, size: stat.size.toString() });
    } catch (error) {
        return new Response(error instanceof Error ? error.message : "Upload failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
