"use client";

/**
 * The TV card of Downloads, and the dialog that puts Polaris TV on a set.
 *
 * Putting an app on a TV takes a computer on the same network, so the install
 * itself is the desktop app's: inside it, this dialog drives the app's search
 * and install and reports each step as it happens. In a browser the dialog
 * opens the desktop app on this page through its `polaris://` link (which only
 * names a page), and when nothing answers it offers the download for this
 * computer - or says plainly that a phone cannot do it. An app older than the
 * dialog has only the window it used to open, and is told to update.
 *
 * The dialog opens on the compatibility checker: a TV that can take Polaris
 * TV (the Home screen and App tiers) gets the install, and any other is sent
 * to the guide that still helps it. A dialog opened by the desktop app's link
 * skips the check, since it was answered in the browser before.
 *
 * Until a TV release carrying the APK exists on GitHub, the card says so and
 * offers no install, the same as every other card on Downloads.
 */

import { Tv } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";
import { TvChecker } from "@polaris/ui/tv-checker";
import { debuggingById, debuggingFor, type TvPlatform } from "@polaris/core/tv-compat";
import { DownloadCard } from "@polaris/ui/download-card";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { desktopBridge, type DesktopTv, type DesktopTvState } from "@/lib/desktop-bridge";
import { TvWaitingNote } from "./tv-waiting";

type Reach = "browser" | "old-app" | "app";
/** The dialog's two steps: whether the TV can take Polaris TV, then the install. */
type Step = "check" | "install";

