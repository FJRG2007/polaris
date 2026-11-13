"use client";

/**
 * Loading the extension by hand, step by step, for the browser in front of the
 * reader.
 *
 * Modelled on the router guide, because it is the same kind of job: a sequence
 * carried out somewhere Polaris cannot reach, where every value has to be exact.
 * So the browser is detected and preselected but stays a picker, the address is
 * shown verbatim with a copy button rather than as an anchor no browser would
 * follow, and the things to press are named as that browser names them.
 *
 * The steps are open rather than hidden behind a toggle. The router's are an
 * answer to "why is my domain not answering" and most readers never need them;
 * these are the whole content of the card they sit in.
 */

import { desktopInstaller } from "./desktop-install";
import { Button, CopyButton, Select, cn } from "../../index";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Download, MousePointer2, Pin, Puzzle } from "lucide-react";
import { BrowserMark } from "./client-marks";
import { useTranslations } from "../../i18n";
import {
    BROWSER_GUIDES,
    browserGuide,
    detectBrowser,
    isBraveBrowser,
    type BrowserGuide,
    type BrowserId
} from "./browser-guide";

/**
 * An address to paste into the browser's own bar, on a line of its own.
 *
 * It sits in a box rather than inline because copying it is the whole step, and
 * as a few words of code between two clauses the one thing to do here read as
 * punctuation. There is no button that opens it: a page is not allowed to
 * navigate to `chrome://` or `brave://` - Chrome documents that as deliberate -
 * and a button that quietly did nothing would be worse than none, so the copy is
 * made the obvious action instead.
 */
function AddressToPaste({ text }: { text: string }) {
    return (
        <span className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-foreground">
                {text}
            </code>
            <CopyButton value={text} />
        </span>
    );
}

/** Something to press, named the way the browser names it. */
function Press({ text }: { text: string }) {
    return <b className="font-medium text-foreground">{text}</b>;
}

/**
 * The browser to start on - the one the reader is in, once it has said which -
 * the one detected (null when it has no build, undefined until known), and the
 * setter for a browser the reader picks.
 */
export function useBrowserChoice(
    initial?: BrowserId
): [BrowserId, (browser: BrowserId) => void, BrowserId | null | undefined] {
    // Detected in an effect, not during render: this is rendered on the server
    // too, where there is no navigator, and seeding from one would have the
    // browser hydrate something the HTML does not contain.
    const [browser, setBrowser] = useState<BrowserId>(initial ?? "chrome");
    const [detected, setDetected] = useState<BrowserId | null | undefined>(undefined);
    // A browser the reader picked outranks the one that was detected. They may
    // be following these steps for a different browser than the one they are
    // reading in, which is exactly what the picker is for.
    // A browser's own row is a choice already made.
    const picked = useRef(initial !== undefined);

    useEffect(() => {
        let alive = true;
        void (async () => {
            // Inside the desktop app the page is not in a browser the reader
            // uses, so the question goes to the system: its default one.
            const named = await desktopInstaller()?.defaultBrowser?.();
            const found = named ? (named as BrowserId) : detectBrowser(navigator.userAgent);
            // Brave answers as Chrome in the user agent, so the guess is put to
            // the browser itself before it is shown - see `isBraveBrowser`.
            const real = !named && found === "chrome" && (await isBraveBrowser()) ? "brave" : found;
            if (!alive) return;
            setDetected(real);
            if (!picked.current && real) setBrowser(real);
        })();
        return () => {
            alive = false;
        };
    }, []);

    return [
        browser,
        (next) => {
            picked.current = true;
            setBrowser(next);
        },
        detected
    ];
}

/** The extension's name, as the browser lists it. */
const EXTENSION_NAME = "Polaris"; // i18n-ignore a product name

/** One thing to do, and the picture of the browser that shows it. */
type StepKind = "download" | "open" | "land" | "devMode" | "load" | "private" | "pin" | "point";

