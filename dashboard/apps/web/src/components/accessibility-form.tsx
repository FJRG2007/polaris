"use client";

/**
 * Accessibility: how big Polaris is drawn.
 *
 * One setting for now, in a card of its own rather than folded into the formats
 * form beside it - the two answer different questions, and this is the one
 * somebody comes looking for when a screen is hard to read.
 *
 * The size is applied to the document as the slider moves, so the answer to
 * "what does 20 look like" is the page you are already reading rather than a
 * sample line. Saving only makes it stick; sliding away and back without saving
 * leaves the page as it was found.
 */

import { useEffect, useRef, useState } from "react";
import { runAction } from "@/lib/run-action";
import { TEXT_SIZES, type TextSize } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, cn } from "@polaris/ui";

/** The custom property the whole interface is laid out against - see globals.css. */
const PROPERTY = "--app-text-size";

function applySize(size: number): void {
    document.documentElement.style.setProperty(PROPERTY, `${size}px`);
}

export function AccessibilityForm({
    initial,
    standard,
    save
}: {
    /** The size in force for this account, already resolved through the platform
     *  default, so the slider opens where the page is actually drawn. */
    initial: TextSize;
    /**
     * What this deployment treats as normal - what an account that has never
     * touched this setting is drawn at.
     *
     * Named because somebody who has moved the slider around cannot get back
     * without it. Seven numbers on a scale say nothing about which one they
     * started from, and 16 is a guess unless the operator happens not to have
     * changed it. It is marked on the scale and offered as a way back.
     */
    standard: TextSize;
    save: (size: number) => Promise<{ error?: string }>;
}) {
    const [size, setSize] = useState<TextSize>(initial);
    const [saved, setSaved] = useState<TextSize>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);

    // What the page was drawn at on arrival, so leaving without saving puts it
    // back. Read once: after the first render `size` is what is on the document,
    // and reading it again would record the preview as the starting point.
    const opened = useRef<TextSize>(initial);

    useEffect(() => {
        applySize(size);
    }, [size]);

    useEffect(() => {
        const wasOpenedAt = opened.current;
        return () => applySize(wasOpenedAt);
    }, []);

    const index = TEXT_SIZES.indexOf(size);
    const changed = size !== saved;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Accessibility</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between gap-2">
                        <label htmlFor="text-size" className="text-sm font-medium">
                            Text size
                        </label>
                        <span className="text-sm tabular-nums text-muted-foreground">
                            {size}px
                            {size === standard ? (
                                <span className="pl-1.5 text-xs">Default</span>
                            ) : null}
                        </span>
                    </div>
                    {/* An index rather than the size itself: the sizes are not evenly
                        spaced, and a range that stepped in pixels would offer the
                        thirteen sizes in between that nobody has looked at. */}
                    <input
                        id="text-size"
                        type="range"
                        min={0}
                        max={TEXT_SIZES.length - 1}
                        step={1}
                        value={index < 0 ? TEXT_SIZES.indexOf(16 as TextSize) : index}
                        onChange={(event) => {
                            setDone(false);
                            const next = TEXT_SIZES[Number(event.target.value)];
                            if (next !== undefined) setSize(next);
                        }}
                        aria-valuetext={`${size} pixels`}
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    />
                    <div className="flex justify-between text-[0.6875rem] tabular-nums text-muted-foreground">
                        {TEXT_SIZES.map((step) => (
                            <button
                                key={step}
                                type="button"
                                aria-label={`${step} pixels`}
                                aria-pressed={step === size}
                                onClick={() => {
                                    setDone(false);
                                    setSize(step);
                                }}
                                // The one to come back to is marked on the scale
                                // itself, so it is visible while the slider is
                                // being moved rather than only after it lands.
                                title={step === standard ? `${step} - the default here` : undefined}
                                className={cn(
                                    step === size
                                        ? "font-medium text-foreground"
                                        : "hover:text-foreground",
                                    step === standard &&
                                        step !== size &&
                                        "underline decoration-dotted underline-offset-4"
                                )}
                            >
                                {step}
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Polaris is laid out in this size, so the rows and panels around the text grow with it.
                        The page changes as you move the slider; it stays that way once you save.{" "}
                        {size === standard ? (
                            <>This is the default here.</>
                        ) : (
                            <>
                                The default here is {standard}px.{" "}
                                {/* A way back rather than a number to remember.
                                    Sets the slider like any other step, so it is
                                    still a change somebody saves rather than one
                                    that happens to them. */}
                                <button
                                    type="button"
                                    onClick={() => {
                                        setDone(false);
                                        setSize(standard);
                                    }}
                                    className="underline underline-offset-2 hover:text-foreground"
                                >
                                    Go back to it
                                </button>
                            </>
                        )}
                    </p>
                </div>

                <div className="flex items-center justify-between gap-2">
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    {done && !error ? <p className="text-sm text-success">Text size saved.</p> : null}
                    <Button
                        type="button"
                        className="ml-auto"
                        disabled={busy || !changed}
                        onClick={async () => {
                            setBusy(true);
                            setError("");
                            setDone(false);
                            const result = await runAction(() => save(size), setError);
                            setBusy(false);
                            if (!result || result.error) {
                                if (result?.error) setError(result.error);
                                return;
                            }
                            // Saved is the new starting point, so leaving the page
                            // no longer puts the old size back.
                            opened.current = size;
                            setSaved(size);
                            setDone(true);
                        }}
                    >
                        {busy ? "Saving..." : "Save"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
