"use client";

/**
 * Which apps the Overview's sidebar lists, picked from a few presets by use.
 *
 * Picking one is saved at once and drawn at once: it writes the same favorites
 * the app menu keeps (see `sidebar-presets`), through the same optimistic save
 * that puts the old list back, with the reason, if the server refuses it. So a
 * preset is only a starting point - pinning or arranging afterwards turns it into
 * "Custom", and picking "Default" again is the sidebar every account had before.
 */

import { Check } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Card, CardBody, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import {
    matchPreset,
    presetPrefs,
    SIDEBAR_PRESET_IDS,
    type SidebarPresetId
} from "@/lib/setup/sidebar-presets";

export function SidebarPresetCard() {
    const t = useTranslations("setup");
    const { favorites, order, replacePrefs } = useFavoriteApps();
    const current = matchPreset({ favorites, order });

    function pick(id: SidebarPresetId) {
        if (id === current) return;
        replacePrefs(presetPrefs(id));
    }

    // A radio group is one stop for Tab; the arrows move between its options and
    // pick the one they land on, as native radios do.
    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const from = Math.max(0, SIDEBAR_PRESET_IDS.indexOf(current as SidebarPresetId));
        const count = SIDEBAR_PRESET_IDS.length;
        const id = SIDEBAR_PRESET_IDS[(from + step + count) % count] as SidebarPresetId;
        event.currentTarget.querySelector<HTMLElement>(`[data-preset="${id}"]`)?.focus();
        pick(id);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("presets.title")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("presets.hint")}</p>
                    {current === "custom" ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t("presets.customHint")}
                        </p>
                    ) : null}
                </div>
                <div
                    role="radiogroup"
                    aria-label={t("presets.title")}
                    onKeyDown={onKeyDown}
                    className="grid gap-2 sm:grid-cols-2"
                >
                    {SIDEBAR_PRESET_IDS.map((id) => {
                        const chosen = id === current;
                        return (
                            <button
                                key={id}
                                type="button"
                                role="radio"
                                aria-checked={chosen}
                                data-preset={id}
                                tabIndex={
                                    chosen || (current === "custom" && id === "default") ? 0 : -1
                                }
                                onClick={() => pick(id)}
                                className={cn(
                                    "flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors",
                                    chosen
                                        ? "border-primary bg-primary/5"
                                        : "border-border hover:bg-muted/50 focus-visible:bg-muted/50"
                                )}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium">
                                        {t(`presets.items.${id}.title`)}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {t(`presets.items.${id}.body`)}
                                    </span>
                                </span>
                                <Check
                                    aria-hidden
                                    className={cn(
                                        "mt-0.5 size-4 shrink-0 text-primary",
                                        !chosen && "invisible"
                                    )}
                                />
                            </button>
                        );
                    })}
                </div>
            </CardBody>
        </Card>
    );
}