/** The steps for a browser, in order. Exported for the test that pins them. */
export function stepsFor(guide: BrowserGuide, after = false): StepKind[] {
    if (after) return ["private", "pin"];
    return [
        "download",
        "open",
        guide.id === "firefox" ? "land" : "devMode",
        "load",
        "private",
        "pin",
        "point"
    ];
}

/**
 * A phase that moves on every `ms` while the picture is on screen, so a step's
 * picture plays what the step says: the switch going on, the button being
 * pressed. Still on its last phase for somebody who asked for less motion.
 */
function usePhase(count: number, ms = 900): number {
    const [phase, setPhase] = useState(0);
    useEffect(() => {
        const still =
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
        if (still) {
            setPhase(count - 1);
            return;
        }
        setPhase(0);
        const timer = window.setInterval(() => setPhase((held) => (held + 1) % (count + 1)), ms);
        return () => window.clearInterval(timer);
    }, [count, ms]);
    return Math.min(phase, count - 1);
}

/** A switch as the browsers draw it. */
function Toggle({ on }: { on: boolean }) {
    return (
        <span
            className={cn(
                "relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-300",
                on ? "bg-primary" : "bg-muted-foreground/40"
            )}
        >
            <span
                className={cn(
                    "absolute top-0.5 size-2.5 rounded-full bg-background shadow-sm transition-transform duration-300",
                    on ? "translate-x-3" : "translate-x-0.5"
                )}
            />
        </span>
    );
}

/** The pointer that presses whatever it sits on. */
function Pointer({ pressing }: { pressing: boolean }) {
    return (
        <MousePointer2
            aria-hidden
            className={cn(
                "absolute -bottom-2 -right-2 size-3.5 shrink-0 fill-foreground text-background transition-transform duration-300",
                pressing ? "scale-90" : "translate-x-1 translate-y-1"
            )}
        />
    );
}

/** A small browser window with what the step changes in it, drawn not shot:
 *  it reads in either theme and in any language. */
function StepScene({ kind, guide }: { kind: StepKind; guide: BrowserGuide }) {
    const t = useTranslations("account");
    const phase = usePhase(kind === "open" ? guide.page.length : 3, kind === "open" ? 70 : 900);
    let body: ReactNode = null;
    if (kind === "download") {
        body = (
            <span className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
                <Download
                    aria-hidden
                    className={cn("size-3.5 shrink-0 text-primary transition-transform duration-300", phase === 1 && "translate-y-0.5")}
                />
                <span className="font-mono text-[10px]">polaris-{guide.file}.zip</span>
                {phase === 2 ? <Check aria-hidden className="size-3 shrink-0 text-success" /> : null}
            </span>
        );
    } else if (kind === "devMode" || kind === "private") {
        const label = kind === "devMode" ? t("downloads.steps.devModeLabel") : guide.privateSwitch;
        body = (
            <span className="relative flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[10px]">
                <span className="min-w-0 truncate">{label}</span>
                <Toggle on={phase >= 1} />
                <Pointer pressing={phase === 1} />
            </span>
        );
    } else if (kind === "load" || kind === "land") {
        body = (
            <span className="relative">
                <span
                    className={cn(
                        "inline-flex rounded-md border px-2 py-1 text-[10px] transition-colors duration-300",
                        phase >= 1 ? "border-primary bg-primary/15 text-foreground" : "border-border bg-card"
                    )}
                >
                    {kind === "land" ? guide.pageLabel : guide.action}
                </span>
                <Pointer pressing={phase === 1} />
            </span>
        );
    } else if (kind === "pin") {
        body = (
            <span className="flex items-center gap-1.5">
                <span className={cn("rounded p-1 transition-colors duration-300", phase === 0 ? "bg-primary/15" : "")}>
                    <Puzzle aria-hidden className="size-3.5 shrink-0" />
                </span>
                <span
                    className={cn(
                        "flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1 text-[10px] transition-opacity duration-300",
                        phase === 0 ? "opacity-0" : "opacity-100"
                    )}
                >
                    {EXTENSION_NAME}
                    <Pin aria-hidden className={cn("size-3 shrink-0", phase === 2 ? "fill-primary text-primary" : "")} />
                </span>
            </span>
        );
    } else if (kind === "point") {
        body = (
            <span className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-[10px]">
                <span className="font-medium">{EXTENSION_NAME}</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                    <span className="font-mono">{typeof window === "undefined" ? "" : window.location.host}</span>
                    {phase >= 1 ? <Check aria-hidden className="size-3 shrink-0 text-success" /> : null}
                </span>
            </span>
        );
    }
    return (
        <div aria-hidden className="flex w-60 max-w-full shrink-0 flex-col overflow-hidden rounded-md border border-border bg-surface">
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                <span className="flex gap-1">
                    <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                </span>
                <span className="min-w-0 flex-1 truncate rounded bg-field px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                    {kind === "open" ? guide.page.slice(0, phase + 1) : kind === "private" && guide.id === "firefox" ? "about:addons" : guide.page}
                    {kind === "open" ? <span className="ml-px inline-block w-px animate-pulse bg-foreground">&nbsp;</span> : null}
                </span>
            </div>
            <div className="flex min-h-16 items-center justify-center px-3 py-3">{body}</div>
        </div>
    );
}

