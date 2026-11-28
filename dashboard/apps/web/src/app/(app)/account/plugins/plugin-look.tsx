"use client";

/**
 * The controls for a plugin's colour and picture settings, and the screen
 * drawn from them on the device's drawing, so a change is seen before the
 * device draws it. A picture is cut to the shape the device draws it at
 * (Stream Control asks for exact sizes the same way: 480 x 272 for the
 * background, a square for an icon) and stored as the PNG or JPEG the device
 * reads; it lives with the plugin's other settings on this computer, since the
 * device is drawn from there with no network.
 */

import { useState } from "react";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { PluginLevels, PluginLive } from "@/lib/device-plugins-client";
import { CROP_ACCEPTED, ImageCropDialog } from "@/components/image-cropper";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { Button, cn, ColorPicker, Popover, PopoverContent, PopoverTrigger, settingType, useToast } from "@polaris/ui";
import { isPluginImageValue, PLUGIN_COLOR, type PluginManifest, type PluginSetting, type PluginSettingValue } from "@polaris/core/device-plugins";

type Words = ReturnType<typeof useTranslations<"account">>;
type ColorSetting = Extract<PluginSetting, { kind: "color" }>;
type ImageSetting = Extract<PluginSetting, { kind: "image" }>;
type Values = Record<string, PluginSettingValue>;

function say(t: Words, key: string): string {
    return (t as unknown as (key: string) => string)(`plugins.look.${key}`);
}

/** What a colour setting draws with: the picked colour, else the plugin's own, else none. */
export function lookColor(setting: ColorSetting | undefined, value: PluginSettingValue): string | null {
    if (typeof value === "string" && PLUGIN_COLOR.test(value)) return value;
    return setting?.fallback ?? null;
}

/** A colour setting: a swatch that opens the design system's picker, and a way back to the plugin's own. */
export function ColorSettingControl({ setting, value, label, onChange, width }: { setting: ColorSetting; value: PluginSettingValue; label: string; onChange: (value: string) => void; width: string }) {
    const t = useTranslations("account");
    const shown = lookColor(setting, value) ?? "#000000";
    const picked = typeof value === "string" && value !== "";
    // The picker reports every drag step; only where it is let go is saved.
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <div className={cn("flex min-w-0 items-center gap-2", width)}>
            <Popover
                onOpenChange={(open) => {
                    if (open || draft === null) return;
                    if (draft.toLowerCase() !== shown.toLowerCase()) onChange(draft);
                    setDraft(null);
                }}
            >
                <PopoverTrigger asChild>
                    <Button type="button" variant="outline" className="min-w-0 flex-1 justify-start gap-2" aria-label={label}>
                        <span aria-hidden className="size-4 shrink-0 rounded-sm border border-border" style={{ backgroundColor: draft ?? shown }} />
                        <span className={cn(settingType.body, "min-w-0 truncate font-mono")}>{picked || draft ? (draft ?? shown) : say(t, "defaultColor")}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 max-w-[calc(100vw-2rem)] p-3">
                    <ColorPicker value={draft ?? shown} onChange={setDraft} label={label} />
                </PopoverContent>
            </Popover>
            {picked ? (
                <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={say(t, "useDefault")} title={say(t, "useDefault")} onClick={() => onChange("")}>
                    <RotateCcw className="size-4 shrink-0" />
                </Button>
            ) : null}
        </div>
    );
}

/** The cropped picture at the exact size the device draws it, as the PNG (an icon) or JPEG (a photo) it reads. */
async function pictureValue(blob: Blob, width: number, height: number): Promise<string | null> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // An icon keeps its transparency; a screen-sized picture is a photo and much smaller as JPEG.
    const url = width * height <= 128 * 128 ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.9);
    return isPluginImageValue(url) ? url : null;
}

/** A picture setting: what is set, then choose or replace (cut to the device's shape) and remove. */
export function ImageSettingControl({ setting, value, label, onChange, width }: { setting: ImageSetting; value: PluginSettingValue; label: string; onChange: (value: string) => void; width: string }) {
    const t = useTranslations("account");
    const toast = useToast();
    // The shared picker: this computer, Drive, the camera or an address, like every other screen that asks for a file.
    const [chooseFiles, chooser] = useChooseFiles();
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const current = isPluginImageValue(value) ? value : null;
    const ratio = setting.width / setting.height;
    return (
        <div className={cn("flex min-w-0 items-center gap-2", width)}>
            {current ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL kept on this computer, not an optimisable asset
                <img src={current} alt="" className={cn("h-9 shrink-0 rounded-sm border border-border object-cover", ratio > 1.2 ? "w-16" : "w-9")} />
            ) : null}
            <Button type="button" variant="outline" className="min-w-0 flex-1 gap-2" onClick={() => void chooseFiles({ accept: CROP_ACCEPTED, title: label, local: true, onFailed: (message) => toast.show({ title: message }) }).then((files) => files[0] && setFile(files[0]))}>
                <ImagePlus className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{say(t, current ? "replace" : "choose")}</span>
            </Button>
            {current ? (
                <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={say(t, "remove")} title={say(t, "remove")} onClick={() => onChange("")}>
                    <Trash2 className="size-4 shrink-0" />
                </Button>
            ) : null}
            {chooser}
            {file ? (
                <ImageCropDialog
                    file={file}
                    shape={{ ratio, round: false, maxWidth: Math.max(setting.width, 64) }}
                    busy={busy}
                    onCancel={() => setFile(null)}
                    onCropped={(blob) => {
                        setBusy(true);
                        void pictureValue(blob, setting.width, setting.height)
                            .catch(() => null)
                            .then((url) => {
                                setBusy(false);
                                setFile(null);
                                if (url) onChange(url);
                                else toast.show({ title: say(t, "unreadable") });
                            });
                    }}
                />
            ) : null}
        </div>
    );
}

