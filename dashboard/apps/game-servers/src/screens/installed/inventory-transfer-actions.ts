"use server";

/**
 * Exporting players' bags to a file and importing them back. Exporting reads
 * (`games.read`); importing changes what somebody carries (`games.moderate`) and
 * is recorded like every other inventory write.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { gameWords, messageText } from "../game-words";
import { queueAction } from "../../lib/minecraft/queue-service";
import * as transfer from "../../lib/minecraft/inventory-transfer";
import * as service from "../../lib/minecraft/inventory-transfer-service";
import { getServerPlayers, withServerContainer } from "../../lib/minecraft/service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const playerName = z.string().trim().regex(/^[A-Za-z0-9_]{1,16}$/);

async function onlinePlayers(ownerId: string, installedAppId: string): Promise<string[]> {
    const status = await getServerPlayers(ownerId, installedAppId).catch(() => null);
    return status?.players.players ?? [];
}

async function problemText(problem: transfer.TransferProblem): Promise<string> {
    return (await gameWords("minecraft"))(`inventoryTransfer.problems.${problem}`);
}

/** Bags as a file: the players named, or every player on now or with a kept copy. */
export async function exportInventoriesAction(input: {
    installedAppId: string;
    players: string[] | "all";
}): Promise<{ file?: transfer.TransferFile; missing?: string[]; error?: string }> {
    const parsed = z
        .object({
            installedAppId: z.string().uuid(),
            players: z.union([z.literal("all"), z.array(playerName).min(1).max(transfer.MOST_PLAYERS)])
        })
        .safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    try {
        const { access } = await requireGameServer("games.read", parsed.data.installedAppId);
        const online = await onlinePlayers(access.ownerId, parsed.data.installedAppId);
        const result = await service.exportBags(access.ownerId, parsed.data.installedAppId, parsed.data.players, online);
        if (!result.file) return { error: t("inventoryTransfer.nothingToExport"), missing: result.missing };
        return { file: result.file, missing: result.missing };
    } catch (caught) {
        return { error: caught instanceof Error ? await messageText(caught.message) : t("inventoryTransfer.couldNotExport") };
    }
}

const importSchema = z.object({
    installedAppId: z.string().uuid(),
    text: z.string().max(transfer.MOST_FILE_CHARS),
    mode: z.enum(transfer.IMPORT_MODES),
    /** One bag into one player: which of the file's, and into whom. Absent, every
     *  bag in the file goes to the player of its own name. */
    single: z.object({ from: playerName, into: playerName }).nullable()
});

type ImportInput = z.infer<typeof importSchema>;

/** Who gets which bag, out of a file already read. */
function targetsOf(file: transfer.TransferFile, single: ImportInput["single"]): service.ImportTarget[] | null {
    if (!single) return file.players.map((player) => ({ player: player.name, items: player.items }));
    const from = file.players.find((player) => player.name.toLowerCase() === single.from.toLowerCase());
    return from ? [{ player: single.into, items: from.items }] : null;
}

/** What an import would change, player by player, before anything is written. */
export async function previewInventoryImportAction(input: ImportInput): Promise<{
    previews?: service.ImportPreview[];
    fileEra?: transfer.FileEra;
    error?: string;
}> {
    const parsed = importSchema.safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    const read = transfer.parseTransfer(parsed.data.text);
    if (!read.ok) return { error: await problemText(read.problem) };
    const targets = targetsOf(read.file, parsed.data.single);
    if (!targets) return { error: t("inventoryTransfer.problems.notInFile") };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const online = await onlinePlayers(access.ownerId, parsed.data.installedAppId);
        const preview = await service.previewImport(
            access.ownerId,
            parsed.data.installedAppId,
            targets,
            read.file.era,
            parsed.data.mode,
            online
        );
        if (!preview.fits)
            return {
                error: t("inventoryTransfer.problems.wrongSyntax", {
                    file: t(`inventoryTransfer.eras.${read.file.era}`),
                    server: preview.era ? t(`inventoryTransfer.eras.${preview.era}`) : t("inventoryTransfer.eras.none")
                })
            };
        return { previews: preview.previews, fileEra: read.file.era };
    } catch (caught) {
        return { error: caught instanceof Error ? await messageText(caught.message) : t("inventoryTransfer.couldNotImport") };
    }
}

const stackList = z.array(transfer.transferStackSchema).max(64);

/**
 * Import, as previewed. `seen` is each player's bag as the preview showed it:
 * the plan is worked out against it again here, and every slot is re-read and
 * written only while it still holds that. A player who is not on gets it when
 * they join.
 */
export async function importInventoriesAction(
    input: ImportInput & { seen: { player: string; items: z.infer<typeof stackList> }[] }
): Promise<{ outcomes?: service.ImportOutcome[]; error?: string }> {
    const parsed = importSchema
        .extend({ seen: z.array(z.object({ player: playerName, items: stackList })).max(transfer.MOST_PLAYERS) })
        .safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    const read = transfer.parseTransfer(parsed.data.text);
    if (!read.ok) return { error: await problemText(read.problem) };
    const targets = targetsOf(read.file, parsed.data.single);
    if (!targets) return { error: t("inventoryTransfer.problems.notInFile") };
    const { installedAppId, mode } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        const online = new Set((await onlinePlayers(access.ownerId, installedAppId)).map((name) => name.toLowerCase()));
        const seen = new Map(parsed.data.seen.map((one) => [one.player.toLowerCase(), one.items]));
        const outcomes: service.ImportOutcome[] = [];
        await withServerContainer(access.ownerId, installedAppId, async (server) => {
            if (read.file.era !== "plain") {
                const era = await service.serverEra(server, targets[0]!.player);
                if (era === null || !transfer.eraFits(read.file.era, era))
                    throw new Error(
                        t("inventoryTransfer.problems.wrongSyntax", {
                            file: t(`inventoryTransfer.eras.${read.file.era}`),
                            server: era ? t(`inventoryTransfer.eras.${era}`) : t("inventoryTransfer.eras.none")
                        })
                    );
            }
            for (const target of targets) {
                if (!online.has(target.player.toLowerCase())) {
                    await queueAction({
                        installedAppId,
                        username: target.player,
                        payload: { kind: "import-bag", mode, items: target.items },
                        requestedById: user.id
                    });
                    outcomes.push({ player: target.player, written: 0, skipped: [], queued: true });
                    continue;
                }
                const plan = transfer.planImport(seen.get(target.player.toLowerCase()) ?? [], target.items, mode);
                const done = await service.applyPlanNow(server, installedAppId, target.player, plan);
                outcomes.push({ player: target.player, ...done, queued: false });
            }
        });
        for (const outcome of outcomes)
            await recordAudit({
                actorId: user.id,
                action: "minecraft.inventory-import",
                targetType: "installedApp",
                targetId: installedAppId,
                metadata: {
                    player: outcome.player,
                    mode,
                    written: outcome.written,
                    skipped: outcome.skipped.length,
                    queued: outcome.queued,
                    ...(parsed.data.single ? { from: parsed.data.single.from } : {})
                }
            });
        return { outcomes };
    } catch (caught) {
        return { error: caught instanceof Error ? await messageText(caught.message) : t("inventoryTransfer.couldNotImport") };
    }
}
