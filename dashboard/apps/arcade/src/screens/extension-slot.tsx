"use client";

/**
 * What Games draws inside core screens, by slot kind. `call-activity` is a game
 * inside a call: the call screen draws it and drives the session over the
 * frame's messages (README, "Embed contract").
 */

import { GameFrame } from "./game-frame";
import { findGame } from "../games/registry";
import type { AppHostTypes } from "@polaris/app-host";

type AppSlot = AppHostTypes["AppSlot"];

export function ArcadeSlot({ slot }: { slot: AppSlot }) {
    switch (slot.kind) {
        case "call-activity": {
            const game = findGame((slot.props as { gameId: string }).gameId);
            return game ? <GameFrame game={game} /> : null;
        }
        default:
            return null;
    }
}
