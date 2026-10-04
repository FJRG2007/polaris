"use client";

/**
 * Web links and email addresses an event shows, made into something to act on.
 *
 * A press on an address opens a new message to it in Polaris Mail when the
 * reader has Mail (`/mail/compose`, the same door a `mailto:` link anywhere
 * else is sent through), and the device's own mail app otherwise - a visitor
 * on a public page, or somebody without Mail. A web link opens in a new tab.
 * Right-click, a long press or the menu key on either opens a menu with the
 * same action and a copy of the address.
 *
 * Whether Mail is there, and how a copy is confirmed, come from the screen
 * through `ContactLinksProvider`; without one (a public page) an address is a
 * `mailto:` and a copy says so beside the link.
 */

import { useCalendarT } from "./i18n";
import * as mailActions from "../actions/mail";
import { cacheKey, useCachedRead } from "./cached-read";
import { isWebLink, linkify, meetingLink } from "./editor-model";
import { Copy, ExternalLink, Mail, MapPin, Video } from "lucide-react";
import {
    Button,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuTrigger,
    useToast
} from "@polaris/ui";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface ContactLinks {
    /** The reader can write from Polaris Mail. */
    readonly compose: boolean;
    /** Say something briefly (the app's toast); null shows it beside the link. */
    readonly notify: ((message: string) => void) | null;
}

const ContactLinksContext = createContext<ContactLinks>({ compose: false, notify: null });

export const ContactLinksProvider = ContactLinksContext.Provider;

/**
 * The signed-in calendar's links: a new message in Polaris Mail for whoever has
 * Mail (read once, then painted from the last answer), and a copy confirmed by
 * the app's toast. Until the answer arrives an address is a `mailto:`.
 */
export function SignedInContactLinks({ children }: { children: ReactNode }) {
    const toast = useToast();
    const read = useCachedRead<boolean>(
        cacheKey("mail-compose"),
        async () => {
            const answer = await mailActions.mailComposeAction();
            return answer.ok ? answer.compose : false;
        },
        { freshMs: 5 * 60_000 }
    );
    const compose = read.data ?? false;
    const value = useMemo<ContactLinks>(
        () => ({
            compose,
            notify: (message) => toast.show({ key: "calendar-link-copied", title: message })
        }),
        [compose, toast]
    );
    return <ContactLinksProvider value={value}>{children}</ContactLinksProvider>;
}

/** What the screen said about Mail and copies. */
export function useContactLinks(): ContactLinks {
    return useContext(ContactLinksContext);
}

/** Where writing to these addresses starts: a new message in Polaris Mail, or a
 *  `mailto:` for the device's own mail app. */
export function emailHref(addresses: readonly string[], compose: boolean): string {
    const mailto = `mailto:${addresses.map(encodeURIComponent).join(",")}`;
    return compose ? `/mail/compose?url=${encodeURIComponent(mailto)}` : mailto;
}

/** Hand a value to the clipboard; false when the browser refused. */
async function copyText(value: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(value);
        return true;
    } catch {
        return false;
    }
}

const LINK_CLASS =
    "break-words text-foreground underline underline-offset-2 hover:text-muted-foreground";

