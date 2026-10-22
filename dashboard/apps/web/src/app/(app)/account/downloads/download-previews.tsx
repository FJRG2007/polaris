"use client";

/**
 * The pictures at the foot of each downloads card: small drawings of what each
 * thing looks like in use, built here from the theme's own tokens so they follow
 * light and dark with the rest of the screen. Every one is decoration - the card
 * hides it from screen readers - and none is a screenshot of anything.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Bell,
    Grid3x3,
    KeyRound,
    Lightbulb,
    Lock,
    MessageSquare,
    Moon,
    Play,
    Plug,
    RotateCw,
    Search,
    Sparkles,
    Volume2
} from "lucide-react";

/** A bar standing in for a line of text. */
function Line({ className }: { className?: string }) {
    return <span className={cn("block h-1.5 rounded-full bg-foreground-subtle/25", className)} />;
}

/** A window rising from the bottom edge of the card, cut off by it. */
function Frame({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                "mx-auto h-full w-full max-w-md overflow-hidden rounded-t-lg border border-b-0 border-border bg-background",
                className
            )}
        >
            {children}
        </div>
    );
}

/** The three dots and a title bar. */
function TitleBar({ children }: { children?: ReactNode }) {
    return (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
            <span className="size-2 shrink-0 rounded-full bg-rose-400" />
            <span className="size-2 shrink-0 rounded-full bg-amber-400" />
            <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
            <div className="ml-2 min-w-0 flex-1">{children}</div>
        </div>
    );
}

/** Polaris in a window of its own: the rail, a header, three figures and a chart. */
export function WebAppPreview() {
    return (
        <Frame className="max-w-xl">
            <TitleBar>
                <Line className="mx-auto w-24" />
            </TitleBar>
            <div className="flex h-full">
                <div className="flex w-12 shrink-0 flex-col items-center gap-2.5 border-r border-border bg-surface py-3">
                    <span className="size-5 rounded-md bg-primary/80" />
                    {[0, 1, 2, 3, 4].map((key) => (
                        <span key={key} className="size-4 rounded bg-foreground-subtle/20" />
                    ))}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <Line className="w-28 bg-foreground/30" />
                        <span className="h-4 w-14 shrink-0 rounded bg-primary/70" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        {[0, 1, 2].map((key) => (
                            <div
                                key={key}
                                className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-card p-2"
                            >
                                <Line className="w-3/5" />
                                <Line className="h-2.5 w-4/5 bg-foreground/30" />
                            </div>
                        ))}
                    </div>
                    <div className="rounded-md border border-border bg-card p-2">
                        <svg
                            viewBox="0 0 200 48"
                            className="h-12 w-full"
                            preserveAspectRatio="none"
                        >
                            <polyline
                                points="0,40 20,34 40,36 60,24 80,28 100,16 120,20 140,10 160,14 180,6 200,8"
                                fill="none"
                                strokeWidth="2"
                                className="stroke-primary"
                                vectorEffect="non-scaling-stroke"
                            />
                        </svg>
                    </div>
                </div>
            </div>
        </Frame>
    );
}

/** A sign-in form with the extension's offer to fill it. */
export function ExtensionPreview() {
    const t = useTranslations("account");
    return (
        <Frame>
            <TitleBar>
                <span className="flex h-4 items-center gap-1 rounded-full bg-muted px-2">
                    <Lock className="size-2.5 shrink-0 text-foreground-subtle" />
                    <Line className="w-20" />
                </span>
            </TitleBar>
            <div className="flex gap-3 p-3">
                <div className="flex w-1/2 min-w-0 flex-col gap-2">
                    <Line className="w-16 bg-foreground/30" />
                    <span className="h-5 rounded border border-primary/60 bg-field" />
                    <span className="h-5 rounded border border-border bg-field" />
                    <span className="h-5 w-20 max-w-full rounded bg-primary/70" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border border-border bg-card p-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-foreground">
                        <KeyRound className="size-3 shrink-0 text-primary" />
                        {/* i18n-ignore the product's name */}
                        <span className="truncate">Polaris</span>
                    </span>
                    {[0, 1].map((key) => (
                        <span
                            key={key}
                            className="flex items-center gap-1.5 rounded bg-muted px-1.5 py-1"
                        >
                            <span className="size-3 shrink-0 rounded-full bg-sky-400/60" />
                            <Line className="w-3/4" />
                        </span>
                    ))}
                    <span className="mt-0.5 truncate rounded bg-primary/80 px-1.5 py-0.5 text-center text-[10px] font-medium text-primary-foreground">
                        {t("downloads.preview.fill")}
                    </span>
                </div>
            </div>
        </Frame>
    );
}

