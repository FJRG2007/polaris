/**
 * An MCP client's mark on a tile: the AI assistants screen's guide picker and
 * the downloads screen's assistants card draw the same one.
 */

import { cn } from "@polaris/ui";
import { Plug } from "lucide-react";
import type { ClientLogo } from "@/lib/mcp/client-guides";
import { ClaudeMark, CursorMark, OpenAiMark } from "@/components/model-marks";

/** A client's mark on a light tile, so marks drawn in black read in dark mode
 *  without being recoloured. */
export function LogoTile({ logo, className }: { logo: ClientLogo | null; className?: string }) {
    const mark =
        logo === null ? (
            <Plug className="size-5 text-neutral-500" aria-hidden />
        ) : "mark" in logo ? (
            logo.mark === "claude" ? (
                <ClaudeMark className="size-5" />
            ) : logo.mark === "openai" ? (
                <OpenAiMark className="size-5" />
            ) : (
                <CursorMark className="size-5" />
            )
        ) : (
            // The vendors' own files, served as they ship: their gradients and
            // clip paths carry ids that would collide inline.
            <img src={logo.src} alt="" className="size-5 object-contain" />
        );
    return (
        <span
            className={cn(
                "grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-white text-neutral-900",
                className
            )}
            aria-hidden
        >
            {mark}
        </span>
    );
}
