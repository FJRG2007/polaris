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
import { Input, Select } from "@polaris/ui";
import { MAX_TIMEOUT_MINUTES } from "@/lib/apps/player-timeout";
import { PlayerFormDialog, PlayerFormField } from "@/components/player-form-dialog";

/** The lengths a moderator actually reaches for, and the one that means "the rest
 *  of the day". Anything else is typed. */
const TIMEOUT_PRESETS = [
    { value: "5", label: "5 minutes" },
    { value: "15", label: "15 minutes" },
    { value: "60", label: "1 hour" },
    { value: "480", label: "8 hours" },
    { value: "1440", label: "1 day" },
    { value: "custom", label: "Another length" }
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
    const [preset, setPreset] = useState("15");
    const [custom, setCustom] = useState("30");
    const [reason, setReason] = useState("");
    const minutes = preset === "custom" ? Number.parseInt(custom, 10) : Number.parseInt(preset, 10);
    const invalid =
        !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES
            ? `Between 1 minute and ${MAX_TIMEOUT_MINUTES / (24 * 60)} days`
            : null;

    return (
        <PlayerFormDialog
            title={`Time ${player} out`}
            description="They are banned now and let back in when it runs out, without anybody having to remember."
            onClose={onClose}
            pending={pending}
            ready={!invalid && !pending}
            confirmLabel="Time out"
            danger
            onConfirm={() => onTimeout(minutes, reason.trim())}
        >
            <PlayerFormField label="How long">
                <Select
                    value={preset}
                    onValueChange={setPreset}
                    options={TIMEOUT_PRESETS}
                    aria-label="How long the timeout lasts"
                />
            </PlayerFormField>
            {preset === "custom" && (
                <PlayerFormField label="Minutes" error={invalid}>
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
            <PlayerFormField label="Reason (shown to them)" error={error ?? null}>
                <Input
                    value={reason}
                    maxLength={200}
                    placeholder="Optional"
                    onChange={(event) => setReason(event.target.value)}
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}
