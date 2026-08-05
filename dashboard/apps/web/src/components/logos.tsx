/**
 * Brand logos for integrations, as inline SVG (each vendor's official mark) so
 * they inherit color via `currentColor` and ship with no external requests. Add
 * a new mark here when adding an integration.
 */

import { cn } from "@polaris/ui";
import { Blocks } from "lucide-react";
import { DymoMark } from "./dymo-mark";
import type { ComponentType } from "react";
import { CloudflareMark, GitHubMark, GoogleMark, NgrokMark } from "./brand-icons";
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
    openrouter: OpenRouterMark
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

/** The logo for a marketplace integration slug (a neutral fallback otherwise). */
export function IntegrationLogo({ slug, className }: { slug: string; className?: string }) {
    if (slug === "virustotal") return <VirusTotalLogo className={className} brand />;
    if (slug === "github") return <GitHubMark className={className} />;
    if (slug === "google") return <GoogleMark className={className} />;
    if (slug === "cloudflare") return <CloudflareMark className={className} />;
    if (slug === "ngrok") return <NgrokMark className={className} />;
    if (slug === "dymo") return <DymoMark className={className} />;
    // DuckDNS ships only an official raster mark; served from public/ as a static asset.
    if (slug === "duckdns") return <img src="/logos/duckdns.webp" alt="" className={cn("shrink-0", className)} />;
    const ModelMark = MODEL_MARKS[slug];
    if (ModelMark) return <ModelMark className={className} />;
    return <Blocks className={className} />;
}
