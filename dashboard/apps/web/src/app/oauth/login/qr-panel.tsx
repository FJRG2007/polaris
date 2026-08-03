"use client";

/**
 * The QR code beside the password form. Scanning it from a device that is
 * already signed in - and confirming there with the quick-unlock PIN - signs this
 * browser in without a password ever being typed on it.
 *
 * The code lives for a couple of minutes and is on display in whatever room the
 * screen is in, so it is deliberately short-lived and this panel asks for a new
 * one rather than quietly renewing it forever.
 *
 * Only opened on a screen wide enough to sit beside the form: a phone cannot
 * scan its own display, and opening a code nobody can use would be a row written
 * on every visit for nothing.
 */

import { QRCodeSVG } from "qrcode.react";
import { useRouter } from "next/navigation";
import { Button, Skeleton } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { postLoginTarget } from "./post-login-target";
import { pollQrSignIn, startQrSignIn } from "./actions";
import type { QrSignInCode } from "@/lib/qr-sign-in-service";

/** Where the two-column sign-in layout starts, matching the `sm:` breakpoint. */
const WIDE_ENOUGH = "(min-width: 640px)";

/** How the code reads under the QR: one group of four, then the rest. */
function grouped(userCode: string): string {
    return userCode.length > 4 ? `${userCode.slice(0, 4)}-${userCode.slice(4)}` : userCode;
}

/** True once the viewport is wide enough for the panel to be worth opening. */
function useWideScreen(): boolean {
    const [wide, setWide] = useState(false);
    useEffect(() => {
        const query = window.matchMedia(WIDE_ENOUGH);
        setWide(query.matches);
        const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
        query.addEventListener("change", onChange);
        return () => query.removeEventListener("change", onChange);
    }, []);
    return wide;
}

export function QrSignInPanel() {
    const router = useRouter();
    const wide = useWideScreen();
    const [code, setCode] = useState<QrSignInCode | null>(null);
    const [state, setState] = useState<"loading" | "waiting" | "expired" | "denied" | "error">("loading");
    const [error, setError] = useState<string | null>(null);
    // Opening a code writes a row, so a re-render must never open a second one.
    const opening = useRef(false);

    async function open() {
        if (opening.current) return;
        opening.current = true;
        setState("loading");
        setError(null);
        setCode(null);
        const result = await startQrSignIn();
        opening.current = false;
        if (!result.code) {
            setError(result.error ?? "The code could not be opened.");
            setState("error");
            return;
        }
        setCode(result.code);
        setState("waiting");
    }

    useEffect(() => {
        if (wide) void open();
        // Opening depends on nothing but the screen being wide enough; a code
        // already on screen is left alone.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wide]);

    // Ask whether the code has been answered until it is, or until it runs out.
    // The poll is what signs this browser in: the server sets the session cookies
    // on the reply that reports back approved, so all that is left is to navigate.
    useEffect(() => {
        if (state !== "waiting" || !code) return;
        let live = true;
        const timer = window.setInterval(async () => {
            const status = await pollQrSignIn(code.deviceCode);
            if (!live) return;
            if (status === "approved") {
                window.clearInterval(timer);
                router.push(postLoginTarget());
                router.refresh();
                return;
            }
            if (status === "denied" || status === "expired") {
                window.clearInterval(timer);
                setState(status);
            }
        }, code.pollMs + 500);
        return () => {
            live = false;
            window.clearInterval(timer);
        };
    }, [code, state, router]);

    // Hidden by CSS rather than left unrendered, so the two-column layout is the
    // same on the first frame as it is once the media query has been read.
    return (
        <div className="hidden flex-col items-center justify-center gap-3 border-l border-border pl-6 text-center sm:flex">
            <h2 className="text-sm font-medium">Sign in from your phone</h2>
            <div className="relative rounded-lg bg-white p-3">
                {code ? (
                    <QRCodeSVG value={code.url} size={148} bgColor="#ffffff" fgColor="#000000" />
                ) : (
                    <Skeleton className="size-[148px]" />
                )}
                {state === "expired" || state === "denied" ? (
                    <div className="absolute inset-0 grid place-items-center rounded-lg bg-background/90 p-2">
                        <div className="flex flex-col items-center gap-2">
                            <p className="text-xs text-muted-foreground">
                                {state === "denied" ? "That sign-in was refused." : "This code has expired."}
                            </p>
                            <Button size="sm" variant="outline" onClick={() => void open()}>
                                New code
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
            {state === "error" ? (
                <p className="text-xs text-danger">{error}</p>
            ) : (
                <>
                    <p className="max-w-[15rem] text-xs text-muted-foreground">
                        Open Polaris on a device you are already signed in on, scan this from Account &gt;
                        Scan a code, and confirm with your PIN.
                    </p>
                    {code ? (
                        <p className="font-mono text-sm tracking-widest">{grouped(code.userCode)}</p>
                    ) : null}
                </>
            )}
        </div>
    );
}
