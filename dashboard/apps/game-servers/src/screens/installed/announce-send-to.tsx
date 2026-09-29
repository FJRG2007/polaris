"use client";

/**
 * Who an announcement goes to: everybody, the operators who are on, everybody
 * but them, the players in one game mode, or players picked out - one or several.
 *
 * The picked players are the ones online, plus anybody a template names who is
 * not on right now: a name that drops off the list without a word is a message
 * quietly sent to fewer people than it says.
 */

import { Checkbox, Select } from "@polaris/ui";
import { useGameText, useSchemaText } from "../game-text";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import {
    EVERYBODY,
    GAME_MODES,
    GAME_MODE_LABEL,
    MOST_PICKED,
    NON_OPERATORS,
    OPERATORS,
    gameModeTarget,
    isPickableName,
    parseTarget,
    playersTarget,
    type GameMode
} from "../../lib/minecraft/announce-target";

type Mode = "everybody" | "operators" | "others" | GameMode | "players";

export function SendTo({
    target,
    players,
    edition,
    onChange,
    problem
}: {
    target: string;
    /** Who is online now. */
    players: readonly string[];
    edition: MinecraftEdition;
    onChange: (target: string) => void;
    problem?: string;
}) {
    const schemaText = useSchemaText();
    const t = useGameText("minecraft");
    const audience = parseTarget(target);
    // An empty pick is still "picking players", with nobody ticked yet.
    const mode: Mode =
        audience?.kind === "gamemode" ? audience.mode : (audience?.kind ?? "players");
    const picked = audience?.kind === "players" ? audience.players : [];
    const offline = picked.filter(
        (name) => !players.some((one) => one.toLowerCase() === name.toLowerCase())
    );
    const listed = [...players, ...offline];

    function toggle(name: string, on: boolean): void {
        const next = on
            ? [...picked, name]
            : picked.filter((one) => one.toLowerCase() !== name.toLowerCase());
        onChange(playersTarget(next));
    }

    return (
        <div className="flex flex-col gap-2 text-sm">
            <span className="font-medium">{t("sendTo.sendTo")}</span>
            <Select
                value={mode}
                onValueChange={(value) => {
                    const mode = GAME_MODES.find((one) => one === value);
                    if (value === "everybody") onChange(EVERYBODY);
                    else if (value === "operators") onChange(OPERATORS);
                    else if (value === "others") onChange(NON_OPERATORS);
                    else if (mode) onChange(gameModeTarget(mode));
                    // Starts from whoever was already picked, or nobody.
                    else onChange(playersTarget(picked));
                }}
                options={[
                    { value: "everybody", label: t("sendTo.everybodyOnTheServer") },
                    // Bedrock keeps its operators by xuid, which the game will
                    // not aim a command at.
                    ...(edition === "java"
                        ? [
                              { value: "operators", label: t("sendTo.operatorsWhoAreOn") },
                              { value: "others", label: t("sendTo.everybodyButOperators") }
                          ]
                        : []),
                    ...GAME_MODES.map((one) => ({
                        value: one,
                        label: t("sendTo.playersIn", { mode: t(`playersTab.modes.${one}`) })
                    })),
                    { value: "players", label: t("sendTo.playersIPick") }
                ]}
                aria-label={t("sendTo.sendTo")}
            />
            {mode === "players" &&
                (listed.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {t("sendTo.nobodyIsOnTheServer")}
                    </p>
                ) : (
                    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto overscroll-contain rounded-md border border-border p-2">
                        {listed.map((name) => {
                            const checked = picked.some(
                                (one) => one.toLowerCase() === name.toLowerCase()
                            );
                            const pickable = isPickableName(name);
                            return (
                                <li key={name}>
                                    <label className="flex cursor-pointer items-center gap-2">
                                        <Checkbox
                                            checked={checked}
                                            disabled={
                                                !pickable ||
                                                (!checked && picked.length >= MOST_PICKED)
                                            }
                                            onChange={(event) => toggle(name, event.target.checked)}
                                        />
                                        <span>{name}</span>
                                        {!pickable && (
                                            <span className="text-xs text-muted-foreground">
                                                {t("sendTo.canTBePickedBy")}
                                            </span>
                                        )}
                                        {offline.includes(name) && (
                                            <span className="text-xs text-muted-foreground">
                                                {t("sendTo.notOnNow")}
                                            </span>
                                        )}
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                ))}
            {mode === "operators" && (
                <p className="text-xs text-muted-foreground">{t("sendTo.eachOperatorWhoIsOn")}</p>
            )}
            {mode === "others" && (
                <p className="text-xs text-muted-foreground">{t("sendTo.eachPlayerWhoIsOn")}</p>
            )}
            {problem && (
                <p role="alert" className="text-xs text-danger">
                    {schemaText(problem)}
                </p>
            )}
        </div>
    );
}
