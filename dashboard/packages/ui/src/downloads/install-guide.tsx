"use client";

/**
 * The guide that opens once a file's download has started: three cards side by
 * side, each a picture of the step and one sentence - open the file, install
 * it, use it.
 *
 * The pictures are drawn here rather than captured, so they follow the theme and
 * the reader's own browser and system: the download list where their browser
 * keeps it, and the taskbar or dock their system has. Their motion (a ring on
 * the download button, a bar filling, a pointer) is `motion-safe` only, so a
 * reader who asked for less motion sees the same pictures standing still.
 *
 * It takes its words already translated, so the dashboard and the public site
 * each bring their own catalog; `install-guide-steps.ts` says which words.
 */

import { cn } from "../lib/cn";
import { Download, MousePointer2, Puzzle } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import {
    detectGuideEnv,
    type GuideArt,
    type GuideBrowser,
    type GuideOs
} from "./install-guide-steps";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "../components/dialog";

/** One step, in the words the reader sees. */
export interface GuideStepView {
    readonly art: GuideArt;
    /** "Step 1", already translated. */
    readonly label: string;
    readonly title: string;
    readonly body: string;
}

/** What the guide says and about which file; translated by the screen that opens it. */
export interface InstallGuideContent {
    readonly title: string;
    /** The line under the title, usually with the link that downloads the file again. */
    readonly description: ReactNode;
    readonly steps: readonly GuideStepView[];
    /** The file's name, as the download list shows it. */
    readonly fileName: string;
    /** What the app is called once it is installed. */
    readonly appName: string;
    /** "Done", as a download list says it. */
    readonly doneLabel: string;
}

/** The class every moving part carries, so nothing moves for reduced motion. */
const PULSE = "motion-safe:animate-ping";
const POINTER = "motion-safe:animate-bounce";

/** The pointer that shows where to press. */
function Pointer({ className }: { className?: string }) {
    return (
        <MousePointer2
            data-motion="pointer"
            className={cn(
                "absolute size-4 fill-foreground text-background drop-shadow",
                POINTER,
                className
            )}
        />
    );
}

/** A ring that draws the eye to the button it sits on. */
function Ring() {
    return (
        <span
            data-motion="pulse"
            className={cn(
                "absolute inset-0 rounded-full border-2 border-primary opacity-60",
                PULSE
            )}
        />
    );
}

/** The browser's download list, where that browser keeps it. */
function DownloadArt({
    browser,
    fileName,
    doneLabel
}: {
    browser: GuideBrowser;
    fileName: string;
    doneLabel: string;
}) {
    const firefox = browser === "firefox";
    const safari = browser === "safari";
    return (
        <div className="absolute inset-3 overflow-hidden rounded-lg border border-border bg-background">
            {/* The toolbar, with the download button at its right end. */}
            <div className="flex h-7 items-center gap-1.5 border-b border-border bg-surface px-2">
                <span className="size-1.5 rounded-full bg-foreground-subtle/50" />
                <span className="size-1.5 rounded-full bg-foreground-subtle/50" />
                <span className={cn("h-3.5 flex-1 rounded bg-field", safari && "mx-6")} />
                <span
                    data-browser={browser}
                    className={cn(
                        "relative grid size-5 place-items-center text-foreground",
                        firefox ? "rounded-sm" : "rounded-full"
                    )}
                >
                    <Ring />
                    {/* Firefox shows an arrow over a line, the others a plain arrow. */}
                    <Download className="size-3.5" />
                </span>
            </div>
            {/* The list that opens under it. */}
            <div
                className={cn(
                    "absolute right-2 top-9 w-[78%] rounded-md border border-border bg-elevated p-2 shadow-popover",
                    safari && "right-auto left-1/2 -translate-x-1/2",
                    firefox && "rounded-sm"
                )}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                        <Download className="size-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p
                            className="truncate text-[11px] font-medium text-foreground"
                            title={fileName}
                        >
                            {fileName}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{doneLabel}</p>
                    </div>
                </div>
                <Pointer className="bottom-0 right-3" />
            </div>
        </div>
    );
}

/** A window installing the app, its bar filling. */
function ProgressArt({ appName }: { appName: string }) {
    return (
        <div className="absolute inset-x-5 inset-y-6 flex flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-popover">
            <div className="flex h-6 items-center gap-1 border-b border-border px-2">
                <span className="size-1.5 rounded-full bg-foreground-subtle/50" />
                <span className="size-1.5 rounded-full bg-foreground-subtle/50" />
                <span
                    className="ml-1 min-w-0 truncate text-[10px] text-muted-foreground"
                    title={appName}
                >
                    {appName}
                </span>
            </div>
            <div className="flex flex-1 flex-col justify-center gap-2 px-3">
                <span className="h-2 w-2/3 rounded bg-muted" />
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                        data-motion="progress"
                        className="h-full w-[70%] rounded-full bg-primary motion-safe:animate-[guide-fill_2.8s_ease-out_infinite]"
                    />
                </div>
            </div>
        </div>
    );
}

