"use client";

/**
 * What pressing a person does, where that is decided by the screen around them.
 *
 * A mention is drawn by the rich-text reader, which every app in Polaris uses and
 * which must not learn what any one of them does with a person. So the screen
 * says, by providing this: the chat opens that person's card, and a screen that
 * provides nothing leaves a mention as the label it has always been.
 */

import { cn } from "@polaris/ui";
import { PersonNameTag } from "@/components/name-tags/person-name-tag";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createContext, useContext, type ReactNode } from "react";

/** Somebody pressed, and the thing they were pressed on - which is where a card
 *  about them opens beside. `channelId` is the conversation they were found in,
 *  where that is not the one the screen is about (a search across all of them). */
export type PersonPress = (
    person: { id: string; name: string },
    anchor: HTMLElement,
    channelId?: string
) => void;

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

/**
 * Somebody drawn - their face, their name, or both - that opens their card when
 * pressed.
 *
 * A button only where pressing does something: where no screen decides, or there
 * is nobody to ask about (a guest, somebody who has left), it is what it always
 * was. The press stops here, so a tile that grows when pressed or a row that
 * jumps to a message still does that everywhere but on the name.
 */
export function PersonPressable({
    person,
    channelId,
    className,
    children
}: {
    person: { id: string | null | undefined; name: string };
    /** The conversation they were found in, when it is not this screen's. */
    channelId?: string;
    className?: string;
    children: ReactNode;
}) {
    const press = usePersonPress();
    const t = useTranslations("chat");
    const id = person.id;
    if (!press || !id) return <>{children}</>;
    return (
        <button
            type="button"
            title={t("messageList.viewProfile", { name: person.name })}
            onClick={(event) => {
                event.stopPropagation();
                press({ id, name: person.name }, event.currentTarget, channelId);
            }}
            className={cn(
                "min-w-0 cursor-pointer rounded text-start hover:underline focus-visible:underline",
                className
            )}
        >
            {children}
        </button>
    );
}
