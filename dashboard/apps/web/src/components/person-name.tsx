"use client";

/**
 * Somebody's name, painted the way they asked for it.
 *
 * A name is the one part of a profile that appears in places its owner does not
 * control - a member list, a task's assignees, the top of a conversation - so
 * what this is allowed to do is deliberately small: colours across the letters,
 * still or walking, and nothing else. No weight, no size, no face. A name that is
 * bigger than everybody else's in a column is not personalisation, it is a fight
 * over the column, and the person who loses it is whoever is reading the list.
 *
 * It renders a plain `<span>` and inherits everything else, so it can be dropped
 * into a heading, a row or a caption without bringing its own typography. An
 * account that has chosen nothing renders exactly what was there before: the
 * name, in the surrounding colour.
 *
 * `PersonRow` at the bottom of this file is the other half: the plate that goes
 * behind a person's row in a list. The two travel together - wherever a list
 * draws somebody, it draws both - and they are here rather than in each screen
 * so that adding a people list somewhere new does not mean deciding this again.
 */

import { cn } from "@polaris/ui";
import { createContext, useContext } from "react";
import { useProfileStyle } from "@/components/profile-style-store";
import { nameLookOf, nameplateOf, type Nameplate } from "@polaris/core";
import { nameStyleClass, nameLookCss, nameplateCss } from "@/lib/profile-style-css";
import type { ComponentPropsWithoutRef, CSSProperties, ElementType, ReactNode } from "react";

/**
 * The places a person is a row of data rather than a person.
 *
 * An account list under Administration, and any picker where somebody is being
 * chosen for something, are both read by scanning: what is wanted is the name
 * that matches, found among two hundred others, as fast as the eye can move down
 * the column. A gradient across the letters and a plate behind the row are the
 * two things that stop that working, and neither of them is what the reader came
 * for - they are what their owner chose to say about themselves somewhere it is
 * their turn to speak.
 *
 * So it is switched off by surface rather than by call site. `<PlainNames>`
 * around a table or a picker, and every name and every plate inside it draws as
 * everybody else's does, however deep it is and whichever list is added there
 * next. The alternative - a prop on each of thirty call sites - is a rule that
 * holds until the thirty-first.
 *
 * Everywhere else keeps them: Chat, a profile, the direct message list, the
 * members of a server, the people already assigned to a task. Those are the
 * screens the choice was made for.
 */
const PlainNamesContext = createContext(false);

export function PlainNames({ children }: { children: ReactNode }) {
    return <PlainNamesContext.Provider value={true}>{children}</PlainNamesContext.Provider>;
}

/** Whether this part of the screen draws people plainly. */
export function useNamesArePlain(): boolean {
    return useContext(PlainNamesContext);
}

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
    const plain = useNamesArePlain();
    const chosen = nameLookOf(useProfileStyle(id)?.nameStyle ?? null);
    const style = plain ? null : chosen;
    return (
        <span
            className={cn(className, nameStyleClass(style))}
            style={style ? nameLookCss(style) : undefined}
        >
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
    const plain = useNamesArePlain();
    const plate = nameplateOf(useProfileStyle(id)?.nameplate ?? null);
    return plain ? null : plate;
}

/** The class a row wears while it is on a plate: the hover tint and the border
 *  underneath it would both fight the gradient. */
export const PLATED_ROW = "border-transparent hover:brightness-110";

/**
 * The class that holds a plate back until the row is the one being pointed at.
 *
 * For lists where every row is a person and the list is long - the direct
 * messages down the side of Chat is the one this was written for. Painting a
 * gradient behind every row there does two things at once, and both are bad: the
 * column stops being scannable, and the hover and open-conversation tints are
 * painted over, so the list loses the only marks that said where you were.
 *
 * So the plate becomes the hover: it is what appears under the pointer, under
 * the keyboard focus, and under the conversation that is open. The values ride
 * as custom properties rather than as an inline background, because an inline
 * background wins over every rule and there would be nothing left to reveal. The
 * rule itself lives in `globals.css`.
 *
 * A list of a dozen people whose whole point is who they are - a roster, the
 * members of a conversation - keeps the plate on every row. That is the default.
 */
export const PLATE_ON_ACTIVE = "plate-on-active";

/** Convenience for the common case - a row that is plated or not. */
export function platedRow(plate: Nameplate | null, className?: string): string {
    return cn(className, plate && PLATED_ROW);
}

/**
 * A row that stands for a person, wearing their plate.
 *
 * The plate was chosen once and then drawn in exactly one list - the members of
 * a conversation - because a nameplate needs a hook, a hook needs a component,
 * and every other people list in the product maps its rows inline in the screen
 * that owns them. So a decision somebody made about how they appear was visible
 * in one place out of thirty, which is indistinguishable from it not working.
 *
 * This is that component, once. It IS the row rather than something inside it -
 * `as` takes whatever element the list already used, an `li`, a `button`, a
 * `Link`, a menu item - so adopting it is a changed tag rather than an extra box
 * in every list, and the layout the screen already had is untouched.
 *
 * Somebody with no plate gets exactly what they got before: no background, no
 * class, no extra element. That is most people, so it has to be free.
 */
export function PersonRow<T extends ElementType = "div">({
    personId,
    as,
    plate: when = "always",
    className,
    style,
    ...rest
}: {
    /** Whose row it is. Null - a guest, a group, an organization - draws plainly
     *  and asks the store about nobody. */
    personId: string | null | undefined;
    as?: T;
    /** When to actually paint it. `always` for a list about who people are;
     *  `active` for a long navigation list, where the plate becomes the hover
     *  instead of covering it - see `PLATE_ON_ACTIVE`. */
    plate?: "always" | "active";
} & Omit<ComponentPropsWithoutRef<T>, "as" | "personId" | "plate">) {
    const plate = usePersonNameplate(personId);
    const Tag = (as ?? "div") as ElementType;
    const held = plate && when === "active";
    return (
        <Tag
            // Published so a list can say something a plate would otherwise
            // swallow. An inline background beats every class, so a row that
            // marked itself with `bg-*` - the conversation you are reading, the
            // option under the pointer - simply stops being marked once somebody
            // has a plate. `data-[plated]:` is where that row puts the ring or
            // the outline it uses instead.
            data-plated={plate && !held ? "" : undefined}
            className={cn(
                held ? PLATE_ON_ACTIVE : platedRow(plate, undefined),
                className as string | undefined
            )}
            // The screen's own properties win: a row that sets its own colour
            // for a reason - a name that is yours, a row that is disabled - is
            // making a statement the plate has no business overruling.
            //
            // Held back, the same two values ride as custom properties instead:
            // an inline background beats every rule, and there would be nothing
            // left for the hover to reveal.
            style={
                plate
                    ? held
                        ? ({
                              ...plateVariables(plate),
                              ...(style as CSSProperties)
                          } as CSSProperties)
                        : { ...nameplateCss(plate), ...(style as CSSProperties) }
                    : style
            }
            {...rest}
        />
    );
}

/** The plate as two custom properties, for a row that reveals it rather than
 *  wearing it. Read by the `.plate-on-active` rule in `globals.css`. */
function plateVariables(plate: Nameplate): CSSProperties {
    const painted = nameplateCss(plate);
    return {
        "--plate-bg": painted.background,
        "--plate-fg": painted.color
    } as CSSProperties;
}
