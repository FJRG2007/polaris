"use client";

/**
 * Who an announcement goes to: everybody, the operators who are on, or players
 * picked out - one or several.
 *
 * The picked players are the ones online, plus anybody a template names who is
 * not on right now: a name that drops off the list without a word is a message
 * quietly sent to fewer people than it says.
 */

import { Checkbox, Select } from "@polaris/ui";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import {
    EVERYBODY,
    MOST_PICKED,
    OPERATORS,
    isPickableName,
    parseTarget,
    playersTarget
} from "../../lib/minecraft/announce-target";

type Mode = "everybody" | "operators" | "players";

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
    const audience = parseTarget(target);
    // An empty pick is still "picking players", with nobody ticked yet.
    const mode: Mode = audience?.kind ?? "players";
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
            <span className="font-medium">Send to</span>
            <Select
                value={mode}
                onValueChange={(value) => {
                    if (value === "everybody") onChange(EVERYBODY);
                    else if (value === "operators") onChange(OPERATORS);
                    // Starts from whoever was already picked, or nobody.
                    else onChange(playersTarget(picked));
                }}
                options={[
                    { value: "everybody", label: "Everybody on the server" },
                    // Bedrock keeps its operators by xuid, which the game will
                    // not aim a command at.
                    ...(edition === "java"
                        ? [{ value: "operators", label: "Operators who are on" }]
                        : []),
                    { value: "players", label: "Players I pick" }
                ]}
                aria-label="Send to"
            />
            {mode === "players" &&
                (listed.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nobody is on the server right now.</p>
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
                                                can't be picked by name
                                            </span>
                                        )}
                                        {offline.includes(name) && (
                                            <span className="text-xs text-muted-foreground">
                                                not on now
                                            </span>
                                        )}
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                ))}
            {mode === "operators" && (
                <p className="text-xs text-muted-foreground">
                    Each operator who is on when it is sent.
                </p>
            )}
            {problem && (
                <p role="alert" className="text-xs text-danger">
                    {problem}
                </p>
            )}
        </div>
    );
}