function LinkMenu({
    kind,
    value,
    href,
    children,
    className,
    title
}: {
    kind: "email" | "web";
    /** The address itself: what is copied and named at the top of the menu. */
    value: string;
    href: string;
    children: ReactNode;
    className?: string;
    title?: string;
}) {
    const t = useCalendarT();
    const { notify } = useContactLinks();
    const [said, setSaid] = useState<string | null>(null);
    useEffect(() => {
        if (!said) return;
        const timer = setTimeout(() => setSaid(null), 2000);
        return () => clearTimeout(timer);
    }, [said]);

    const external = kind === "web" || href.startsWith("mailto:");
    const copy = async () => {
        const copied = await copyText(value);
        const message = !copied
            ? t("links.copyFailed")
            : kind === "email"
              ? t("links.copiedEmail")
              : t("links.copiedLink");
        if (notify) notify(message);
        else setSaid(message);
    };

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <a
                        href={href}
                        target={kind === "web" ? "_blank" : undefined}
                        rel={external ? "noopener noreferrer" : undefined}
                        className={cn(LINK_CLASS, className)}
                        title={title}
                    >
                        {children}
                    </a>
                </ContextMenuTrigger>
                <ContextMenuContent
                    className="w-56"
                    aria-label={kind === "email" ? t("links.emailMenu") : t("links.linkMenu")}
                >
                    <ContextMenuLabel title={value}>{value}</ContextMenuLabel>
                    <ContextMenuItem asChild>
                        <a
                            href={href}
                            target={kind === "web" ? "_blank" : undefined}
                            rel={external ? "noopener noreferrer" : undefined}
                        >
                            {kind === "email" ? (
                                <Mail className="size-4" />
                            ) : (
                                <ExternalLink className="size-4" />
                            )}
                            {kind === "email" ? t("links.sendEmail") : t("links.openLink")}
                        </a>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copy()}>
                        <Copy className="size-4" />
                        {kind === "email" ? t("links.copyEmail") : t("links.copyLink")}
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
            {said ? (
                <span role="status" className="ml-1.5 text-xs text-muted-foreground">
                    {said}
                </span>
            ) : null}
        </>
    );
}

/** An email address: a new message to it on a press, its menu on a right-click. */
export function EmailLink({
    address,
    children,
    className
}: {
    address: string;
    /** What is shown; the address itself when omitted. */
    children?: ReactNode;
    className?: string;
}) {
    const { compose } = useContactLinks();
    return (
        <LinkMenu
            kind="email"
            value={address}
            href={emailHref([address], compose)}
            className={className}
            title={address}
        >
            {children ?? address}
        </LinkMenu>
    );
}

/** A web link, opened in a new tab; anything that is not http(s) stays text. */
export function WebLink({
    href,
    children,
    className
}: {
    href: string;
    children?: ReactNode;
    className?: string;
}) {
    if (!isWebLink(href)) return <span className={className}>{children ?? href}</span>;
    return (
        <LinkMenu kind="web" value={href} href={href} className={className}>
            {children ?? href}
        </LinkMenu>
    );
}

/** Text with its web links and email addresses made into links. */
export function LinkedText({ text }: { text: string }) {
    return (
        <>
            {linkify(text).map((part, index) =>
                part.kind === "web" && part.href ? (
                    <WebLink key={index} href={part.href}>
                        {part.text}
                    </WebLink>
                ) : part.kind === "email" && part.email ? (
                    <EmailLink key={index} address={part.email}>
                        {part.text}
                    </EmailLink>
                ) : (
                    <span key={index}>{part.text}</span>
                )
            )}
        </>
    );
}

/**
 * Where an event is: its links and addresses live, and a meeting link that is
 * the whole location also offered as Join - unless the event's own conference
 * is that same link, which is already offered beside it.
 */
export function LocationLine({
    location,
    conference,
    className,
    iconClassName
}: {
    location: string;
    conference: string;
    className?: string;
    iconClassName?: string;
}) {
    const t = useCalendarT();
    const meeting = meetingLink(location);
    return (
        <div className="flex flex-col gap-2">
            <p className={cn("flex items-start gap-1.5", className)}>
                <MapPin
                    aria-hidden
                    className={cn("shrink-0 text-foreground-subtle", iconClassName)}
                />
                <span className="min-w-0 whitespace-pre-wrap break-words">
                    <LinkedText text={location} />
                </span>
            </p>
            {meeting && meeting !== conference.trim() ? (
                <Button asChild size="sm" variant="outline" className="self-start">
                    <a href={meeting} target="_blank" rel="noopener noreferrer">
                        <Video />
                        {t("editor.join")}
                    </a>
                </Button>
            ) : null}
        </div>
    );
}
