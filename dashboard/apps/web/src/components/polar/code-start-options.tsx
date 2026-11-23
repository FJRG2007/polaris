"use client";

/**
 * The new task's one settings menu, beside the model: the permission mode, the
 * conversation (Terminal or Chat), the engine and the machine it runs on, each
 * a section of the same menu instead of a chip of its own. The chip names the
 * permission mode, the one worth seeing before a task starts, and its title
 * names every section's choice.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import type { PolarCodeComputer } from "@/lib/polar/code";
import * as acpProviders from "@/lib/agents/acp/providers";
import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { CodeSource } from "@/lib/polar/agents/code-sources";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MODEL_TRIGGER } from "@/components/polar/elements/model-selector";
import { EngineItems, engineName } from "@/components/polar/session-engine";
import {
    CodePlaceItems,
    PermissionModeItems,
    SessionSurfaceItems
} from "@/components/polar/polar-code-context";
import {
    SheetMenu,
    SheetMenuContent,
    SheetMenuLabel,
    SheetMenuSeparator,
    SheetMenuTrigger
} from "@/components/polar/elements/sheet-menu";

export interface CodeStartOptionsProps {
    /** Null when the tool takes no permission mode. */
    mode: { value: core.SessionPermissionMode; onChange: (mode: core.SessionPermissionMode) => void } | null;
    /** Null when the agent cannot be driven in Chat. */
    surface: {
        value: acpProviders.SessionSurface;
        onChange: (surface: acpProviders.SessionSurface) => void;
    } | null;
    /** Null when no tool runs the task (Polar answers it). */
    engine: {
        source: Pick<CodeSource, "key" | "kind" | "engines">;
        value: string | null;
        onChange: (engine: string | null) => void;
    } | null;
    /** Null when the task runs in Polar's chat, on no machine. */
    place: {
        computers: PolarCodeComputer[] | null;
        value: string | null;
        onChange: (computerId: string | null) => void;
    } | null;
    disabled: boolean;
}

export function CodeStartOptions({ mode, surface, engine, place, disabled }: CodeStartOptionsProps) {
    const t = useTranslations("polar");
    if (!mode && !surface && !engine && !place) return null;
    const machine = place?.value
        ? (place.computers?.find((computer) => computer.id === place.value)?.name ?? null)
        : null;
    const chosen = [
        mode ? `${t("code.mode.label")}: ${t(`code.mode.${mode.value}.name`)}` : null,
        surface ? `${t("code.surface.label")}: ${t(`code.surface.${surface.value}.name`)}` : null,
        engine
            ? `${t("settings.engine.label")}: ${engine.value ? engineName(engine.value, t) : t("settings.engine.yourSetting")}`
            : null,
        place ? `${t("code.place.label")}: ${machine ?? t("code.place.polaris")}` : null
    ].filter((line): line is string => line !== null);
    const label = mode ? t(`code.mode.${mode.value}.name`) : t("code.options.label");
    const Icon = mode ? ShieldCheck : SlidersHorizontal;
    const sections = [
        mode ? (
            <div key="mode" role="group" aria-label={t("code.mode.label")}>
                <SheetMenuLabel>{t("code.mode.label")}</SheetMenuLabel>
                <PermissionModeItems value={mode.value} onChange={mode.onChange} />
            </div>
        ) : null,
        surface ? (
            <div key="surface" role="group" aria-label={t("code.surface.label")}>
                <SheetMenuLabel>{t("code.surface.label")}</SheetMenuLabel>
                <SessionSurfaceItems value={surface.value} onChange={surface.onChange} />
            </div>
        ) : null,
        engine ? (
            <div key="engine" role="group" aria-label={t("settings.engine.label")}>
                <SheetMenuLabel>{t("settings.engine.label")}</SheetMenuLabel>
                <EngineItems source={engine.source} value={engine.value} onChange={engine.onChange} />
            </div>
        ) : null,
        place ? (
            <div key="place" role="group" aria-label={t("code.place.label")}>
                <SheetMenuLabel>{t("code.place.label")}</SheetMenuLabel>
                <CodePlaceItems computers={place.computers} value={place.value} onChange={place.onChange} />
            </div>
        ) : null
    ].filter((section) => section !== null);
    return (
        <SheetMenu>
            <SheetMenuTrigger disabled={disabled}>
                <button
                    type="button"
                    title={chosen.join("\n")}
                    aria-label={`${t("code.options.title")}: ${chosen.join(", ")}`}
                    className={cn(MODEL_TRIGGER, "max-w-40 disabled:opacity-60")}
                >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate text-foreground">{label}</span>
                </button>
            </SheetMenuTrigger>
            <SheetMenuContent
                title={t("code.options.title")}
                align="start"
                className="max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain"
            >
                {sections.flatMap((section, index) =>
                    index === 0 ? [section] : [<SheetMenuSeparator key={`gap-${index}`} />, section]
                )}
            </SheetMenuContent>
        </SheetMenu>
    );
}
