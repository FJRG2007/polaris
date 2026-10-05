/**
 * A connected app's mark: the brand's own logo when `clientBrand` recognised
 * it, and otherwise the first letter of whatever it calls itself, so a list of
 * unknown clients still reads as a list of different things.
 *
 * Every logo here is one the repo already ships (`model-marks`, and VS Code's
 * own file under /logos); nothing is fetched from the app.
 */

import { cn } from "@polaris/ui";
import type { ClientBrand } from "@/lib/mcp/oauth/client-brand";
import { ClaudeMark, CursorMark, OpenAiMark } from "@/components/model-marks";

/** The mark alone, for a caller that draws its own frame (the consent card). */
export function ClientMark({
    brand,
    name,
    className = "size-5"
}: {
    brand: ClientBrand | null;
    name: string;
    className?: string;
}) {
    if (brand === "claude" || brand === "claude-code") return <ClaudeMark className={className} />;
    if (brand === "chatgpt") return <OpenAiMark className={className} />;
    if (brand === "cursor") return <CursorMark className={className} />;
    if (brand === "vscode")
        // Microsoft's own file, served as it ships: its masks and gradients
        // carry ids that would collide inline.
        // eslint-disable-next-line @next/next/no-img-element
        return <img src="/logos/vscode.svg" alt="" className={className} />;
    return (
        <span className="text-sm font-semibold uppercase text-muted-foreground" aria-hidden>
            {Array.from(name.trim())[0] ?? "?"}
        </span>
    );
}

export function ClientLogo({
    brand,
    name,
    className
}: {
    brand: ClientBrand | null;
    name: string;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted/40",
                className
            )}
            aria-hidden
        >
            <ClientMark brand={brand} name={name} />
        </span>
    );
}