/** The device's colour for a muted knob (its theme's `MUTED`). */
const MUTED = "#eb5050";

/** The well-known keys a screen preview reads; a plugin that declares none of them keeps the plain screen. */
const LOOK_KEYS = ["backgroundColor", "backgroundImage", "textColor", "accentColor"] as const;

export function declaresLook(manifest: Pick<PluginManifest, "settings">): boolean {
    return manifest.settings.some((setting) => (LOOK_KEYS as readonly string[]).includes(setting.key));
}

/**
 * The device's screen as its look draws it: the background colour or picture,
 * and under each knob its icon, its name and a volume bar in the accent
 * colour. The names are what each knob follows; the volumes are the
 * device's own, live, while it runs (a sample before it shows anything).
 */
export function ScreenPreview({
    manifest,
    values,
    names,
    actions = [],
    live = null,
    levels = null
}: {
    manifest: Pick<PluginManifest, "settings">;
    values: Values;
    names: readonly string[];
    /** What each button does, under its knob, as the device's action zone shows it; empty for one with nothing. */
    actions?: readonly string[];
    live?: PluginLive | null;
    levels?: PluginLevels | null;
}) {
    const t = useTranslations("account");
    const color = (key: string) => lookColor(manifest.settings.find((setting): setting is ColorSetting => setting.key === key && setting.kind === "color"), values[key] ?? "");
    const background = color("backgroundColor") ?? "#101216";
    const text = color("textColor") ?? "#f0f2f5";
    const accent = color("accentColor") ?? "#4096ff";
    const picture = isPluginImageValue(values.backgroundImage) ? values.backgroundImage : null;
    const fit = (key: string, fallback: "cover" | "contain") => (values[key] === "contain" || values[key] === "cover" ? values[key] : fallback);
    // A drawing of the device's screen, scaled with it: its letters follow the device's sizes, not the page's type scale.
    const nameSize = values.labelSize === "small" ? "0.5rem" : values.labelSize === "large" ? "0.75rem" : "0.625rem";
    const sample = [72, 45, 88, 30];
    // The device gives the bottom of its screen to the buttons' names only when one has a name.
    const zone = actions.some((action) => action.trim() !== "");
    return (
        <div
            role="img"
            aria-label={say(t, "preview")}
            className="relative grid aspect-[480/272] w-3/5 min-w-48 max-w-72 grid-cols-4 overflow-hidden rounded-md border-2 border-border"
            style={{ backgroundColor: background, color: text }}
        >
            {picture ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL kept on this computer
                <img src={picture} alt="" className={cn("absolute inset-0 size-full", fit("backgroundFit", "cover") === "contain" ? "object-contain" : "object-cover")} />
            ) : null}
            {names.slice(0, 4).map((name, index) => {
                const icon = values[`knob${index + 1}Image`];
                const knob = live?.knobs[index];
                const volume = knob ? knob.volume : sample[index]!;
                const muted = knob?.muted === true;
                const level = levels?.[index] ?? null;
                return (
                    <div key={index} className="relative flex min-w-0 flex-col items-center gap-0.5 px-1 py-1.5">
                        {isPluginImageValue(icon) ? (
                            // eslint-disable-next-line @next/next/no-img-element -- a data: URL kept on this computer
                            <img src={icon} alt="" className={cn("size-[15%] min-h-3 min-w-3 shrink-0", fit("knobImageFit", "contain") === "contain" ? "object-contain" : "object-cover")} />
                        ) : null}
                        <span className="w-full truncate text-center font-medium leading-tight" style={{ fontSize: nameSize }} title={name}>
                            {name}
                        </span>
                        <span className="font-semibold leading-tight tabular-nums" style={{ fontSize: "0.625rem", color: muted ? MUTED : undefined }}>
                            {volume === null ? "-" : `${volume}%`}
                        </span>
                        <span className={cn("mt-auto flex w-2/5 min-w-3 items-end justify-center gap-[8%]", zone ? "h-2/5" : "h-1/2")}>
                            <span className="relative h-full w-3/5 rounded-[1px]" style={{ backgroundColor: `${text}26` }}>
                                <span className="absolute inset-x-0 bottom-0 rounded-[1px]" style={{ height: `${volume ?? 0}%`, backgroundColor: muted ? MUTED : accent }} />
                            </span>
                            {levels ? (
                                // What the channel plays now, beside what it is set to, like Stream Control's meters; it falls back smoothly, as a meter does.
                                <span className="relative h-full w-1/5 rounded-[1px]" style={{ backgroundColor: `${text}14` }} data-meter={index}>
                                    <span
                                        className="absolute inset-x-0 bottom-0 rounded-[1px] transition-[height] duration-150 ease-out motion-reduce:transition-none"
                                        style={{ height: `${muted ? 0 : (level ?? 0)}%`, backgroundColor: muted ? `${text}40` : `${text}b3` }}
                                    />
                                </span>
                            ) : null}
                        </span>
                        {zone ? (
                            <span className="w-full truncate text-center font-medium uppercase leading-tight" style={{ fontSize: "0.5rem" }} title={actions[index]} data-action={index}>
                                {actions[index]?.trim() || "\u00a0"}
                            </span>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}