/**
 * A numbered guide that walks one step at a time: the step being done is open
 * with its picture beside it, the ones behind are ticked, Continue moves on and
 * any step can be opened again by its number.
 */
function GuidedSteps({
    kinds,
    guide,
    render
}: {
    kinds: readonly StepKind[];
    guide: BrowserGuide;
    render: (kind: StepKind) => ReactNode;
}) {
    const t = useTranslations("account");
    const [current, setCurrent] = useState(0);
    const [finished, setFinished] = useState(false);
    const last = kinds.length - 1;
    return (
        <div className="flex flex-col gap-2">
            <ol className="flex flex-col gap-1.5">
                {kinds.map((kind, index) => {
                    const open = index === current && !finished;
                    const done = finished || index < current;
                    return (
                        <li
                            key={kind}
                            className={cn(
                                "rounded-md border transition-colors",
                                open ? "border-border bg-card" : "border-transparent"
                            )}
                        >
                            <button
                                type="button"
                                aria-current={open ? "step" : undefined}
                                aria-expanded={open}
                                onClick={() => {
                                    setFinished(false);
                                    setCurrent(index);
                                }}
                                className="flex w-full min-w-0 items-start gap-3 px-3 py-2 text-left text-sm"
                            >
                                <span
                                    className={cn(
                                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                                        done
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : open
                                              ? "border-primary text-primary"
                                              : "border-border text-muted-foreground"
                                    )}
                                >
                                    {done ? <Check aria-hidden className="size-3 shrink-0" /> : index + 1}
                                </span>
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 leading-relaxed",
                                        open ? "text-foreground" : "line-clamp-1 text-muted-foreground"
                                    )}
                                >
                                    {render(kind)}
                                </span>
                            </button>
                            {kind === "open" ? (
                                // Always in reach, and outside the step's own button: the copy is a button of its own.
                                <div className="px-3 pb-1 pl-11 text-sm">
                                    <AddressToPaste text={guide.page} />
                                </div>
                            ) : null}
                            {/* Wraps by the room the card has, not the window's: in a
                                narrow card the picture and the buttons, both fixed,
                                stood side by side past its padding. */}
                            {open ? (
                                <div className="flex min-w-0 flex-wrap items-end justify-between gap-3 px-3 pb-3 pl-11">
                                    <StepScene kind={kind} guide={guide} />
                                    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                                        <span className="text-xs text-muted-foreground">
                                            {t("downloads.steps.stepOf", { step: index + 1, total: kinds.length })}
                                        </span>
                                        {index > 0 ? (
                                            <Button size="sm" variant="ghost" onClick={() => setCurrent(index - 1)}>
                                                {t("downloads.steps.back")}
                                            </Button>
                                        ) : null}
                                        <Button
                                            size="sm"
                                            onClick={() => (index === last ? setFinished(true) : setCurrent(index + 1))}
                                        >
                                            {t(index === last ? "downloads.steps.finish" : "downloads.steps.next")}
                                        </Button>
                                    </div>
                                </div>
                            ) : null}
                        </li>
                    );
                })}
            </ol>
            {finished ? (
                <p role="status" className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
                    <Check aria-hidden className="size-3.5 shrink-0 text-success" />
                    {t("downloads.steps.finished")}
                </p>
            ) : null}
        </div>
    );
}