/** What the deck's keys show, one icon and colour each. */
const DECK_KEYS = [
    { icon: MessageSquare, tone: "text-sky-400" },
    { icon: Bell, tone: "text-amber-400" },
    { icon: Moon, tone: "text-violet-400" },
    { icon: RotateCw, tone: "text-emerald-400" },
    { icon: Lightbulb, tone: "text-yellow-400" },
    { icon: Play, tone: "text-pink-400" },
    { icon: Volume2, tone: "text-sky-400" },
    { icon: Grid3x3, tone: "text-neutral-400" },
    { icon: Sparkles, tone: "text-violet-400" },
    { icon: Plug, tone: "text-emerald-400" }
];

/** A deck of fifteen keys with something on each. Hardware is dark in either theme. */
export function DeckPreview() {
    return (
        <div className="mx-auto h-full w-full max-w-xs rounded-t-2xl border border-b-0 border-border bg-neutral-900 p-3">
            <div className="grid grid-cols-5 gap-2">
                {[...DECK_KEYS, ...DECK_KEYS.slice(0, 5)].map(({ icon: Icon, tone }, index) => (
                    <span
                        key={index}
                        className="grid aspect-square place-items-center rounded-md border border-white/10 bg-neutral-800"
                    >
                        <Icon className={cn("size-4", tone)} />
                    </span>
                ))}
            </div>
        </div>
    );
}

/** A terminal that has just signed in and listed its projects. Dark in either theme. */
export function TerminalPreview() {
    const t = useTranslations("account");
    return (
        <Frame className="bg-neutral-950">
            <div className="flex flex-col gap-1 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
                <p className="truncate">
                    <span className="text-emerald-400">$</span>
                    {/* i18n-ignore commands, typed as they are */}
                    {" plr login"}
                </p>
                <p className="truncate text-neutral-500">{t("downloads.preview.signedIn")}</p>
                <p className="truncate">
                    <span className="text-emerald-400">$</span>
                    {/* i18n-ignore commands, typed as they are */}
                    {" plr projects"}
                </p>
                {/* i18n-ignore sample project names */}
                {["shop", "blog", "api"].map((name) => (
                    <p key={name} className="flex min-w-0 items-center gap-2">
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                        <span className="w-12 shrink-0">{name}</span>
                        <span className="truncate text-neutral-500">
                            {t("downloads.preview.running")}
                        </span>
                    </p>
                ))}
            </div>
        </Frame>
    );
}

/** An assistant asked to do something in Polaris, and doing it. */
export function AssistantPreview() {
    const t = useTranslations("account");
    return (
        <Frame>
            <div className="flex flex-col gap-2 p-3 text-[11px]">
                <p className="ml-auto max-w-[80%] rounded-lg rounded-br-sm bg-primary/80 px-2.5 py-1.5 text-primary-foreground">
                    {t("downloads.preview.ask")}
                </p>
                <span className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-foreground-subtle">
                    <Plug className="size-3 shrink-0" />
                    {/* i18n-ignore the product's name */}
                    <span className="truncate">Polaris</span>
                </span>
                <p className="max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-2.5 py-1.5 text-foreground">
                    {t("downloads.preview.answer")}
                </p>
            </div>
        </Frame>
    );
}

/** The desktop app following a service's logs. */
export function DesktopPreview() {
    const widths = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5", "w-3/5"];
    return (
        <Frame>
            <TitleBar>
                <Line className="w-16" />
            </TitleBar>
            <div className="flex flex-col gap-2 p-3">
                <div className="flex items-center gap-2">
                    <Search className="size-3 shrink-0 text-foreground-subtle" />
                    <span className="h-4 flex-1 rounded bg-field" />
                </div>
                {widths.map((width, index) => (
                    <span key={width} className="flex items-center gap-2">
                        <span
                            className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                index === 3 ? "bg-amber-400" : "bg-emerald-400"
                            )}
                        />
                        <Line className={width} />
                    </span>
                ))}
            </div>
        </Frame>
    );
}

/** A phone with Polaris on its home screen, drawn faint: there is no app yet. */
export function PhonePreview() {
    return (
        <div className="mx-auto flex h-full w-36 flex-col gap-2 rounded-t-[1.75rem] border-[5px] border-b-0 border-neutral-300 bg-background p-3 opacity-80 dark:border-neutral-700">
            <span className="mx-auto h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
            <div className="grid grid-cols-3 gap-2 pt-1">
                {[0, 1, 2, 3, 4, 5].map((key) => (
                    <span
                        key={key}
                        className={cn(
                            "aspect-square rounded-lg",
                            key === 0 ? "bg-primary/70" : "bg-foreground-subtle/15"
                        )}
                    />
                ))}
            </div>
        </div>
    );
}
