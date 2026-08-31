/**
 * Brand logos for integrations, as inline SVG (each vendor's official mark) so
 * they inherit color via `currentColor` and ship with no external requests. Add
 * a new mark here when adding an integration.
 */

import { cn } from "@polaris/ui";
import { tintFor } from "./avatar";
import { Blocks } from "lucide-react";
import { DymoMark } from "./dymo-mark";
import * as brand from "./brand-icons";
import type { ComponentType } from "react";
import { MODEL_PROVIDER_SEEDS } from "@/lib/integrations/model-providers";
import {
    AnthropicMark,
    CerebrasMark,
    DeepSeekMark,
    GeminiMark,
    GroqMark,
    MoonshotMark,
    OpenAiMark,
    OpenRouterMark,
    XaiMark
} from "./model-marks";

/** The Models catalog, keyed by its integration slug. Kept as a map because that
 *  list grows with every provider a run can be handed a key for. */
const MODEL_MARKS: Record<string, ComponentType<{ className?: string }>> = {
    anthropic: AnthropicMark,
    openai: OpenAiMark,
    "google-ai": GeminiMark,
    xai: XaiMark,
    deepseek: DeepSeekMark,
    moonshot: MoonshotMark,
    groq: GroqMark,
    cerebras: CerebrasMark,
    openrouter: OpenRouterMark,
    // The gateway is not a provider, but it is a thing with a name and a mark,
    // and it sits in the same list.
    enigma: brand.EnigmaMark
};

interface LogoProps {
    className?: string;
    /** Render in the brand color instead of currentColor. */
    brand?: boolean;
}

export function VirusTotalLogo({ className = "size-6", brand }: LogoProps) {
    return (
        <svg
            role="img"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            className={cn("shrink-0", className)}
            fill={brand ? "#394EFF" : "currentColor"}
            aria-hidden="true"
        >
            <path d="M10.87 12L0 22.68h24V1.32H0zm10.73 8.52H5.28l8.637-8.448L5.28 3.48H21.6z" />
        </svg>
    );
}

/**
 * Every service that has a mark, by the slug the integration is registered under.
 *
 * A map rather than a run of comparisons: the ones that were missing from that run
 * - Microsoft and Dropbox among them - drew the generic block instead, on cards
 * whose whole job is to be recognised at a glance.
 */
const SERVICE_MARKS: Record<string, ComponentType<{ className?: string }>> = {
    github: brand.GitHubMark,
    google: brand.GoogleMark,
    microsoft: brand.MicrosoftMark,
    dropbox: brand.DropboxMark,
    steam: brand.SteamMark,
    epic: brand.EpicGamesMark,
    discord: brand.DiscordMark,
    cloudflare: brand.CloudflareMark,
    ngrok: brand.NgrokMark,
    giphy: brand.GiphyMark,
    krisp: brand.KrispMark,
    dymo: DymoMark
};

/**
 * The ones whose logo is a picture rather than a shape.
 *
 * A vendor that publishes only a full-colour mark cannot be drawn in
 * `currentColor` without becoming a silhouette of itself, so its own file is
 * served from `public/` instead. Kept apart from the marks above so it is
 * obvious which kind each integration is - and so a slug that has neither is
 * one line to spot.
 */
const SERVICE_IMAGES: Record<string, string> = {
    duckdns: "/logos/duckdns.webp",
    minecraft: "/logos/minecraft.webp",
    tenor: "/logos/tenor.webp",
    criminalip: "/logos/criminalip.webp"
};

/**
 * The initials a provider with no mark here is drawn as.
 *
 * Deliberately a monogram rather than something drawn to look like the vendor's
 * logo. There are sixty model providers and most of them publish only a
 * full-colour mark, or none that is anybody's to redistribute; a shape invented
 * for one of them would be a trademark nobody recognises, which is worse than an
 * honest set of letters. The tile is tinted from the slug by the same function
 * that colours a face with no photo, so two of them in a list are tellable apart
 * before the letters are read.
 *
 * The first letters of the first two words, or the first two letters when there
 * is only one word. Punctuation is not a word: "Z.AI" is ZA, not Z-dot.
 */
export function providerInitials(name: string): string {
    const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
    return letters.toUpperCase() || "??";
}

function ProviderMonogram({ slug, name, className }: { slug: string; name: string; className?: string }) {
    return (
        <span
            aria-hidden="true"
            style={{ backgroundColor: tintFor(slug) }}
            // The size class is both the minimum and the maximum, as it is for
            // every mark beside it: a flex row short of room may not take the
            // space off the icon. text-[0.5em] keeps the letters inside the tile
            // at whatever size the caller asked for.
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-[0.25em] text-[0.5em] font-semibold leading-none text-white",
                className
            )}
        >
            {providerInitials(name)}
        </span>
    );
}

/** Whether this slug has a logo of its own, which is what the catalogue test
 *  asks so a new integration cannot ship drawing the generic block. A model
 *  provider from the seeded table counts: it is drawn as its own monogram. */
export function hasIntegrationLogo(slug: string): boolean {
    return (
        slug === "virustotal" ||
        slug in SERVICE_IMAGES ||
        slug in SERVICE_MARKS ||
        slug in MODEL_MARKS ||
        SEEDED_SLUGS.has(slug)
    );
}

const SEEDED_SLUGS = new Set(MODEL_PROVIDER_SEEDS.map((seed) => seed.slug));

/** The logo for a marketplace integration slug (a neutral fallback otherwise). */
export function IntegrationLogo({ slug, className }: { slug: string; className?: string }) {
    if (slug === "virustotal") return <VirusTotalLogo className={className} brand />;
    const image = SERVICE_IMAGES[slug];
    // object-contain: these are the vendors' own files, and they are not all
    // square. A logo stretched to fill a box is a logo nobody signed off on.
    if (image) return <img src={image} alt="" className={cn("shrink-0 object-contain", className)} />;
    const Mark = SERVICE_MARKS[slug] ?? MODEL_MARKS[slug];
    if (Mark) return <Mark className={className} />;
    const seeded = MODEL_PROVIDER_SEEDS.find((seed) => seed.slug === slug);
    if (seeded) return <ProviderMonogram slug={slug} name={seeded.name} className={className} />;
    return <Blocks className={className} />;
}

/**
 * The vendors behind the coding agents, where Polaris already carries their mark.
 *
 * Only the four that are genuinely already here. The others - OpenCode, Cursor,
 * Amp, Goose, Aider, Droid, OpenClaw - publish marks that are not ours to
 * redraw, and a shape invented for one of them would be a trademark nobody
 * recognises. They get the same monogram a model provider with no mark gets:
 * tinted from the id, so two of them in a list are tellable apart before the
 * letters are read.
 */
const AGENT_MARKS: Record<string, ComponentType<{ className?: string }>> = {
    claude: AnthropicMark,
    codex: OpenAiMark,
    gemini: GeminiMark,
    copilot: brand.GitHubMark
};

/** The logo for a coding agent, by its catalogue id. `custom` is a tool Polaris
 *  knows nothing about, including what it looks like, so it draws the same
 *  neutral block an unknown integration does. */
export function AgentLogo({ id, label, className }: { id: string; label: string; className?: string }) {
    const Mark = AGENT_MARKS[id];
    if (Mark) return <Mark className={className} />;
    if (id === "custom") return <Blocks className={className} />;
    return <ProviderMonogram slug={id} name={label} className={className} />;
}
