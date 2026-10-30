/** The pieces the step-by-step guides on these screens share. */

import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";

/** A value to type elsewhere: shown verbatim, copied in one click. */
export function Value({ text }: { text: string }) {
    return (
        <span className="inline-flex items-center gap-1">
            <code className="text-foreground">{text}</code>
            <CopyButton value={text} className="[&_svg]:size-3" />
        </span>
    );
}

/** A value from a provider's own menus, as it is shown there. Keyed by its text,
 *  since one step can name several. */
export function bold(chunks: ReactNode[]) {
    return (
        <b key={String(chunks)} className="font-medium text-foreground">
            {chunks}
        </b>
    );
}

/** A range fills a single field with `start-end`, which every form here accepts. */
export function portText(rule: { readonly port: number; readonly endPort?: number }): string {
    return rule.endPort && rule.endPort !== rule.port
        ? `${rule.port}-${rule.endPort}`
        : `${rule.port}`;
}
