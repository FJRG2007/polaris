"use client";

/**
 * How long somebody is out for.
 *
 * The same form whichever game asked. A timeout is Polaris' own idea - the game's
 * ban plus a note of when it lifts - so nothing in it is about Minecraft or ARK,
 * and two copies of it would have drifted into two different sets of presets and
 * two different ceilings.
 *
 * The presets are the lengths a moderator actually reaches for; anything else is
 * typed, and checked here against the same bound the action re-checks.
 */

import { useState } from "react";
import type { GameKey } from "../../messages";
import { useGameText } from "../screens/game-text";
import { Input, Select } from "@polaris/ui";
import { MAX_TIMEOUT_MINUTES } from "../lib/player-timeout";
import { PlayerFormDialog, PlayerFormField } from "./player-form-dialog";

/** The lengths a moderator actually reaches for, and the one that means "the rest
 *  of the day". Anything else is typed. */
const TIMEOUT_PRESETS: { value: string; label: GameKey<"games"> }[] = [
    { value: "5", label: "timeoutDialog.presets.m5" },
    { value: "15", label: "timeoutDialog.presets.m15" },
    { value: "60", label: "timeoutDialog.presets.h1" },
    { value: "480", label: "timeoutDialog.presets.h8" },
    { value: "1440", label: "timeoutDialog.presets.d1" },
    { value: "custom", label: "timeoutDialog.presets.custom" }
];

export function PlayerTimeoutDialog({
    player,
    pending,
    error,
    onClose,
    onTimeout
}: {
    /** What to call them in the title - a username, a character name. */
    player: string;
    pending: boolean;
    /** What the server refused it with, shown inside the form rather than behind
     *  it on a page the reader has stopped looking at. */
    error?: string | null;
    onClose: () => void;
    onTimeout: (minutes: number, reason: string) => void;
}) {
    const t = useGameText("games");
    const [preset, setPreset] = useState("15");
    const [custom, setCustom] = useState("30");
    const [reason, setReason] = useState("");
    const minutes = preset === "custom" ? Number.parseInt(custom, 10) : Number.parseInt(preset, 10);
    const invalid =
        !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES
            ? t("timeoutDialog.between", { days: MAX_TIMEOUT_MINUTES / (24 * 60) })
            : null;

    return (
        <PlayerFormDialog
            title={t("timeoutDialog.title", { name: player })}
            description={t("timeoutDialog.theyAreBannedNowAnd")}
            onClose={onClose}
            pending={pending}
            ready={!invalid && !pending}
            confirmLabel={t("timeoutDialog.timeOut")}
            danger
            onConfirm={() => onTimeout(minutes, reason.trim())}
        >
            <PlayerFormField label={t("timeoutDialog.howLong")}>
                <Select
                    value={preset}
                    onValueChange={setPreset}
                    options={TIMEOUT_PRESETS.map((preset) => ({
                        value: preset.value,
                        label: t(preset.label)
                    }))}
                    aria-label={t("timeoutDialog.howLongTheTimeoutLasts")}
                />
            </PlayerFormField>
            {preset === "custom" && (
                <PlayerFormField label={t("timeoutDialog.minutes")} error={invalid}>
                    <Input
                        autoFocus
                        type="number"
                        min={1}
                        max={MAX_TIMEOUT_MINUTES}
                        value={custom}
                        onChange={(event) => setCustom(event.target.value)}
                    />
                </PlayerFormField>
            )}
            <PlayerFormField label={t("timeoutDialog.reasonShownToThem")} error={error ?? null}>
                <Input
                    value={reason}
                    maxLength={200}
                    placeholder={t("timeoutDialog.optional")}
                    onChange={(event) => setReason(event.target.value)}
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}
