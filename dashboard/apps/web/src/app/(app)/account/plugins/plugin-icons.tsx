"use client";

/**
 * A gallery of ready icons for a device's small square images (a knob's icon),
 * like Stream Control's icon library: search, a few categories, a color, and
 * one press sets it. The icon is drawn here, at the exact size the device
 * draws it, into the same PNG a chosen file becomes; nothing is fetched.
 */

import { useState, type MouseEvent } from "react";
import { cn, Input, settingType } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { isPluginImageValue } from "@polaris/core/device-plugins";
import {
    AudioLines,
    Bell,
    Bot,
    Calendar,
    Camera,
    Clapperboard,
    Code,
    Coffee,
    Cpu,
    Disc3,
    Film,
    Folder,
    Gamepad2,
    Globe,
    Headphones,
    Headset,
    Heart,
    House,
    Joystick,
    Laptop,
    Lock,
    Mail,
    MessageCircle,
    MessagesSquare,
    Mic,
    MicOff,
    Monitor,
    Moon,
    Music,
    Music2,
    Pause,
    Phone,
    PhoneOff,
    Play,
    Podcast,
    Power,
    Radio,
    Settings,
    SkipBack,
    SkipForward,
    Sparkles,
    Speaker,
    Star,
    Sun,
    Swords,
    Terminal,
    Trophy,
    Tv,
    Users,
    Video,
    VideoOff,
    Volume2,
    VolumeX,
    Zap,
    type LucideIcon
} from "lucide-react";

type Words = ReturnType<typeof useTranslations<"account">>;

export type IconCategory = "audio" | "calls" | "media" | "apps" | "system";

export interface GalleryIcon {
    readonly name: string;
    readonly category: IconCategory;
    /** What it is found by, in both languages the page ships. */
    readonly words: string;
    readonly Icon: LucideIcon;
}

export const GALLERY_ICONS: readonly GalleryIcon[] = [
    { name: "mic", category: "audio", words: "mic microphone micro micrófono", Icon: Mic },
    { name: "mic-off", category: "audio", words: "mic off mute microphone silencio micrófono", Icon: MicOff },
    { name: "headphones", category: "audio", words: "headphones auriculares cascos", Icon: Headphones },
    { name: "headset", category: "audio", words: "headset auriculares micro", Icon: Headset },
    { name: "volume", category: "audio", words: "volume sound speaker volumen sonido", Icon: Volume2 },
    { name: "volume-off", category: "audio", words: "volume mute off silencio", Icon: VolumeX },
    { name: "speaker", category: "audio", words: "speaker output altavoz salida", Icon: Speaker },
    { name: "levels", category: "audio", words: "levels audio wave line in entrada nivel", Icon: AudioLines },
    { name: "phone", category: "calls", words: "phone call llamada teléfono", Icon: Phone },
    { name: "hang-up", category: "calls", words: "hang up colgar llamada", Icon: PhoneOff },
    { name: "chat", category: "calls", words: "chat message mensaje", Icon: MessageCircle },
    { name: "chats", category: "calls", words: "chat voice group grupo voz", Icon: MessagesSquare },
    { name: "people", category: "calls", words: "people users team gente equipo", Icon: Users },
    { name: "video", category: "calls", words: "video camera cámara", Icon: Video },
    { name: "video-off", category: "calls", words: "video off cámara apagada", Icon: VideoOff },
    { name: "music", category: "media", words: "music música", Icon: Music },
    { name: "note", category: "media", words: "music note nota música", Icon: Music2 },
    { name: "disc", category: "media", words: "disc album disco", Icon: Disc3 },
    { name: "radio", category: "media", words: "radio", Icon: Radio },
    { name: "podcast", category: "media", words: "podcast", Icon: Podcast },
    { name: "play", category: "media", words: "play reproducir", Icon: Play },
    { name: "pause", category: "media", words: "pause pausa", Icon: Pause },
    { name: "next", category: "media", words: "next skip siguiente", Icon: SkipForward },
    { name: "previous", category: "media", words: "previous back anterior", Icon: SkipBack },
    { name: "film", category: "media", words: "film movie película", Icon: Film },
    { name: "clapperboard", category: "media", words: "video clip vídeo", Icon: Clapperboard },
    { name: "tv", category: "media", words: "tv television televisión", Icon: Tv },
    { name: "gamepad", category: "apps", words: "game gamepad games juegos mando", Icon: Gamepad2 },
    { name: "joystick", category: "apps", words: "joystick game juego", Icon: Joystick },
    { name: "swords", category: "apps", words: "swords game fight juego", Icon: Swords },
    { name: "trophy", category: "apps", words: "trophy trofeo", Icon: Trophy },
    { name: "browser", category: "apps", words: "browser web internet navegador", Icon: Globe },
    { name: "mail", category: "apps", words: "mail email correo", Icon: Mail },
    { name: "calendar", category: "apps", words: "calendar calendario", Icon: Calendar },
    { name: "camera", category: "apps", words: "camera photo foto cámara", Icon: Camera },
    { name: "code", category: "apps", words: "code código", Icon: Code },
    { name: "terminal", category: "apps", words: "terminal console consola", Icon: Terminal },
    { name: "bot", category: "apps", words: "bot assistant asistente", Icon: Bot },
    { name: "folder", category: "apps", words: "folder files carpeta archivos", Icon: Folder },
    { name: "system", category: "system", words: "system computer sistema ordenador", Icon: Monitor },
    { name: "laptop", category: "system", words: "laptop portátil", Icon: Laptop },
    { name: "cpu", category: "system", words: "cpu chip", Icon: Cpu },
    { name: "settings", category: "system", words: "settings ajustes", Icon: Settings },
    { name: "bell", category: "system", words: "bell notifications notificaciones", Icon: Bell },
    { name: "lock", category: "system", words: "lock bloquear", Icon: Lock },
    { name: "power", category: "system", words: "power apagar", Icon: Power },
    { name: "home", category: "system", words: "home casa inicio", Icon: House },
    { name: "sun", category: "system", words: "sun light brightness sol brillo", Icon: Sun },
    { name: "moon", category: "system", words: "moon night luna noche", Icon: Moon },
    { name: "zap", category: "system", words: "zap flash rayo", Icon: Zap },
    { name: "star", category: "system", words: "star favorite estrella", Icon: Star },
    { name: "heart", category: "system", words: "heart like corazón", Icon: Heart },
    { name: "sparkles", category: "system", words: "sparkles effects efectos", Icon: Sparkles },
    { name: "coffee", category: "system", words: "coffee break café", Icon: Coffee }
];

