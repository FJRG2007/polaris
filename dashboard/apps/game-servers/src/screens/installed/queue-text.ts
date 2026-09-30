/**
 * A waiting action, said in the reader's language: what it will do, and what it
 * is waiting for. The same wording `lib/minecraft/queue.ts` keeps in English for
 * logs, from the `minecraft` catalog.
 */

import type { GameText } from "../game-text";
import type { QueuedAction } from "../../lib/minecraft/queue";

/** What is waiting, in a sentence somebody can act on. */
export function describeQueuedText(t: GameText<"minecraft">, action: QueuedAction): string {
    const payload = action.payload;
    switch (payload.kind) {
        case "give":
            return t("queue.give", { count: payload.count, item: payload.item });
        case "clear":
            return t("queue.clear", { count: payload.count, item: payload.item });
        case "clear-all":
            return t("queue.clearAll");
        case "set-slot":
            return t("queue.setSlot", {
                count: payload.count,
                item: payload.item,
                slot: payload.slot
            });
        case "import-bag":
            return t(payload.mode === "replace" ? "queue.importReplace" : "queue.importFill", {
                count: payload.items.length
            });
        case "ban":
            return payload.reason ? t("queue.banFor", { reason: payload.reason }) : t("queue.ban");
        case "pardon":
            return t("queue.pardon");
        case "op":
            return t("queue.op");
        case "deop":
            return t("queue.deop");
        case "whitelist-add":
            return t("queue.whitelistAdd");
        case "whitelist-remove":
            return t("queue.whitelistRemove");
    }
}

/** What it is waiting for, so a row says why nothing has happened. */
export function waitingOnText(t: GameText<"minecraft">, action: QueuedAction): string {
    return action.needsPlayer ? t("queue.waitingPlayer") : t("queue.waitingServer");
}
