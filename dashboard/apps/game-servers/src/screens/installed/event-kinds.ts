/**
 * What each kind of event is called, what it is and what it counts, in the
 * reader's language. The catalog in `lib/minecraft/events` keeps the kinds and
 * their English; the words a screen shows are under `events.kinds`.
 */

import type { GameText } from "../game-text";
import type { GameKey } from "../../../messages";
import * as catalog from "../../lib/minecraft/events/catalog";

type Kind = catalog.EventKind;

export function kindLabel(t: GameText<"minecraft">, kind: Kind): string {
    return t(`events.kinds.${kind}.label` as GameKey<"minecraft">);
}

export function kindSummary(t: GameText<"minecraft">, kind: Kind): string {
    return t(`events.kinds.${kind}.summary` as GameKey<"minecraft">);
}

/** What a score counts, or nothing for a kind that keeps no score. */
export function kindUnit(t: GameText<"minecraft">, kind: Kind): string {
    return catalog.KIND_INFO[kind].unit
        ? t(`events.kinds.${kind}.unit` as GameKey<"minecraft">)
        : "";
}
