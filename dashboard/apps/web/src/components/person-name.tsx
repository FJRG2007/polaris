"use client";

/**
 * Somebody's name, painted the way they asked for it.
 *
 * A name is the one part of a profile that appears in places its owner does not
 * control - a member list, a task's assignees, the top of a conversation - so
 * what this is allowed to do is deliberately small: two colours across the
 * letters and nothing else. No weight, no size, no face. A name that is bigger
 * than everybody else's in a column is not personalisation, it is a fight over
 * the column, and the person who loses it is whoever is trying to read the list.
 *
 * It renders a plain `<span>` and inherits everything else, so it can be dropped
 * into a heading, a row or a caption without bringing its own typography. An
 * account that has chosen nothing renders exactly what was there before: the
 * name, in the surrounding colour.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";
import { nameStyleCss } from "@/lib/profile-style-css";
import { useProfileStyle } from "@/components/profile-style-store";
import { nameStyleOf, nameplateOf, type Nameplate } from "@polaris/core";

export function PersonName({
    id,
    name,
    className,
    children
}: {
    /** Whose name it is. Null for somebody with no account - a guest in a call -
     *  who has a name and no appearance to go with it. */
    id: string | null | undefined;
    name: string;
    className?: string;
    /** Anything that belongs inside the name itself, like the "(you)" a member
     *  list puts after it. Kept inside so it is not orphaned by a truncation
     *  that ends the name. */
    children?: ReactNode;
}) {
    const style = nameStyleOf(useProfileStyle(id)?.nameStyle ?? null);
    return (
        <span className={className} style={style ? nameStyleCss(style) : undefined}>
            {name}
            {children}
        </span>
    );
}

/**
 * The plate somebody's row is drawn on, if they chose one.
 *
 * A hook rather than a component because a nameplate is a background for a row
 * that already exists - a member in a list, a person in a picker - and the row
 * is whatever that screen already built. Wrapping it in something would be a
 * second element inside every list in the product.
 */
export function usePersonNameplate(id: string | null | undefined): Nameplate | null {
    return nameplateOf(useProfileStyle(id)?.nameplate ?? null);
}

/** The class a row wears while it is on a plate: the hover tint and the border
 *  underneath it would both fight the gradient. */
export const PLATED_ROW = "border-transparent hover:brightness-110";

/** Convenience for the common case - a row that is plated or not. */
export function platedRow(plate: Nameplate | null, className?: string): string {
    return cn(className, plate && PLATED_ROW);
}
