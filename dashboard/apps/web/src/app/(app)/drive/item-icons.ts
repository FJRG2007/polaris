/**
 * Curated icon and color choices for customizing a folder or file's appearance.
 * Only names from this allowlist are honored when rendering (a stored icon that
 * is not here falls back to the default), so a bad or malicious value can never
 * inject an arbitrary component or class. Colors are fixed Tailwind text classes.
 */

import {
    Archive,
    Briefcase,
    Camera,
    Cloud,
    Code,
    FileText,
    Film,
    Folder,
    Heart,
    Home,
    Image,
    Lock,
    Music,
    Star,
    type LucideIcon
} from "lucide-react";

export const ITEM_ICONS: Record<string, LucideIcon> = {
    folder: Folder,
    star: Star,
    heart: Heart,
    home: Home,
    briefcase: Briefcase,
    lock: Lock,
    cloud: Cloud,
    code: Code,
    image: Image,
    music: Music,
    film: Film,
    camera: Camera,
    archive: Archive,
    document: FileText
};

export const ITEM_ICON_NAMES = Object.keys(ITEM_ICONS);

export interface IconColor {
    id: string;
    /** Text color class for rendering the icon. */
    className: string;
    /** Matching background class for the picker swatch (literal, for Tailwind). */
    swatch: string;
}

export const ITEM_ICON_COLORS: readonly IconColor[] = [
    { id: "primary", className: "text-primary", swatch: "bg-primary" },
    { id: "slate", className: "text-slate-400", swatch: "bg-slate-400" },
    { id: "red", className: "text-red-500", swatch: "bg-red-500" },
    { id: "orange", className: "text-orange-500", swatch: "bg-orange-500" },
    { id: "amber", className: "text-amber-500", swatch: "bg-amber-500" },
    { id: "green", className: "text-emerald-500", swatch: "bg-emerald-500" },
    { id: "cyan", className: "text-cyan-500", swatch: "bg-cyan-500" },
    { id: "violet", className: "text-violet-500", swatch: "bg-violet-500" },
    { id: "pink", className: "text-pink-500", swatch: "bg-pink-500" }
];

/** Resolve a stored icon name to a component, or undefined when unknown/empty. */
export function iconComponent(name: string | null | undefined): LucideIcon | undefined {
    if (!name) return undefined;
    return ITEM_ICONS[name];
}

/** Resolve a stored color id to its Tailwind class, defaulting to the primary. */
export function iconColorClass(id: string | null | undefined): string {
    return ITEM_ICON_COLORS.find((color) => color.id === id)?.className ?? "text-primary";
}
