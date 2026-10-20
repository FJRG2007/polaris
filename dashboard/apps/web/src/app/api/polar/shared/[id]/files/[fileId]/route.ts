/**
 * GET /api/polar/shared/<id>/files/<fileId> - a file shown in a Polar chat
 * somebody sent the signed-in person. Readable only while they are still a
 * recipient, and only when the snapshot shows that file.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { readReceivedPolarFile } from "@/lib/polar/share";
import { sharedFileResponse } from "@/lib/polar/share-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string; fileId: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const { id, fileId } = await params;
    const file = idSchema.safeParse(fileId);
    if (!file.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
        return sharedFileResponse(request, await readReceivedPolarFile(user.id, id, file.data));
    } catch (error) {
        console.error("polar: could not read a shared file", error);
        return NextResponse.json({ error: "storage_failed" }, { status: 503 });
    }
}