const CATEGORIES: readonly IconCategory[] = ["audio", "calls", "media", "apps", "system"];

/** The colors an icon can be drawn in: light and dark for any background, and a few of the device's own. */
export const ICON_TINTS = ["#f0f2f5", "#101216", "#4096ff", "#eb5050", "#3ecf8e", "#f5b83d", "#a970ff"] as const;

function say(t: Words, key: string): string {
    return (t as unknown as (key: string) => string)(`plugins.look.${key}`);
}

/** The icons that match `query` (any of their words, either language), in gallery order. */
export function findIcons(query: string, icons: readonly GalleryIcon[] = GALLERY_ICONS): GalleryIcon[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [...icons];
    return icons.filter((icon) => terms.every((term) => `${icon.name} ${icon.words} ${icon.category}`.toLowerCase().includes(term)));
}

/**
 * An icon's outline drawn into a `size` square PNG in `color`, with a little
 * room around it so its strokes are not cut: the same kind of value a chosen
 * file becomes. Null when the browser cannot draw it.
 */
export async function drawIcon(svg: SVGSVGElement, size: number, color: string): Promise<string | null> {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(size));
    copy.setAttribute("height", String(size));
    copy.setAttribute("stroke", color);
    copy.removeAttribute("class");
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
    const image = new Image();
    image.decoding = "async";
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pad = Math.round(size * 0.08);
    context.drawImage(image, pad, pad, size - 2 * pad, size - 2 * pad);
    const url = canvas.toDataURL("image/png");
    return isPluginImageValue(url) ? url : null;
}

/** The gallery: search, a color, and each category's icons; a press draws the icon and hands it over. */
export function IconGallery({ size, onPick, draw = drawIcon }: { size: number; onPick: (url: string) => void; draw?: typeof drawIcon }) {
    const t = useTranslations("account");
    const [find, setFind] = useState("");
    const [tint, setTint] = useState<string>(ICON_TINTS[0]);
    const [busy, setBusy] = useState(false);
    const found = findIcons(find);
    const pick = (event: MouseEvent<HTMLButtonElement>) => {
        const svg = event.currentTarget.querySelector("svg");
        if (!svg || busy) return;
        setBusy(true);
        void draw(svg, size, tint)
            .catch(() => null)
            .then((url) => {
                setBusy(false);
                if (url) onPick(url);
            });
    };
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <Input value={find} onChange={(event) => setFind(event.target.value)} placeholder={say(t, "findIcon")} aria-label={say(t, "findIcon")} />
            <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="radiogroup" aria-label={say(t, "iconColor")}>
                {ICON_TINTS.map((color) => (
                    <button
                        key={color}
                        type="button"
                        role="radio"
                        aria-checked={tint === color}
                        aria-label={color}
                        title={color}
                        onClick={() => setTint(color)}
                        className={cn("size-6 shrink-0 rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring", tint === color && "ring-2 ring-primary ring-offset-1 ring-offset-background")}
                        style={{ backgroundColor: color }}
                    />
                ))}
            </div>
            <div className="flex max-h-72 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                {found.length === 0 ? <p className={cn(settingType.body, "text-muted-foreground")}>{say(t, "noIcon")}</p> : null}
                {CATEGORIES.map((category) => {
                    const icons = found.filter((icon) => icon.category === category);
                    if (icons.length === 0) return null;
                    return (
                        <div key={category} className="flex min-w-0 flex-col gap-1.5">
                            <p className={cn(settingType.small, "text-foreground-subtle")}>{say(t, `category.${category}`)}</p>
                            <div className="grid grid-cols-6 gap-1.5">
                                {icons.map(({ name, Icon }) => (
                                    <button
                                        key={name}
                                        type="button"
                                        title={name}
                                        aria-label={name}
                                        disabled={busy}
                                        onClick={pick}
                                        data-icon={name}
                                        className="flex aspect-square min-w-0 items-center justify-center rounded-md border border-border bg-[#101216] outline-none transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                                        style={{ color: tint === "#101216" ? "#101216" : tint, backgroundColor: tint === "#101216" ? "#f0f2f5" : undefined }}
                                    >
                                        <Icon className="size-5 shrink-0" strokeWidth={2} />
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
