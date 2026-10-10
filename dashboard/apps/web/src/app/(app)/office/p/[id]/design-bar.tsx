"use client";

/**
 * What can be done to the slide itself, on the editor's toolbar when nothing on
 * it is chosen: its background, its layout, and the deck's theme - the three
 * buttons Google Slides shows in the same place for the same reason.
 */

import * as deck from "@/lib/office/deck";
import { FILL_COLORS, MenuButton, Choice } from "./format-bar";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@polaris/ui";
import { LayoutTemplate, PaintBucket, Palette } from "lucide-react";

/** A layout, drawn small: where its boxes go. */
export function LayoutPreview({ layout }: { layout: deck.Layout }) {
    return (
        <span
            aria-hidden
            className="relative block aspect-video w-12 shrink-0 rounded-sm border border-border bg-white"
        >
            {deck.layoutBoxes(layout).map((box) => (
                <span
                    key={box.id}
                    className={cn(
                        "absolute rounded-[1px]",
                        box.role === "title" ? "bg-neutral-500" : "bg-neutral-300"
                    )}
                    style={{
                        left: `${(box.x + 0.02) * 100}%`,
                        top: `${(box.y + box.h * 0.3) * 100}%`,
                        width: `${(box.w - 0.04) * 100}%`,
                        height: `${Math.max(0.08, box.h * 0.4) * 100}%`
                    }}
                />
            ))}
        </span>
    );
}

/** The layouts on offer, each with its picture, for a menu. */
export function LayoutItems({ onPick }: { onPick: (layout: deck.Layout) => void }) {
    const t = useTranslations("office");
    return (
        <>
            {deck.LAYOUTS.map((layout) => (
                <DropdownMenuItem key={layout} onSelect={() => onPick(layout)}>
                    <LayoutPreview layout={layout} />
                    {t(`slides.layouts.${layout}`)}
                </DropdownMenuItem>
            ))}
        </>
    );
}

export function DesignBar({
    theme,
    background,
    ownBackground,
    onBackground,
    onBackgroundEverywhere,
    onLayout,
    onTheme
}: {
    theme: deck.DeckTheme;
    /** The slide's background as it is drawn. */
    background: string;
    /** Whether the slide has one of its own rather than the theme's. */
    ownBackground: boolean;
    /** A colour for this slide, or `null` for the theme's. */
    onBackground: (color: string | null) => void;
    /** This slide's background made the theme's, so every slide has it. */
    onBackgroundEverywhere: () => void;
    onLayout: (layout: deck.Layout) => void;
    onTheme: (theme: Partial<deck.DeckTheme>) => void;
}) {
    const t = useTranslations("office");
    const tc = useTranslations("components");
    const themeId = deck.themeIdOf(theme);
    return (
        <>
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={t("slides.design.background")}
                        title={t("slides.design.background")}
                        className="relative flex shrink-0 items-center gap-1.5 rounded p-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <PaintBucket className="size-4 shrink-0" aria-hidden />
                        <span className="max-2xl:sr-only">{t("slides.design.background")}</span>
                        <span
                            aria-hidden
                            className="absolute inset-x-1.5 bottom-1 h-0.5 rounded-full border border-border/60"
                            style={{ backgroundColor: background }}
                        />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-auto p-2">
                    <div className="grid grid-cols-6 gap-1.5">
                        {FILL_COLORS.map((one) => (
                            <DropdownMenuItem
                                key={one.value}
                                aria-label={tc(one.label)}
                                title={tc(one.label)}
                                onSelect={() => onBackground(one.value)}
                                className={cn(
                                    "size-6 justify-center rounded border border-border/60 p-0",
                                    ownBackground &&
                                        background === one.value &&
                                        "ring-2 ring-primary"
                                )}
                                style={{ backgroundColor: one.value }}
                            />
                        ))}
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onSelect={() => onBackground(null)}
                        role="menuitemradio"
                        aria-checked={!ownBackground}
                        className={cn(!ownBackground && "bg-muted font-medium")}
                    >
                        {t("slides.design.themeBackground")}
                    </DropdownMenuItem>
                    {ownBackground ? (
                        <DropdownMenuItem onSelect={onBackgroundEverywhere}>
                            {t("slides.design.everySlide")}
                        </DropdownMenuItem>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>

            <MenuButton label={t("slides.design.layout")} menu={<LayoutItems onPick={onLayout} />}>
                <LayoutTemplate className="size-4 shrink-0" aria-hidden />
            </MenuButton>

            <MenuButton
                label={t("slides.design.theme")}
                menu={
                    <>
                        {deck.THEME_IDS.map((id) => {
                            const one = deck.THEMES[id];
                            return (
                                <Choice
                                    key={id}
                                    chosen={themeId === id}
                                    onSelect={() => onTheme(one)}
                                >
                                    <span
                                        aria-hidden
                                        className="flex aspect-video w-12 shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 text-[11px] font-semibold"
                                        style={{
                                            backgroundColor: one.background,
                                            color: one.text,
                                            fontFamily: `"${one.headingFont}"`
                                        }}
                                    >
                                        {/* i18n-ignore: a type sample, not a word */}
                                        Aa
                                        <span
                                            className="size-1.5 rounded-full"
                                            style={{ backgroundColor: one.accent }}
                                        />
                                    </span>
                                    {t(`slides.themes.${id}`)}
                                </Choice>
                            );
                        })}
                        <DropdownMenuSeparator />
                        <FontSub
                            label={t("slides.design.headingFont")}
                            current={theme.headingFont}
                            onPick={(font) => onTheme({ headingFont: font })}
                        />
                        <FontSub
                            label={t("slides.design.bodyFont")}
                            current={theme.bodyFont}
                            onPick={(font) => onTheme({ bodyFont: font })}
                        />
                    </>
                }
            >
                <Palette className="size-4 shrink-0" aria-hidden />
            </MenuButton>
        </>
    );
}

/** One of the theme's two faces, chosen from a submenu. */
function FontSub({
    label,
    current,
    onPick
}: {
    label: string;
    current: deck.DeckTheme["bodyFont"];
    onPick: (font: deck.DeckTheme["bodyFont"]) => void;
}) {
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <span className="min-w-0 flex-1 truncate" title={label}>
                    {label}
                </span>
                <span className="ml-3 shrink-0 text-muted-foreground">{current}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {deck.SLIDE_FONTS.map((font) => (
                    <Choice key={font} chosen={font === current} onSelect={() => onPick(font)}>
                        <span style={{ fontFamily: `"${font}"` }}>{font}</span>
                    </Choice>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
