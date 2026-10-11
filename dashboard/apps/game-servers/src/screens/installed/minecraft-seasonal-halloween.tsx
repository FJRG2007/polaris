"use client";

/**
 * Halloween's extra touches inside the seasonal card: an amount for each one
 * that comes in numbers, a switch for each one that does not. The card saves
 * them as it saves everything else, optimistically and put back on failure.
 */

import { Switch } from "@polaris/ui";
import { useGameText } from "../game-text";
import type { ComponentType } from "react";
import * as halloween from "../../lib/minecraft/seasonal-halloween";

export function MinecraftSeasonalHalloween({
    installedAppId,
    value,
    times,
    Choice,
    disabled,
    onChange
}: {
    installedAppId: string;
    value: halloween.HalloweenSettings;
    times: (count: number) => string;
    /** The card's own amount picker, so both look and behave alike. */
    Choice: ComponentType<{
        id: string;
        label: string;
        hint: string;
        value: number;
        choices: readonly number[];
        none: string;
        times: (count: number) => string;
        disabled: boolean;
        onChange: (value: number) => void;
    }>;
    disabled: boolean;
    onChange: (patch: Partial<halloween.HalloweenSettings>) => void;
}) {
    const t = useGameText("minecraft");
    const amounts: readonly halloween.HalloweenAmount[] = ["witches", "bats", "traps", "graves"];
    return (
        <div className="flex flex-col gap-3 border-t pt-3">
            <p className="text-sm font-medium">{t("seasonalHalloween.title")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
                {amounts.map((key) => (
                    <Choice
                        key={key}
                        id={`${installedAppId}-halloween-${key}`}
                        label={t(`seasonalHalloween.${key}`)}
                        hint={t(`seasonalHalloween.${key}Hint`)}
                        value={value[key]}
                        choices={halloween.HALLOWEEN_AMOUNTS[key]}
                        none={t("seasonal.none")}
                        times={times}
                        disabled={disabled}
                        onChange={(picked) => onChange({ [key]: picked })}
                    />
                ))}
            </div>
            <div className="flex flex-col gap-3">
                {halloween.HALLOWEEN_SWITCHES.map((key) => (
                    <div key={key} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs font-medium">{t(`seasonalHalloween.${key}`)}</p>
                            <p className="text-xs text-muted-foreground">
                                {t(`seasonalHalloween.${key}Hint`)}
                            </p>
                        </div>
                        <Switch
                            checked={value[key]}
                            disabled={disabled}
                            onChange={(on) => {
                                if (on !== value[key]) onChange({ [key]: on });
                            }}
                            aria-label={t(`seasonalHalloween.${key}`)}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
