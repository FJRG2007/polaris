"use client";

/**
 * Expiry picker for shares and drop points. Offers "never", quick relative presets
 * (minutes/hours), a custom amount of hours/days/weeks, or a specific date (and
 * optional time). Reports the chosen expiry as an absolute ISO string, or an empty
 * string for "never" - which the create/edit forms pass straight through to the
 * z.coerce.date() schema. Relative presets are resolved from the current time when
 * the choice is made.
 */

import { useState } from "react";
import { Input, Select, type SelectOption } from "@polaris/ui";

type Mode = "never" | "5m" | "10m" | "30m" | "1h" | "hours" | "days" | "weeks" | "date";

const MODE_OPTIONS: SelectOption[] = [
    { value: "never", label: "Never" },
    { value: "5m", label: "In 5 minutes" },
    { value: "10m", label: "In 10 minutes" },
    { value: "30m", label: "In 30 minutes" },
    { value: "1h", label: "In 1 hour" },
    { value: "hours", label: "In a number of hours..." },
    { value: "days", label: "In a number of days..." },
    { value: "weeks", label: "In a number of weeks..." },
    { value: "date", label: "On a specific date..." }
];

const PRESET_MS: Partial<Record<Mode, number>> = {
    "5m": 5 * 60_000,
    "10m": 10 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000
};

const UNIT_MS: Record<"hours" | "days" | "weeks", number> = {
    hours: 60 * 60_000,
    days: 24 * 60 * 60_000,
    weeks: 7 * 24 * 60 * 60_000
};

export function ExpirySelect({ onChange }: { onChange: (iso: string) => void }) {
    const [mode, setMode] = useState<Mode>("never");
    const [amount, setAmount] = useState(1);
    const [dateStr, setDateStr] = useState("");

    function emit(nextMode: Mode, nextAmount: number, nextDate: string) {
        if (nextMode === "never") return onChange("");
        const preset = PRESET_MS[nextMode];
        if (preset !== undefined) return onChange(new Date(Date.now() + preset).toISOString());
        if (nextMode === "hours" || nextMode === "days" || nextMode === "weeks") {
            const n = Math.max(1, nextAmount || 1);
            return onChange(new Date(Date.now() + n * UNIT_MS[nextMode]).toISOString());
        }
        // Custom date/time.
        onChange(nextDate ? new Date(nextDate).toISOString() : "");
    }

    const unit = mode === "hours" ? "hours" : mode === "days" ? "days" : "weeks";

    return (
        <div className="flex flex-col gap-2">
            <Select
                value={mode}
                onValueChange={(value) => {
                    const next = value as Mode;
                    setMode(next);
                    emit(next, amount, dateStr);
                }}
                options={MODE_OPTIONS}
            />

            {mode === "hours" || mode === "days" || mode === "weeks" ? (
                <div className="flex items-center gap-2">
                    <Input
                        type="number"
                        min={1}
                        value={amount}
                        onChange={(event) => {
                            const next = Number(event.target.value);
                            setAmount(next);
                            emit(mode, next, dateStr);
                        }}
                        className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">{unit}</span>
                </div>
            ) : null}

            {mode === "date" ? (
                <Input
                    type="datetime-local"
                    value={dateStr}
                    onChange={(event) => {
                        setDateStr(event.target.value);
                        emit(mode, amount, event.target.value);
                    }}
                />
            ) : null}
        </div>
    );
}
