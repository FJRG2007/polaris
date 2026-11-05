"use client";

/**
 * What pressing a person does, where that is decided by the screen around them.
 *
 * A mention is drawn by the rich-text reader, which every app in Polaris uses and
 * which must not learn what any one of them does with a person. So the screen
 * says, by providing this: the chat opens that person's card, and a screen that
 * provides nothing leaves a mention as the label it has always been.
 */

import { createContext, useContext } from "react";
import { PersonNameTag } from "@/components/name-tags/person-name-tag";

/** Somebody pressed, and the thing they were pressed on - which is where a card
 *  about them opens beside. */
export type PersonPress = (person: { id: string; name: string }, anchor: HTMLElement) => void;

export const PersonPressContext = createContext<PersonPress | null>(null);

/** What pressing a person does here, or null where nothing is decided. */
export function usePersonPress(): PersonPress | null {
    return useContext(PersonPressContext);
}

/**
 * A mention of somebody.
 *
 * A button only where pressing it does something. Where nothing is decided it is
 * the same label it always was, so a mention never looks like somewhere to click
 * and then goes nowhere.
 */
export function PersonMention({
    id,
    label,
    className
}: {
    id: string;
    label: string;
    className: string;
}) {
    const press = usePersonPress();
    if (!id) return <span className={className}>{label}</span>;
    // The tag sits outside the chip, as it does after every other drawn name.
    if (!press)
        return (
            <>
                <span className={className}>{label}</span>
                <PersonNameTag id={id} />
            </>
        );
    return (
        <>
            <button
                type="button"
                onClick={(event) => {
                    // A mention inside a message sits inside that message's own
                    // press targets; this press is about the person.
                    event.stopPropagation();
                    press({ id, name: label.replace(/^@/, "") }, event.currentTarget);
                }}
                className={`${className} cursor-pointer hover:bg-primary/25`}
            >
                {label}
            </button>
            <PersonNameTag id={id} />
        </>
    );
}