/** The app's mark, highlighted with its name above it. */
function AppTile({ appName }: { appName: string }) {
    return (
        <span className="relative grid size-7 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground ring-2 ring-primary/40">
            {appName.slice(0, 1)}
            <span className="absolute -top-7 left-1/2 max-w-28 -translate-x-1/2 truncate whitespace-nowrap rounded bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-popover">
                {appName}
            </span>
            <Pointer className="-bottom-3 -right-2" />
        </span>
    );
}

/** The system's taskbar or dock with the app on it. */
function DockArt({ os, appName }: { os: GuideOs; appName: string }) {
    const icons = [0, 1, 2].map((key) => <span key={key} className="size-6 rounded-md bg-muted" />);
    if (os === "linux") {
        // A side dock, the way the most common desktops draw one.
        return (
            <div className="absolute inset-3 overflow-hidden rounded-lg border border-border bg-background">
                <div
                    data-os="linux"
                    className="absolute inset-y-0 left-0 flex w-10 flex-col items-center justify-center gap-2 bg-surface"
                >
                    {icons}
                    <AppTile appName={appName} />
                </div>
            </div>
        );
    }
    return (
        <div className="absolute inset-3 overflow-hidden rounded-lg border border-border bg-background">
            <div
                data-os={os}
                className={cn(
                    "absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-surface py-1.5",
                    os === "macos" && "inset-x-6 bottom-1.5 rounded-xl border border-border",
                    os === "windows" && "border-t border-border"
                )}
            >
                {icons}
                <AppTile appName={appName} />
            </div>
        </div>
    );
}

/** The browser's toolbar with the extension pinned beside the address bar. */
function ToolbarArt({ appName }: { appName: string }) {
    return (
        <div className="absolute inset-3 overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex h-9 items-center gap-2 border-b border-border bg-surface px-2 pt-6">
                <span className="h-3.5 flex-1 rounded bg-field" />
                <Puzzle className="size-3.5 text-muted-foreground" />
                <span className="relative top-2">
                    <AppTile appName={appName} />
                </span>
            </div>
        </div>
    );
}

function StepArt({
    art,
    content,
    browser,
    os
}: {
    art: GuideArt;
    content: InstallGuideContent;
    browser: GuideBrowser;
    os: GuideOs;
}) {
    if (art === "download")
        return (
            <DownloadArt
                browser={browser}
                fileName={content.fileName}
                doneLabel={content.doneLabel}
            />
        );
    if (art === "progress") return <ProgressArt appName={content.appName} />;
    if (art === "toolbar") return <ToolbarArt appName={content.appName} />;
    return <DockArt os={os} appName={content.appName} />;
}

/** The dialog itself: open and closed by whoever started the download. */
export function InstallGuideDialog({
    open,
    onOpenChange,
    content,
    browser,
    os
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    content: InstallGuideContent;
    browser: GuideBrowser;
    os: GuideOs;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[calc(100%-2rem)] max-w-3xl">
                <DialogHeader className="pr-8">
                    <DialogTitle>{content.title}</DialogTitle>
                    <DialogDescription>{content.description}</DialogDescription>
                </DialogHeader>
                {/* Side by side from `sm` up; stacked on a phone. */}
                <ol className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                    {content.steps.map((step) => (
                        <li
                            key={step.label}
                            className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
                        >
                            <div aria-hidden className="relative h-36 bg-surface">
                                <StepArt
                                    art={step.art}
                                    content={content}
                                    browser={browser}
                                    os={os}
                                />
                            </div>
                            <div className="flex min-w-0 flex-col gap-0.5 p-3">
                                <p className="text-xs text-muted-foreground">{step.label}</p>
                                <p className="text-sm font-semibold text-foreground">
                                    {step.title}
                                </p>
                                <p className="text-sm text-muted-foreground">{step.body}</p>
                            </div>
                        </li>
                    ))}
                </ol>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A link that downloads a file and opens its guide in the same press. The link
 * is followed as usual, so the download starts the way any other would, and the
 * guide is drawn for the browser and system detected at that moment.
 */
export function GuideDownloadLink({
    href,
    content,
    className,
    title,
    children
}: {
    href: string;
    content: InstallGuideContent;
    className?: string;
    title?: string;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [env, setEnv] = useState<{ browser: GuideBrowser; os: GuideOs }>({
        browser: "neutral",
        os: "neutral"
    });
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
        // A press that opens the file somewhere else is not a download here.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        setEnv(detectGuideEnv());
        setOpen(true);
    };
    return (
        <>
            {/* A plain link: a router link would prefetch the file. */}
            <a
                href={href}
                download
                rel="noreferrer"
                className={className}
                title={title}
                onClick={onClick}
            >
                {children}
            </a>
            <InstallGuideDialog
                open={open}
                onOpenChange={setOpen}
                content={content}
                browser={env.browser}
                os={env.os}
            />
        </>
    );
}
