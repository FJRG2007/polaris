"use server";

/**
 * Storage locations (/admin/storage): the NAS shares Polaris can keep service
 * data on, how full each one is, and moving a service's volume between them.
 * Everything here is for whoever runs the instance.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import * as moves from "@/lib/storage-moves/service";
import { createConnectionSchema } from "@polaris/core";
import { createConnection } from "@/lib/storage-service";
import { locationError, locationInputSchema, normalizeLocationInput } from "@/lib/storage-moves/location-input";

const idSchema = z.string().uuid();

export async function locationsAction(): Promise<moves.LocationsView> {
    await requireAdmin();
    return moves.listLocations();
}

/** Connect to one NAS location and read its size; also the connection test. */
export async function locationSpaceAction(id: string): Promise<moves.SpaceResult> {
    await requireAdmin();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { ok: false, reason: "missing" };
    return moves.locationSpace(parsed.data);
}

export async function volumeLocationsAction(): Promise<moves.VolumeLocationView[]> {
    await requireAdmin();
    return moves.listVolumeLocations();
}

export async function movesAction(): Promise<moves.MoveView[]> {
    await requireAdmin();
    return moves.listMoves();
}

/** Add a NAS share as a location. Its password is stored encrypted, like every
 *  storage connection's; the share also appears in Drive for its owner. */
export async function addLocationAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = locationInputSchema.safeParse(
        normalizeLocationInput((input ?? {}) as Record<string, unknown>)
    );
    if (!parsed.success) {
        return { error: t(`storage.form.errors.${locationError(parsed.error.issues[0]?.message)}`) };
    }
    const value = parsed.data;
    const connection = createConnectionSchema.safeParse(
        value.protocol === "smb"
            ? {
                  name: value.name,
                  config: {
                      kind: "smb",
                      host: value.host,
                      share: value.path,
                      ...(value.domain ? { domain: value.domain } : {}),
                      ...(value.username ? { username: value.username } : {})
                  },
                  credentials: { kind: "smb", ...(value.password ? { password: value.password } : {}) }
              }
            : {
                  name: value.name,
                  config: { kind: "nfs", host: value.host, exportPath: value.path },
                  credentials: { kind: "nfs" }
              }
    );
    if (!connection.success) return { error: t("storage.form.errors.pathInvalid") };
    const created = await createConnection(
        admin.id,
        connection.data.name,
        connection.data.config.kind,
        connection.data.config,
        connection.data.credentials
    );
    await recordAudit({
        actorId: admin.id,
        action: "connection.create",
        targetType: "connection",
        targetId: created.id,
        metadata: { name: value.name, kind: value.protocol, from: "storage-locations" }
    });
    revalidatePath("/admin/storage");
    return { id: created.id };
}

const startSchema = z.object({
    volumeId: z.string().uuid(),
    destination: z.union([z.literal("server"), z.string().uuid()])
});

export async function startMoveAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) return { error: t("storage.move.refused.notOffered") };
    const result = await moves.startMove({
        ...parsed.data,
        actorId: admin.id,
        serverLabel: t("storage.thisServer")
    });
    if ("refused" in result) return { error: t(`storage.move.refused.${result.refused}`) };
    await recordAudit({
        actorId: admin.id,
        action: "storage.move.start",
        targetType: "volume",
        targetId: parsed.data.volumeId,
        metadata: { moveId: result.id, destination: parsed.data.destination }
    });
    return { id: result.id };
}

const answerSchema = z.object({ id: z.string().uuid(), answer: z.enum(["remove", "keep"]) });

/** The answer to a finished move: empty the original, or keep it. */
export async function answerMoveAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) return { error: t("storage.moves.answerGone") };
    const done = await moves.answerMove(parsed.data.id, parsed.data.answer);
    if (done === "gone") return { error: t("storage.moves.answerGone") };
    if (done === "shared") return { error: t("storage.errors.originShared") };
    await recordAudit({
        actorId: admin.id,
        action: parsed.data.answer === "remove" ? "storage.move.remove-original" : "storage.move.keep-original",
        targetType: "storage-move",
        targetId: parsed.data.id
    });
    return {};
}
