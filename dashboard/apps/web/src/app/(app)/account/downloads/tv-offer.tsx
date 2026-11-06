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
import { DownloadCard } from "@polaris/ui/download-card";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { desktopBridge, type DesktopTv, type DesktopTvState } from "@/lib/desktop-bridge";

type Reach = "browser" | "old-app" | "app";

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
    "install-interrupted"
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
function InstallSteps({ tv, onClose }: { tv: DesktopTv; onClose: () => void }) {
    const t = useTranslations("account");
    const [state, setState] = useState<DesktopTvState | null>(null);
    const [address, setAddress] = useState("");
    const [home, setHome] = useState(true);
    const [searched, setSearched] = useState(false);
    const [notStarted, setNotStarted] = useState(false);

    useEffect(() => {
        const stop = tv.onState(setState);
        void tv.state().then((first) => first && setState(first));
        return stop;
    }, [tv]);

    if (!state) return <TvLoader label={t("downloads.tv.dialog.connectingApp")} />;

    const idle = IDLE.has(state.phase);
    const searching = state.phase === "searching";
    const valid = validAddress(address);
    const addressError = address.trim() && !valid ? t("downloads.tv.dialog.addressInvalid") : null;
    const outcome = state.outcome && OUTCOMES.has(state.outcome) ? state.outcome : null;

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
                                setNotStarted(false);
                            }}
                            className="min-w-0 flex-1"
                        />
                        <Button
                            variant="secondary"
                            disabled={!idle}
                            onClick={() => {
                                setSearched(true);
                                void tv.find();
                            }}
                        >
                            {t("downloads.tv.dialog.find")}
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
                                    variant={host === address.trim() ? "primary" : "outline"}
                                    disabled={!idle}
                                    onClick={() => setAddress(host)}
                                >
                                    <Tv className="size-3.5 shrink-0" /> {host}
                                </Button>
                            ))}
                        </div>
                    ) : searched && idle ? (
                        <p className="text-xs text-muted-foreground">
                            {t("downloads.tv.dialog.noneFound")}
                        </p>
                    ) : null}
                </div>

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

                {STEPS.has(state.phase) ? (
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
                {!idle && !searching ? (
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
                <Button
                    disabled={!idle || !valid}
                    onClick={() => {
                        void tv
                            .start({ host: address.trim(), home })
                            .then((started) => setNotStarted(!started));
                    }}
                >
                    {t("downloads.tv.dialog.start")}
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

    useEffect(() => {
        setPhone(isPhone());
        return () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, []);

    const open = () => {
        // The app taking over blurs this window or hides this tab; a browser with
        // no handler for the link does neither.
        let left = false;
        const away = () => {
            left = true;
        };
        const hidden = () => document.visibilityState === "hidden" && away();
        window.addEventListener("blur", away, { once: true });
        document.addEventListener("visibilitychange", hidden);
        setStep("opening");
        const path = `/account/downloads?${OPEN_PARAM}=${OPEN_VALUE}`;
        window.location.href = `polaris://open?server=${encodeURIComponent(window.location.origin)}&path=${encodeURIComponent(path)}`;
        timer.current = window.setTimeout(() => {
            window.removeEventListener("blur", away);
            document.removeEventListener("visibilitychange", hidden);
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

export function TvOffer({ download }: { download: ReactNode }) {
    const t = useTranslations("account");
    const [reach, setReach] = useState<Reach>("browser");
    const [tv, setTv] = useState<DesktopTv | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const bridge = desktopBridge();
        const driven = bridge?.tv && typeof bridge.tv.start === "function" ? bridge.tv : null;
        if (bridge) setReach(driven ? "app" : "old-app");
        setTv(driven);
        // The desktop app's menu and its link land here asking for the dialog.
        const params = new URLSearchParams(window.location.search);
        if (params.get(OPEN_PARAM) === OPEN_VALUE) setOpen(true);
    }, []);

    // Closing stops a search; an install under way runs to its end in the app.
    const close = () => {
        void tv?.cancel();
        setOpen(false);
    };

    const press = () => {
        if (reach === "old-app") void desktopBridge()?.openTvInstall?.();
        else setOpen(true);
    };

    return (
        <DownloadCard
            id="tv"
            tint="sky"
            icon={<Tv className="size-4 shrink-0" />}
            title={t("downloads.tv.title")}
            description={t("downloads.tv.description")}
        >
            <div>
                <Button onClick={press}>{t("downloads.tv.install")}</Button>
            </div>
            {reach === "old-app" ? (
                <p className="text-sm text-muted-foreground">{t("downloads.tv.updateApp")}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("downloads.tv.supported")}</p>

            <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
                <DialogContent className="flex max-h-[85vh] max-w-md flex-col overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{t("downloads.tv.dialog.title")}</DialogTitle>
                        <DialogDescription>
                            {tv ? t("downloads.tv.dialog.intro") : t("downloads.tv.needsApp")}
                        </DialogDescription>
                    </DialogHeader>
                    {tv ? (
                        <InstallSteps tv={tv} onClose={close} />
                    ) : (
                        <OpenInApp download={download} onClose={() => setOpen(false)} />
                    )}
                </DialogContent>
            </Dialog>
        </DownloadCard>
    );
}
