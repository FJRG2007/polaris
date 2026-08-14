/**
 * Files attached to a vault item.
 *
 * Two steps, which is Bitwarden's "v2" flow and worth keeping: the client first
 * says how big the file is and what its encrypted name is, gets an id and a URL
 * back, and only then sends the bytes. That means a file too large for this
 * deployment is refused before anything is uploaded rather than after.
 *
 * The bytes are already encrypted when they arrive - under a key derived from
 * the item's own - so what is stored is opaque, and the name on disk is a random
 * id rather than the file's own name.
 */

import { prisma } from "@polaris/db";
import * as blobs from "@/lib/vault/blobs";
import { isEncString } from "@polaris/core";
import { vaultError } from "@/lib/vault/auth";
import { getCipher } from "@/lib/vault/ciphers";
import { bumpRevision } from "@/lib/vault/account";
import { readJsonBody, requirePrincipal, type VaultContext } from "@/lib/vault/api/router";

/** Whether this account may write to the item an attachment belongs to. */
async function ownedCipher(userId: string, cipherId: string): Promise<boolean> {
    return (await getCipher(userId, cipherId)) !== null;
}

/** Step one: reserve the attachment and say where to send the bytes. */
export async function beginUpload(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const cipherId = context.params.id ?? "";
    if (!(await ownedCipher(principal.userId, cipherId))) return vaultError("Not found", 404);

    const body = (await readJsonBody(context.request)) as {
        fileName?: unknown;
        key?: unknown;
        fileSize?: unknown;
    } | null;
    const fileName = typeof body?.fileName === "string" ? body.fileName : "";
    const key = typeof body?.key === "string" ? body.key : null;
    const size = Number(body?.fileSize ?? 0);

    if (!isEncString(fileName)) return vaultError("The file name must be encrypted.", 400);
    if (key !== null && !isEncString(key)) return vaultError("The file key must be encrypted.", 400);
    if (!Number.isFinite(size) || size <= 0) return vaultError("Invalid file size", 400);
    if (size > blobs.MAX_BLOB_BYTES) {
        return vaultError("That file is larger than this server accepts.", 413);
    }

    const attachment = await prisma.vaultAttachment.create({
        data: {
            cipherId,
            fileName,
            key,
            size: BigInt(size),
            storedPath: blobs.vaultBlobPath("attachment", principal.userId)
        },
        select: { id: true }
    });

    return Response.json({
        object: "attachment-fileUpload",
        attachmentId: attachment.id,
        // "Direct" means the client posts to this server rather than to a signed
        // cloud URL. Polaris holds its own storage, so there is nothing to sign.
        fileUploadType: 0,
        url: `/vault/api/ciphers/${cipherId}/attachment/${attachment.id}`,
        cipherResponse: await getCipher(principal.userId, cipherId)
    });
}

/** Step two: the bytes. */
export async function receiveUpload(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const cipherId = context.params.id ?? "";
    const attachmentId = context.params.attachmentId ?? "";
    if (!(await ownedCipher(principal.userId, cipherId))) return vaultError("Not found", 404);

    const attachment = await prisma.vaultAttachment.findFirst({
        where: { id: attachmentId, cipherId },
        select: { storedPath: true, size: true }
    });
    if (!attachment) return vaultError("Not found", 404);

    // Multipart, because that is what clients send. The part holding the bytes
    // is the only one that matters; the rest is form scaffolding.
    let bytes: Uint8Array | null = null;
    try {
        const form = await context.request.formData();
        for (const value of form.values()) {
            if (value instanceof File) {
                bytes = new Uint8Array(await value.arrayBuffer());
                break;
            }
        }
    } catch {
        bytes = null;
    }
    if (!bytes) return vaultError("No file was sent.", 400);
    if (bytes.byteLength > blobs.MAX_BLOB_BYTES) {
        return vaultError("That file is larger than this server accepts.", 413);
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
    const stored = await blobs.writeVaultBlob(attachment.storedPath, stream);
    // The size is re-recorded from what actually arrived: the figure in step one
    // was the client's claim, and the row should say what is on disk.
    await prisma.vaultAttachment.update({
        where: { id: attachmentId },
        data: { size: stored.size }
    });
    await bumpRevision(principal.userId);
    return new Response(null, { status: 201 });
}

/** The bytes back, still encrypted. */
export async function download(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const cipherId = context.params.id ?? "";
    if (!(await ownedCipher(principal.userId, cipherId))) return vaultError("Not found", 404);

    const attachment = await prisma.vaultAttachment.findFirst({
        where: { id: context.params.attachmentId ?? "", cipherId },
        select: { storedPath: true, size: true }
    });
    if (!attachment) return vaultError("Not found", 404);

    const driver = await blobs.vaultBlobDriver();
    try {
        const stream = await driver.readStream(attachment.storedPath);
        return new Response(stream as unknown as BodyInit, {
            headers: {
                "content-type": "application/octet-stream",
                "content-length": attachment.size.toString(),
                "cache-control": "no-store"
            }
        });
    } catch {
        return vaultError("That file could not be read.", 404);
    } finally {
        await driver.dispose();
    }
}

/** Remove an attachment and its bytes. */
export async function remove(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const cipherId = context.params.id ?? "";
    if (!(await ownedCipher(principal.userId, cipherId))) return vaultError("Not found", 404);

    const attachment = await prisma.vaultAttachment.findFirst({
        where: { id: context.params.attachmentId ?? "", cipherId },
        select: { id: true, storedPath: true }
    });
    if (!attachment) return vaultError("Not found", 404);
    await prisma.vaultAttachment.delete({ where: { id: attachment.id } });
    await blobs.deleteVaultBlob(attachment.storedPath);
    await bumpRevision(principal.userId);
    return new Response(null, { status: 200 });
}
