/**
 * Brand logos for integrations, as inline single-path SVGs (official marks from
 * the Simple Icons set) so they inherit color via `currentColor` and ship with no
 * external requests. Add a new mark here when adding an integration.
 */

import { Blocks } from "lucide-react";
import { GitHubMark } from "./brand-icons";

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
            className={className}
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
    return <Blocks className={className} />;
}
