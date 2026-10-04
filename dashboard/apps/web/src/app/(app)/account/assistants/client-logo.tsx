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

export function ClientLogo({
    brand,
    name,
    className
}: {
    brand: ClientBrand | null;
    name: string;
    className?: string;
}) {
    const mark = "size-5";
    let inner;
    if (brand === "claude" || brand === "claude-code") inner = <ClaudeMark className={mark} />;
    else if (brand === "chatgpt") inner = <OpenAiMark className={mark} />;
    else if (brand === "cursor") inner = <CursorMark className={mark} />;
    else if (brand === "vscode")
        // Microsoft's own file, served as it ships: its masks and gradients
        // carry ids that would collide inline.
        // eslint-disable-next-line @next/next/no-img-element
        inner = <img src="/logos/vscode.svg" alt="" className={mark} />;
    else
        inner = (
            <span className="text-sm font-semibold uppercase text-muted-foreground" aria-hidden>
                {Array.from(name.trim())[0] ?? "?"}
            </span>
        );
    return (
        <span
            className={cn(
                "grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted/40",
                className
            )}
            aria-hidden
        >
            {inner}
        </span>
    );
}
