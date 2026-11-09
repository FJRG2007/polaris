/**
 * One file into an unfinished quick-send transfer, streamed straight to the
 * storage. Bounded twice: refused up front when the declared length is already
 * over what the transfer has left, and capped in flight, because a declared
 * length is the sender's word.
 */

import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import { storageRefusal } from "@/lib/storage-refusal";
import { cappedStream, wasTooLarge } from "@/lib/stream-cap";
import { isUnreachable, StorageRefused } from "@/lib/storage-target";
import { addFile, remainingBytes, TransferRefused } from "@/lib/disposable-transfer-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255)
});

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("drive.write");
    if (user instanceof Response) return user;
    const t = await readerWords("drive");
    const parsed = querySchema.safeParse({
        id: (await params).id,
        name: new URL(request.url).searchParams.get("name") ?? ""
    });
    if (!parsed.success || !request.body) {
        return Response.json({ error: t("disposable.errors.invalid") }, { status: 400 });
    }

    try {
        const left = await remainingBytes(user.id, parsed.data.id);
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (left <= 0 || (Number.isFinite(declared) && declared > left)) {
            return Response.json({ error: t("disposable.errors.tooLarge") }, { status: 413 });
        }
        const file = await addFile({
            ownerId: user.id,
            transferId: parsed.data.id,
            name: parsed.data.name,
            contentType: request.headers.get("content-type") ?? "application/octet-stream",
            body: cappedStream(request.body, left),
            declared: Number.isFinite(declared) && declared > 0 ? declared : undefined
        });
        return Response.json(file);
    } catch (caught) {
        if (wasTooLarge(caught)) {
            return Response.json({ error: t("disposable.errors.tooLarge") }, { status: 413 });
        }
        if (caught instanceof TransferRefused) {
            return Response.json({ error: t(caught.key) }, { status: 400 });
        }
        if (caught instanceof StorageRefused || isUnreachable(caught)) {
            console.error(caught);
            return Response.json(
                { error: await storageRefusal(caught, user.isAdmin) },
                { status: isUnreachable(caught) ? 503 : 502 }
            );
        }
        console.error(caught);
        return Response.json({ error: t("disposable.errors.generic") }, { status: 500 });
    }
}