/** What a step says, as the browser names its controls. */
function useStepText(guide: BrowserGuide) {
    const t = useTranslations("account");
    const press = (chunks: ReactNode[]) => <Press key="press" text={chunks.join("")} />;
    return (kind: StepKind): ReactNode => {
        switch (kind) {
            case "download":
                return t.rich(guide.unpack ? "downloads.steps.downloadUnpack" : "downloads.steps.downloadZipped", {
                    press,
                    file: guide.file
                });
            case "open":
                return t("downloads.steps.openPage", { browser: guide.label });
            case "land":
                return t.rich("downloads.steps.landOn", { press, pane: guide.pageLabel });
            case "devMode":
                return t.rich("downloads.steps.developerMode", { press });
            case "load":
                return t.rich(guide.unpack ? "downloads.steps.pressFolder" : "downloads.steps.pressFile", {
                    press,
                    action: guide.action
                });
            case "private":
                return t.rich(
                    guide.id === "firefox"
                        ? "downloads.steps.allowPrivateFirefox"
                        : guide.privateInDetails
                          ? "downloads.steps.allowPrivate"
                          : "downloads.steps.allowPrivateCard",
                    { press, switch: guide.privateSwitch }
                );
            case "pin":
                return t.rich(guide.id === "firefox" ? "downloads.steps.pinFirefox" : "downloads.steps.pin", { press });
            case "point":
                return t("downloads.steps.pointIt");
        }
    };
}

/**
 * What is left once the extension is in, whichever way it got there: the store,
 * the command or the desktop app can install it, but none of them can let it
 * into private windows or put it on the toolbar - the browser keeps both for
 * the person at it.
 */
export function ExtensionFinishSteps({ browser }: { browser: BrowserId }) {
    const t = useTranslations("account");
    const guide = browserGuide(browser);
    const text = useStepText(guide);
    return (
        <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("downloads.steps.afterTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("downloads.steps.afterHint")}</p>
            <GuidedSteps key={browser} kinds={stepsFor(guide, true)} guide={guide} render={text} />
        </div>
    );
}

export function ExtensionSteps({
    initial,
    picker = true
}: {
    /** The browser whose row opened these steps; detected when left out. */
    initial?: BrowserId;
    /** False where the browser is picked above these steps already. */
    picker?: boolean;
} = {}) {
    const t = useTranslations("account");
    const [browser, setBrowser, detected] = useBrowserChoice(initial);
    const guide = browserGuide(browser);
    const text = useStepText(guide);

    return (
        <div className="flex flex-col gap-3">
            <div className={picker ? "flex flex-wrap items-end gap-2" : "hidden"}>
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                    {t("downloads.steps.yourBrowser")}
                    <Select
                        value={browser}
                        aria-label={t("downloads.steps.whichBrowser")}
                        onValueChange={(value) => setBrowser(value as BrowserId)}
                        options={BROWSER_GUIDES.map((entry) => ({
                            value: entry.id,
                            label: entry.label,
                            // Each browser's own mark, which is what somebody
                            // scanning the list looks for before its name.
                            icon: <BrowserMark browser={entry.label} />
                        }))}
                    />
                </label>
            </div>

            {/* Said once, where it changes what the reader should do next: there
                is no package for this browser, so the steps below are for one
                they would have to open instead. */}
            {detected === null ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    {t("downloads.steps.noBuild")}
                </p>
            ) : null}

            <GuidedSteps key={browser} kinds={stepsFor(guide)} guide={guide} render={text} />

            <p className="text-xs text-muted-foreground">
                {t(
                    guide.id === "firefox"
                        ? "downloads.steps.caveatFirefox"
                        : "downloads.steps.caveatChromium"
                )}
            </p>
        </div>
    );
}
