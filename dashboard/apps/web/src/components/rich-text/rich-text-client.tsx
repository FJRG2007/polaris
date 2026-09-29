"use client";

/**
 * The parts of rendered text that speak the reader's language.
 *
 * Their own client module because they read the catalogs with a hook, and
 * `RichText` is also rendered by server components - the public note page among
 * them - where a client hook in the same module fails the whole page. Rendered
 * as components from there, they cross that boundary with plain props.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import * as refs from "./references";
import type { JSONContent } from "@tiptap/core";
import { chipClass, chipLabel } from "./chip";
import type { NamespaceKey } from "@/lib/i18n/types";
import { PersonMention } from "@/components/person-press";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The box a checklist item is drawn with, named for what it says. */
export function TaskBox({ checked }: { checked: boolean }) {
    const t = useTranslations("components");
    return (
        <input
            type="checkbox"
            disabled
            checked={checked}
            aria-label={checked ? t("editor.done") : t("editor.notDone")}
            className="mt-1 shrink-0"
        />
    );
}

export function Chip({ node }: { node: JSONContent }) {
    const t = useTranslations("components");
    const kind = node.attrs?.kind as refs.ReferenceKind;
    const id = String(node.attrs?.id ?? "");

    // Something this reader may not see. Drawn as a chip rather than left as a
    // raw address - the message still says a thing was pointed at - and named
    // nowhere, because the name is what is being withheld. No link either: it
    // would go somewhere that would refuse them.
    if (node.attrs?.unavailable === true) {
        return (
            <span
                className={`${chipClass(kind)} italic opacity-70`}
                title={t("editor.noAccess")}
            >
                {t("editor.unavailable")}
            </span>
        );
    }

    const label = chipLabel(kind, String(node.attrs?.label ?? ""), (of) =>
        t.has(`editor.unnamed.${of}`) ? t(`editor.unnamed.${of}` as NamespaceKey<"components">) : undefined
    );
    // A person has no page of their own to link to from here; what pressing one
    // does is the screen's to decide - see `PersonMention`.
    if (kind === "user") return <PersonMention id={id} label={label} className={chipClass(kind)} />;
    const href = refs.referenceHref(kind, id);
    if (!href) return <span className={chipClass(kind)}>{label}</span>;
    return (
        <Link href={href} className={cn(chipClass(kind), "no-underline hover:bg-muted-foreground/20")}>
            {label}
        </Link>
    );
}
