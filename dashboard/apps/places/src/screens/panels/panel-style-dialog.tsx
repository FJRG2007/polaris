"use client";

/**
 * How a panel looks on the wall: its theme, accent, density, background, and
 * how long the wall waits without a touch before the screensaver. Saved only
 * when something differs from what is saved.
 */

import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select
} from "@polaris/ui";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import {
    PANEL_ACCENTS,
    PANEL_BACKGROUNDS,
    PANEL_DENSITIES,
    PANEL_THEMES,
    SCREENSAVER_MINUTES,
    type PanelStyle,
    type ScreensaverMinutes
} from "../../lib/panel-layout";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[0.75rem] font-medium text-muted-foreground">{label}</span>
            {children}
        </label>
    );
}

export function PanelStyleDialog({
    open,
    style,
    onClose,
    onSave
}: {
    open: boolean;
    style: PanelStyle;
    onClose: () => void;
    onSave: (style: PanelStyle) => void;
}) {
    const t = usePlacesT();
    const [draft, setDraft] = useState<PanelStyle>(style);
    useEffect(() => {
        if (open) setDraft(style);
    }, [open, style]);
    const set = <K extends keyof PanelStyle>(key: K, value: PanelStyle[K]) =>
        setDraft((now) => ({ ...now, [key]: value }));
    const changed = (Object.keys(style) as (keyof PanelStyle)[]).some(
        (key) => style[key] !== draft[key]
    );

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("panelStyle.title")}</DialogTitle>
                    <DialogDescription>{t("panelStyle.description")}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("panelStyle.theme")}>
                        <Select
                            value={draft.theme}
                            onValueChange={(value) => set("theme", value as PanelStyle["theme"])}
                            options={PANEL_THEMES.map((value) => ({
                                value,
                                label: t(`panelStyle.themes.${value}`)
                            }))}
                        />
                    </Field>
                    <Field label={t("panelStyle.accent")}>
                        <Select
                            value={draft.accent}
                            onValueChange={(value) =>
                                set("accent", value as PanelStyle["accent"])
                            }
                            options={PANEL_ACCENTS.map((value) => ({
                                value,
                                label: t(`panelStyle.accents.${value}`)
                            }))}
                        />
                    </Field>
                    <Field label={t("panelStyle.density")}>
                        <Select
                            value={draft.density}
                            onValueChange={(value) =>
                                set("density", value as PanelStyle["density"])
                            }
                            options={PANEL_DENSITIES.map((value) => ({
                                value,
                                label: t(`panelStyle.densities.${value}`)
                            }))}
                        />
                    </Field>
                    <Field label={t("panelStyle.background")}>
                        <Select
                            value={draft.background}
                            onValueChange={(value) =>
                                set("background", value as PanelStyle["background"])
                            }
                            options={PANEL_BACKGROUNDS.map((value) => ({
                                value,
                                label: t(`panelStyle.backgrounds.${value}`)
                            }))}
                        />
                    </Field>
                    <Field label={t("panelStyle.screensaver")}>
                        <Select
                            value={String(draft.screensaver)}
                            onValueChange={(value) =>
                                set("screensaver", Number(value) as ScreensaverMinutes)
                            }
                            options={SCREENSAVER_MINUTES.map((minutes) => ({
                                value: String(minutes),
                                label:
                                    minutes === 0
                                        ? t("panelStyle.screensaverOff")
                                        : t("panelStyle.screensaverAfter", { count: minutes })
                            }))}
                        />
                    </Field>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t("panels.cancel")}
                    </Button>
                    <Button disabled={!changed} onClick={() => onSave(draft)}>
                        {t("panels.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