/** The query that opens the dialog, which the desktop app's menu and its link use. */
const OPEN_PARAM = "tv";
const OPEN_VALUE = "install";
/** How long the desktop app has to take the window's focus before it counts as absent. */
const OPEN_WAIT_MS = 2_500;
/** A private IPv4 address, the only kind the app installs to; it checks again. */
const PRIVATE_IPV4 = /^(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

const IDLE = new Set<DesktopTvState["phase"]>(["ready", "done", "failed"]);
const STEPS = new Set([
    "searching",
    "connecting",
    "allow",
    "checking",
    "backup",
    "download",
    "install",
    "home",
    "closing"
]);
const OUTCOMES = new Set([
    "installed",
    "installed-home",
    "installed-home-refused",
    "installed-home-unknown",
    "adb-off",
    "not-allowed",
    "unreachable",
    "not-android-tv",
    "too-old",
    "not-released",
    "download-failed",
    "key-failed",
    "connection-lost",
    "backup-failed",
    "sideload-refused",
    "install-failed",
    "install-interrupted",
    "usb-busy",
    "usb-gone",
    "needs-pairing",
    "pairing-refused"
]);

function validAddress(value: string): boolean {
    const address = value.trim();
    return PRIVATE_IPV4.test(address) && address.split(".").every((part) => Number(part) <= 255);
}

function isPhone(): boolean {
    return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

/** A TV with the signal going out from it: what the app is doing while it waits. */
function TvLoader({ label }: { label: string }) {
    return (
        <div role="status" className="flex min-w-0 items-center gap-3">
            <span className="relative flex size-9 shrink-0 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-sky-500/25 motion-reduce:animate-none" />
                <span className="absolute inset-1 animate-pulse rounded-full bg-sky-500/15 motion-reduce:animate-none" />
                <Tv className="relative size-4 shrink-0 text-sky-600 dark:text-sky-400" />
            </span>
            <p className="min-w-0 text-sm text-muted-foreground">{label}</p>
        </div>
    );
}

/** The install, driven through the desktop app this page is open in. */
function InstallSteps({
    tv,
    platform,
    onClose
}: {
    tv: DesktopTv;
    /** The TV's platform as the checker answered it, so its menus show before Install; null when skipped. */
    platform: TvPlatform | null;
    onClose: () => void;
}) {
    const t = useTranslations("account");
    const locale = useLocale();
    const [state, setState] = useState<DesktopTvState | null>(null);
    const [address, setAddress] = useState("");
    const [home, setHome] = useState(true);
    const [searched, setSearched] = useState(false);
    const [usbId, setUsbId] = useState<string | null>(null);
    const [notStarted, setNotStarted] = useState(false);
    const [refused, setRefused] = useState(false);
    /** The address whose TV asked for a Wireless debugging pairing code. */
    const [codeFor, setCodeFor] = useState<string | null>(null);
    const [code, setCode] = useState("");
    const typed = useRef(address);
    const arrived = state?.outcome ?? null;

    useEffect(() => {
        typed.current = address;
    }, [address]);
    // Once per outcome as it arrives, so typing a new code afterwards is never undone.
    useEffect(() => {
        if (arrived === "needs-pairing" || arrived === "pairing-refused") setCodeFor(typed.current.trim());
        if (arrived === "pairing-refused") setCode("");
    }, [arrived]);

    useEffect(() => {
        const stop = tv.onState(setState);
        // Null is the app declining this page, which no update of the page fixes.
        void tv.state().then(
            (first) => (first ? setState(first) : setRefused(true)),
            () => setRefused(true)
        );
        return stop;
    }, [tv]);

    if (!state && refused) {
        return (
            <>
                <p role="alert" className="text-sm text-destructive">
                    {t("downloads.tv.dialog.refused")}
                </p>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("downloads.tv.dialog.close")}
                    </Button>
                </DialogFooter>
            </>
        );
    }
    if (!state) return <TvLoader label={t("downloads.tv.dialog.connectingApp")} />;

    const usbListing = state.usbListing === true;
    const idle = IDLE.has(state.phase) && !usbListing;
    const searching = state.phase === "searching";
    const valid = validAddress(address);
    const addressError = address.trim() && !valid ? t("downloads.tv.dialog.addressInvalid") : null;
    const outcome = state.outcome && OUTCOMES.has(state.outcome) ? state.outcome : null;
    // Only an app that installs over USB sends the field and answers findUsb.
    const findUsb = Array.isArray(state.usb) || state.usb === null ? tv.findUsb : undefined;
    const usbListed = state.usb ?? [];
    // The app names the TV it found; before that, the platform the checker answered.
    const waiting = state.waiting ?? null;
    const menus = platform ? debuggingFor(platform, locale) : undefined;
    const showBefore = !waiting && idle && menus && (!outcome || outcome === "adb-off");
    const usbPicked = usbListed.some((one) => one.id === usbId)
        ? usbId
        : usbListed.length === 1 && !address.trim()
          ? (usbListed[0]?.id ?? null)
          : null;
    const asksCode = !usbPicked && codeFor !== null && codeFor === address.trim();
    const codeReady = !asksCode || /^\d{6}$/.test(code);

    return (
        <>
            <div className="flex min-w-0 flex-col gap-4">
                <div className="flex min-w-0 flex-col gap-1.5">
                    <label htmlFor="tv-address" className="text-sm font-medium">
                        {t("downloads.tv.dialog.address")}
                    </label>
                    <div className="flex min-w-0 gap-2">
                        <Input
                            id="tv-address"
                            inputMode="decimal"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="192.168.1.50"
                            value={address}
                            disabled={!idle}
                            aria-invalid={addressError ? true : undefined}
                            onChange={(event) => {
                                setAddress(event.target.value);
                                setUsbId(null);
                                setNotStarted(false);
                            }}
                            className="min-w-0 flex-1"
                        />
                        <Button
                            variant="secondary"
                            disabled={!idle && !searching}
                            onClick={() => {
                                if (searching) {
                                    void tv.cancel();
                                    return;
                                }
                                setSearched(true);
                                void tv.find();
                            }}
                        >
                            {searching
                                ? t("downloads.tv.dialog.stopSearch")
                                : t("downloads.tv.dialog.find")}
                        </Button>
                    </div>
                    {addressError || notStarted ? (
                        <p role="alert" className="text-xs text-destructive">
                            {addressError ?? t("downloads.tv.dialog.notStarted")}
                        </p>
                    ) : null}
                    {state.found.length > 0 ? (
                        <div className="flex min-w-0 flex-wrap gap-2">
                            {state.found.map((host) => (
                                <Button
                                    key={host}
                                    size="sm"
                                    title={host}
                                    className="min-w-0 max-w-full"
                                    variant={host === address.trim() ? "primary" : "outline"}
                                    disabled={!idle}
                                    onClick={() => {
                                        setAddress(host);
                                        setUsbId(null);
                                    }}
                                >
                                    <Tv className="size-3.5 shrink-0" />
                                    <span className="truncate">
                                        {state.named?.[host]
                                            ? `${state.named[host]} - ${host}`
                                            : host}
                                    </span>
                                </Button>
                            ))}
                        </div>
                    ) : searched && idle ? (
                        <p className="text-xs text-muted-foreground">
                            {t("downloads.tv.dialog.noneFound")}
                        </p>
                    ) : null}
                </div>

                {findUsb ? (
                    <div className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-sm font-medium">{t("downloads.tv.dialog.usb")}</span>
                        <p className="text-xs text-muted-foreground">
                            {t("downloads.tv.dialog.usbHint")}
                        </p>
                        <div className="flex min-w-0 flex-wrap gap-2">
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={!idle}
                                onClick={() => void findUsb.call(tv)}
                            >
                                {t("downloads.tv.dialog.usbFind")}
                            </Button>
                            {usbListed.map((device) => (
                                <Button
                                    key={device.id}
                                    size="sm"
                                    variant={device.id === usbPicked ? "primary" : "outline"}
                                    disabled={!idle}
                                    title={device.id}
                                    className="min-w-0 max-w-full"
                                    onClick={() => {
                                        setUsbId(device.id);
                                        setAddress("");
                                        setNotStarted(false);
                                    }}
                                >
                                    <Tv className="size-3.5 shrink-0" />
                                    <span className="truncate">{device.name}</span>
                                </Button>
                            ))}
                        </div>
                        {state.usb && state.usb.length === 0 && idle ? (
                            <p className="text-xs text-muted-foreground">
                                {t("downloads.tv.dialog.usbNone")}
                            </p>
                        ) : null}
                    </div>
                ) : null}

                <label className="flex min-w-0 items-start gap-2 text-sm">
                    <Checkbox
                        checked={home}
                        disabled={!idle}
                        onChange={(event) => setHome(event.target.checked)}
                        className="mt-0.5"
                    />
                    <span className="min-w-0">{t("downloads.tv.dialog.makeHome")}</span>
                </label>
                <p className="text-xs text-muted-foreground">
                    {t("downloads.tv.dialog.backupNote")}
                </p>

                {usbListing ? (
                    <TvLoader label={t("downloads.tv.dialog.steps.usbListing")} />
                ) : waiting ? (
                    <>
                        <TvLoader label={t("downloads.tv.dialog.waiting.loader")} />
                        <TvWaitingNote
                            menus={(waiting.steps ? debuggingById(waiting.steps, locale) : undefined) ?? waiting}
                            step={waiting.step}
                            waiting
                        />
                    </>
                ) : STEPS.has(state.phase) ? (
                    <TvLoader label={t(`downloads.tv.dialog.steps.${state.phase}` as never)} />
                ) : null}
                {outcome ? (
                    <p
                        role="status"
                        className={cn(
                            "text-sm",
                            state.phase === "done" ? "text-foreground" : "text-destructive"
                        )}
                    >
                        {t(`downloads.tv.dialog.outcomes.${outcome}` as never)}
                    </p>
                ) : null}
                {asksCode ? (
                    <div className="flex min-w-0 flex-col gap-1.5">
                        <label htmlFor="tv-code" className="text-sm font-medium">
                            {t("downloads.tv.dialog.code")}
                        </label>
                        <Input
                            id="tv-code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            spellCheck={false}
                            maxLength={6}
                            placeholder="123456"
                            value={code}
                            disabled={!idle}
                            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                            className="w-32 tabular-nums"
                        />
                    </div>
                ) : null}
                {showBefore ? (
                    <TvWaitingNote menus={menus} step="debugging" waiting={false} />
                ) : null}
                {state.closed !== null ? (
                    <p className="text-xs text-muted-foreground">
                        {state.closed
                            ? t("downloads.tv.dialog.debugClosed")
                            : t("downloads.tv.dialog.debugOpen")}
                    </p>
                ) : null}
                {state.backup ? (
                    <p className="text-xs break-all text-muted-foreground">
                        {t("downloads.tv.dialog.backupKept", { path: state.backup })}
                    </p>
                ) : null}
                {!idle && !searching && !waiting ? (
                    <p className="text-xs text-muted-foreground">
                        {t("downloads.tv.dialog.keepsGoing")}
                    </p>
                ) : null}
            </div>
            <DialogFooter>
                <Button variant="ghost" onClick={onClose}>
                    {idle || searching
                        ? t("downloads.tv.dialog.cancel")
                        : t("downloads.tv.dialog.close")}
                </Button>
                {waiting ? (
                    <Button variant="outline" onClick={() => void tv.cancel()}>
                        {t("downloads.tv.dialog.waiting.stop")}
                    </Button>
                ) : null}
                <Button
                    disabled={!idle || (!valid && !usbPicked) || !codeReady}
                    onClick={() => {
                        void tv
                            .start(
                                usbPicked
                                    ? { usb: usbPicked, home }
                                    : { host: address.trim(), home, ...(asksCode ? { code } : {}) }
                            )
                            .then((started) => setNotStarted(!started));
                    }}
                >
                    {asksCode ? t("downloads.tv.dialog.pairStart") : t("downloads.tv.dialog.start")}
                </Button>
            </DialogFooter>
        </>
    );
}

/** In a browser: open the desktop app on this page, and what to do when it is not there. */
function OpenInApp({ download, onClose }: { download: ReactNode; onClose: () => void }) {
    const t = useTranslations("account");
    const [step, setStep] = useState<"idle" | "opening" | "opened" | "missing">("idle");
    const [phone, setPhone] = useState(false);
    const timer = useRef<number | null>(null);
    const detach = useRef<(() => void) | null>(null);

    useEffect(() => {
        setPhone(isPhone());
        return () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
            detach.current?.();
        };
    }, []);

    const open = () => {
        // The app taking over blurs this window or hides this tab; a browser with
        // no handler for the link does neither.
        if (timer.current !== null) window.clearTimeout(timer.current);
        detach.current?.();
        let left = false;
        let waited = false;
        function stop() {
            window.removeEventListener("blur", away);
            document.removeEventListener("visibilitychange", hidden);
            if (detach.current === stop) detach.current = null;
        }
        function away() {
            left = true;
            if (!waited) return;
            stop();
            setStep("opened");
        }
        function hidden() {
            if (document.visibilityState === "hidden") away();
        }
        window.addEventListener("blur", away);
        document.addEventListener("visibilitychange", hidden);
        detach.current = stop;
        setStep("opening");
        const path = `/account/downloads?${OPEN_PARAM}=${OPEN_VALUE}`;
        window.location.href = `polaris://open?server=${encodeURIComponent(window.location.origin)}&path=${encodeURIComponent(path)}`;
        timer.current = window.setTimeout(() => {
            timer.current = null;
            waited = true;
            if (left) stop();
            setStep(left ? "opened" : "missing");
        }, OPEN_WAIT_MS);
    };

    if (phone) {
        return (
            <>
                <p className="text-sm text-muted-foreground">{t("downloads.tv.dialog.phone")}</p>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("downloads.tv.dialog.close")}
                    </Button>
                </DialogFooter>
            </>
        );
    }

    return (
        <>
            <div className="flex min-w-0 flex-col gap-3">
                {step === "opening" ? <TvLoader label={t("downloads.tv.dialog.opening")} /> : null}
                {step === "opened" ? (
                    <p role="status" className="text-sm">
                        {t("downloads.tv.dialog.opened")}
                    </p>
                ) : null}
                {step === "missing" ? (
                    <div className="flex min-w-0 flex-col gap-2">
                        <p role="status" className="text-sm">
                            {t("downloads.tv.dialog.notOpened")}
                        </p>
                        {download}
                    </div>
                ) : null}
            </div>
            <DialogFooter>
                <Button variant="ghost" onClick={onClose}>
                    {t("downloads.tv.dialog.cancel")}
                </Button>
                <Button disabled={step === "opening"} onClick={open}>
                    {t("downloads.tv.openApp")}
                </Button>
            </DialogFooter>
        </>
    );
}

