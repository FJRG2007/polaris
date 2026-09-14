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

import { Select } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import {
    BROWSER_GUIDES,
    browserGuide,
    detectBrowser,
    isBraveBrowser,
    type BrowserId
} from "@/lib/browser-guide";

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

export function ExtensionSteps() {
    // Detected in an effect, not during render: this is rendered on the server
    // too, where there is no navigator, and seeding from one would have the
    // browser hydrate something the HTML does not contain.
    const [browser, setBrowser] = useState<BrowserId>("chrome");
    const [detected, setDetected] = useState<BrowserId | null | undefined>(undefined);
    // A browser the reader picked outranks the one that was detected. They may
    // be following these steps for a different browser than the one they are
    // reading in, which is exactly what the picker is for.
    const picked = useRef(false);

    useEffect(() => {
        let alive = true;
        void (async () => {
            const found = detectBrowser(navigator.userAgent);
            // Brave answers as Chrome in the user agent, so the guess is put to
            // the browser itself before it is shown - see `isBraveBrowser`.
            const real = found === "chrome" && (await isBraveBrowser()) ? "brave" : found;
            if (!alive) return;
            setDetected(real);
            if (!picked.current && real) setBrowser(real);
        })();
        return () => {
            alive = false;
        };
    }, []);

    const guide = browserGuide(browser);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                    Your browser
                    <Select
                        value={browser}
                        aria-label="Which browser you are loading it into"
                        onValueChange={(value) => {
                            picked.current = true;
                            setBrowser(value as BrowserId);
                        }}
                        options={BROWSER_GUIDES.map((entry) => ({
                            value: entry.id,
                            label: entry.label
                        }))}
                    />
                </label>
            </div>

            {/* Said once, where it changes what the reader should do next: there
                is no package for this browser, so the steps below are for one
                they would have to open instead. */}
            {detected === null ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    There is no build for the browser you are reading this in. Pick the one you are
                    installing into.
                </p>
            ) : null}

            {/* Roomier than a list of one-liners would need, because these are
                not one-liners: each step is a sentence with an address or a
                control name inside it, and set tight they read as a wall the
                reader has to find their place in twice. */}
            <ol className="ml-5 flex list-decimal flex-col gap-5 text-sm leading-relaxed marker:text-muted-foreground">
                <li>
                    Download the <Press text={guide.file} /> file above.
                    {guide.unpack ? (
                        <> Unpack it - what gets loaded is the folder inside, not the .zip.</>
                    ) : (
                        <> Leave it zipped; Firefox takes the .zip as it is.</>
                    )}
                </li>
                <li>
                    Open the extensions page in {guide.label}. Copy this and paste it into the
                    address bar yourself - no page is allowed to open that address, which is why
                    there is no button here that does it for you.
                    <AddressToPaste text={guide.page} />
                </li>
                {guide.id === "firefox" ? (
                    <li>
                        You land on <Press text={guide.pageLabel} />, which is the pane that can
                        load one.
                    </li>
                ) : (
                    <li>
                        Turn on <Press text="Developer mode" />, top right. Without it the next
                        button is not there.
                    </li>
                )}
                <li>
                    Press <Press text={guide.action} /> and choose the{" "}
                    {guide.unpack ? "unpacked folder" : "file you downloaded"}.
                </li>
                <li>
                    Open the extension and point it at this Polaris. It asks for permission to talk
                    to this address and no other.
                </li>
            </ol>

            <p className="text-xs text-muted-foreground">{guide.caveat}</p>
        </div>
    );
}
