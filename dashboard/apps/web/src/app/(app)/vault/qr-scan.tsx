"use client";

/**
 * Reading the QR a site shows when it turns on two-factor.
 *
 * That square is an `otpauth://` link, and typing the secret under it by hand is
 * thirty-two characters of base32 with no word breaks - which is why people take
 * a screenshot of it and then have nowhere to put the screenshot. So both ways
 * in are here: point the camera at the screen it is on, or hand over the picture
 * that was already taken.
 *
 * It happens entirely in this tab. The frames never leave the browser, the
 * picture is never uploaded, and what comes out goes straight into a field that
 * is encrypted before it is stored - which is the only way a scanner belongs in
 * a vault whose server is not supposed to be able to read anything.
 *
 * The camera needs a secure address, which is the one failure worth naming
 * rather than reporting as "could not start": a browser on plain http refuses it
 * and says nothing an operator could act on.
 */

import { useEffect, useRef, useState } from "react";
import { Camera, ImageUp, Loader2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";

/** How often a frame is read. Fast enough to feel immediate, slow enough that
 *  the decode is not competing with the camera for the same thread. */
const SCAN_INTERVAL_MS = 220;

/** A ceiling on the picture handed in. A QR is a few hundred pixels; anything
 *  larger is decoded from a scaled copy rather than at full size, because a
 *  12-megapixel photograph is a second of work per attempt. */
const MAX_SIDE = 1600;

export function QrScanDialog({
    open,
    onFound,
    onOpenChange
}: {
    open: boolean;
    /** What the code said, verbatim. The caller decides whether it is the kind
     *  of link it wanted. */
    onFound: (value: string) => void;
    onOpenChange: (open: boolean) => void;
}) {
    const video = useRef<HTMLVideoElement>(null);
    const file = useRef<HTMLInputElement>(null);
    const [scanning, setScanning] = useState(false);
    const [reading, setReading] = useState(false);
    const [error, setError] = useState("");

    // The camera runs only while it is asked for, and its track is stopped on the
    // way out - a stream left open keeps the recording light on.
    useEffect(() => {
        if (!open || !scanning) return;
        const element = video.current;
        if (!element) return;
        let stream: MediaStream | null = null;
        let timer = 0;
        let live = true;

        const start = async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "environment" }
                });
                if (!live) return;
                element.srcObject = stream;
                await element.play();
            } catch {
                if (!live) return;
                setScanning(false);
                setError(
                    "The camera is not available here. Browsers only allow it over a secure (https) address - upload a screenshot of the code instead."
                );
                return;
            }

            const { default: jsQR } = await import("jsqr");
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) return;

            timer = window.setInterval(() => {
                if (!element.videoWidth) return;
                canvas.width = element.videoWidth;
                canvas.height = element.videoHeight;
                context.drawImage(element, 0, 0, canvas.width, canvas.height);
                const frame = context.getImageData(0, 0, canvas.width, canvas.height);
                const found = jsQR(frame.data, frame.width, frame.height, {
                    inversionAttempts: "dontInvert"
                });
                if (!found?.data) return;
                window.clearInterval(timer);
                onFound(found.data);
                onOpenChange(false);
            }, SCAN_INTERVAL_MS);
        };

        void start();
        return () => {
            live = false;
            window.clearInterval(timer);
            for (const track of stream?.getTracks() ?? []) track.stop();
        };
        // `onFound` and `onOpenChange` are the caller's own closures and change
        // on its every render; restarting the camera for that would restart it
        // constantly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, scanning]);

    // Nothing is left running once the dialog is shut, including on the path
    // where it is dismissed rather than answered.
    useEffect(() => {
        if (!open) {
            setScanning(false);
            setError("");
        }
    }, [open]);

    const readPicture = async (picture: File) => {
        setReading(true);
        setError("");
        try {
            const bitmap = await createImageBitmap(picture);
            const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("no canvas");
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            const frame = context.getImageData(0, 0, canvas.width, canvas.height);
            const { default: jsQR } = await import("jsqr");
            // Both ways round here, unlike the camera: a screenshot may be of a
            // dark-mode page, where the code is light on dark and the ordinary
            // reading finds nothing.
            const found = jsQR(frame.data, frame.width, frame.height, {
                inversionAttempts: "attemptBoth"
            });
            if (!found?.data) {
                setError("No code was found in that picture. A tighter crop usually does it.");
                return;
            }
            onFound(found.data);
            onOpenChange(false);
        } catch {
            setError("That file could not be read as a picture.");
        } finally {
            setReading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Scan the code</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        Point the camera at the square the site is showing, or hand over a
                        screenshot of it. Neither leaves this browser.
                    </p>

                    {scanning ? (
                        <video
                            ref={video}
                            playsInline
                            muted
                            className="aspect-video w-full rounded-md border border-border bg-black object-cover"
                        />
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant={scanning ? "secondary" : "primary"}
                            onClick={() => setScanning((was) => !was)}
                        >
                            <Camera className="size-4 shrink-0" />
                            {scanning ? "Stop the camera" : "Use the camera"}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={reading}
                            onClick={() => file.current?.click()}
                        >
                            {reading ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" />
                            ) : (
                                <ImageUp className="size-4 shrink-0" />
                            )}
                            Upload a screenshot
                        </Button>
                    </div>

                    <input
                        ref={file}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            const picture = event.target.files?.[0];
                            // Cleared first, so choosing the same file twice
                            // after a failure still counts as a change.
                            event.target.value = "";
                            if (picture) void readPicture(picture);
                        }}
                    />
                </div>
            </DialogContent>
        </Dialog>
    );
}
