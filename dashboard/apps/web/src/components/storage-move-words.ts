/**
 * A data move in words, the same on the servers screen and on the disk warning:
 * where it is going and which step it is on, with the copied figure while it
 * copies.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { ActiveMoveView } from "@/lib/storage-moves/service";

type Words = NamespaceTranslator<"components">;

export function moveSize(bytes: number): string {
    if (bytes < 1000 ** 3) return `${Math.max(0, Math.round(bytes / 1000 ** 2))} MB`;
    return `${(bytes / 1000 ** 3).toFixed(1)} GB`;
}

export function moveTarget(move: ActiveMoveView, t: Words): string {
    return move.targetLabel || t("storageMove.thisServer");
}

/**
 * The move a volume on this machine is part of: the one whose copier holds it,
 * or whose original it is by name. Null when it is not moving.
 */
export function moveOfVolume(
    volume: { readonly name: string; readonly heldBy: readonly { readonly name: string }[] },
    moves: readonly ActiveMoveView[]
): ActiveMoveView | null {
    const holders = new Set(volume.heldBy.map((holder) => holder.name.replace(/^\//, "")));
    return (
        moves.find(
            (move) =>
                move.dockerName === volume.name ||
                move.containers.some((container) => holders.has(container))
        ) ?? null
    );
}

/** The step a move is on, with the copied figure and share while it copies. */
export function movePhaseText(move: ActiveMoveView, t: Words): string {
    if (move.phase !== "copying") return t(`storageMove.phase.${move.phase}`);
    if (move.totalBytes === null || move.copiedBytes === null)
        return t("storageMove.phase.copyingUnknown");
    const copied = t("storageMove.phase.copying", {
        copied: moveSize(Math.min(move.copiedBytes, move.totalBytes)),
        total: moveSize(move.totalBytes)
    });
    return move.percent === null ? copied : `${copied} (${move.percent}%)`;
}
