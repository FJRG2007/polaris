/**
 * GET /c/<token>/files/<fileId> - a file shown in a shared Polar chat, for
 * anyone holding the link. The token is the credential: a file the snapshot
 * does not show, or a link that is off or gone, answers 404 the same way.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { sharedFileResponse } from "@/lib/polar/share-file";
import { readSharedPolarFileByToken } from "@/lib/polar/share";
import { gatePolarShare } from "@/lib/polar/share-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ token: string; fileId: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const limited = await rateLimit(`polar-shared:${(await clientIp()) ?? "unknown"}`, 120, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const { token, fileId } = await params;
    const file = idSchema.safeParse(fileId);
    if (!file.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // The same gate as the page, so a file is not one password short of it. Its
    // opens are not counted: the page that shows it already was.
    const gate = await gatePolarShare(token);
    if (!gate.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
        return sharedFileResponse(request, await readSharedPolarFileByToken(token, file.data));
    } catch (error) {
        console.error("polar: could not read a shared file", error);
        return NextResponse.json({ error: "storage_failed" }, { status: 503 });
    }
}
