"use client";

/**
 * Choosing one of the players who are on: the list a busy server has is typed
 * down to the name somebody came for, and only so many rows are drawn at once.
 *
 * The same field wherever a player is picked from who is online - who an
 * inventory is sent to, who a kept console command is run for - so it reads and
 * behaves the same in each.
 */

import { useMemo } from "react";
import { useGameText } from "../game-text";
import { SearchableSelect } from "@polaris/ui";

/** Rows drawn at once; the rest are reached by typing. */
export const PLAYER_PICKER_LIMIT = 100;

export function PlayerPicker({
    players,
    value,
    onValueChange,
    placeholder,
    className,
    id,
    allowTyped,
    "aria-label": ariaLabel
}: {
    /** Who can be picked, in the order they are listed. */
    players: readonly string[];
    value: string;
    onValueChange: (name: string) => void;
    placeholder?: string;
    className?: string;
    id?: string;
    /** Whether a name typed into the search can be chosen when nobody online
     *  has it, for what is done to a player who is not on. */
    allowTyped?: boolean;
    "aria-label"?: string;
}) {
    const t = useGameText("games");
    // A name already chosen stays on the list after its player leaves, or when it
    // came as a default, so the field never shows a blank over a real value.
    const options = useMemo(
        () =>
            (value && !players.includes(value) ? [value, ...players] : players).map((name) => ({
                value: name,
                label: name
            })),
        [players, value]
    );
    return (
        <SearchableSelect
            id={id}
            aria-label={ariaLabel}
            value={value}
            onValueChange={onValueChange}
            options={options}
            placeholder={placeholder ?? t("playerPicker.choose")}
            searchPlaceholder={t("playerPicker.search")}
            emptyText={t("playerPicker.noMatch")}
            limit={PLAYER_PICKER_LIMIT}
            moreText={(hidden) => t("playerPicker.more", { count: hidden })}
            typedText={allowTyped ? (name) => t("playerPicker.useTyped", { name }) : undefined}
            className={className}
        />
    );
}