export function TvOffer({
    download,
    released
}: {
    download: ReactNode;
    /** Whether a TV release with the APK is out; the card draws before it settles. */
    released: Promise<boolean>;
}) {
    const t = useTranslations("account");
    const compat = useTranslations("tvCompat");
    // Null while GitHub has not answered: the desktop app checks again anyway.
    const [available, setAvailable] = useState<boolean | null>(null);
    const [reach, setReach] = useState<Reach>("browser");
    const [tv, setTv] = useState<DesktopTv | null>(null);
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<Step>("check");
    const [platform, setPlatform] = useState<TvPlatform | null>(null);

    useEffect(() => {
        const bridge = desktopBridge();
        const driven = bridge?.tv && typeof bridge.tv.start === "function" ? bridge.tv : null;
        if (bridge) setReach(driven ? "app" : "old-app");
        setTv(driven);
        // The desktop app's menu and its link land here asking for the dialog.
        const params = new URLSearchParams(window.location.search);
        if (params.get(OPEN_PARAM) === OPEN_VALUE) {
            setStep("install");
            setOpen(true);
        }
    }, []);

    useEffect(() => {
        let live = true;
        released.then(
            (out) => live && setAvailable(out),
            () => live && setAvailable(null)
        );
        return () => {
            live = false;
        };
    }, [released]);

    // Closing stops a search; an install under way runs to its end in the app.
    const close = () => {
        void tv?.cancel();
        setOpen(false);
    };

    const press = () => {
        if (reach === "old-app") void desktopBridge()?.openTvInstall?.();
        else {
            setStep("check");
            setOpen(true);
        }
    };

    return (
        <DownloadCard
            id="tv"
            tint="sky"
            icon={<Tv className="size-4 shrink-0" />}
            title={t("downloads.tv.title")}
            description={t("downloads.tv.description")}
        >
            {available === false ? (
                <p className="text-sm text-muted-foreground">{t("downloads.tv.notReleased")}</p>
            ) : (
                <div>
                    <Button onClick={press}>{t("downloads.tv.install")}</Button>
                </div>
            )}
            {reach === "old-app" ? (
                <p className="text-sm text-muted-foreground">{t("downloads.tv.updateApp")}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("downloads.tv.supported")}</p>

            <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
                <DialogContent
                    className={cn(
                        "flex max-h-[85vh] flex-col overflow-y-auto overscroll-contain",
                        step === "check" ? "max-w-2xl" : "max-w-md"
                    )}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {step === "check" ? compat("title") : t("downloads.tv.dialog.title")}
                        </DialogTitle>
                        <DialogDescription>
                            {step === "check"
                                ? compat("intro")
                                : available === false
                                  ? t("downloads.tv.notReleased")
                                  : tv
                                    ? t("downloads.tv.dialog.intro")
                                    : t("downloads.tv.needsApp")}
                        </DialogDescription>
                    </DialogHeader>
                    {step === "check" ? (
                        <>
                            <TvChecker
                                heading={false}
                                action={(tier, answered) =>
                                    tier === "network" ? null : (
                                        <Button
                                            size="sm"
                                            onClick={() => {
                                                setPlatform(answered);
                                                setStep("install");
                                            }}
                                        >
                                            {compat("install")}
                                        </Button>
                                    )
                                }
                            />
                            <DialogFooter>
                                <Button variant="ghost" onClick={close}>
                                    {t("downloads.tv.dialog.cancel")}
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        setPlatform(null);
                                        setStep("install");
                                    }}
                                >
                                    {compat("skip")}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : available === false ? (
                        <DialogFooter>
                            <Button variant="ghost" onClick={close}>
                                {t("downloads.tv.dialog.close")}
                            </Button>
                        </DialogFooter>
                    ) : tv ? (
                        <InstallSteps tv={tv} platform={platform} onClose={close} />
                    ) : (
                        <OpenInApp download={download} onClose={() => setOpen(false)} />
                    )}
                </DialogContent>
            </Dialog>
        </DownloadCard>
    );
}
