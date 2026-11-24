"use client";

/**
 * One category of the desktop or phone app's own settings, drawn from the shared schema
 * (`@polaris/core/app-settings`) and read and written through the app's bridge.
 *
 * Every read is local - the app answers over IPC, no network - and the last
 * answer is kept for the session, so moving between categories draws at once
 * and only swaps a value that changed. A change shows immediately and is put
 * back when the app refuses it. The app says when a value changed anywhere
 * else (its tray, its own page, another window), and the page reads again then
 * and whenever it comes back into view.
 *
 * The phone app lists fewer categories (`APP_PHONE_CATEGORIES`) and keeps no
 * values the page changes: its General category opens a screen of the app or
 * of the phone per row, and its servers are changed on its own screen.
 */

import Link from "next/link";
import { Check } from "lucide-react";
import * as core from "@polaris/core/app-settings";
import { useDesktopBridge, usePhoneAppSettings } from "@/components/desktop-app";
import { HostsManager } from "@/components/this-app/hosts-manager";
import { phoneAppSettings, phoneHosts, type PhoneAppSettings } from "@/lib/mobile-bridge";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useNetworkState } from "@enigmax/primitives/react/network";
import { readDesktopUpdateCheck, type DesktopUpdateCheck, type PolarisDesktop } from "@/lib/desktop-bridge";
import { MaxUsersRow, OverlayGames, ResetOverlay, VoiceWidgetPreview } from "./voice-widget-preview";
import { Button, buttonVariants, Card, CardBody, ConfirmDeleteDialog, Select, Skeleton, Switch, useToast } from "@polaris/ui";

/** The last snapshot the app gave, so a category opened next draws without waiting. */
let lastSnapshot: core.AppSettingsSnapshot | null = null;

/** Only for tests: forget the kept snapshot. */
export function forgetAppSettingsSnapshot(): void {
    lastSnapshot = null;
}

const MODIFIER_KEYS = ["Control", "Alt", "Shift", "Meta"];

/** Whether a setting is listed: every switch it sits under, all the way up, is on. */
export function settingShown(entry: core.AppSettingEntry, snapshot: core.AppSettingsSnapshot): boolean {
    let parent = entry.dependsOn;
    for (let depth = 0; parent && depth < 8; depth++) {
        if (snapshot[parent as core.AppSettingKey] !== true) return false;
        parent = (core.APP_SETTINGS as readonly core.AppSettingEntry[]).find((item) => item.key === parent)?.dependsOn;
    }
    return true;
}

/** The line under the category's title: the phone app's own when the page runs in it. */
export function AppSettingsIntro({ category }: { category: core.AppSettingCategory }) {
    const t = useTranslations("appSettings");
    // Both asked on every render: a hook behind `&&` runs only sometimes.
    const phoneApp = usePhoneAppSettings();
    const bridge = useDesktopBridge();
    const phone = phoneApp && !bridge?.appSettings;
    return (
        <p className="text-sm text-muted-foreground">
            {phone && core.phoneHasCategory(category)
                ? t(`phone.intros.${category}`)
                : t(`categories.${category}.intro`)}
        </p>
    );
}

export function AppSettingsView({ category }: { category: core.AppSettingCategory }) {
    const bridge = useDesktopBridge();
    const phone = usePhoneAppSettings();
    const t = useTranslations("appSettings");
    if (!bridge?.appSettings && phone) {
        // A phone app that manages its hosts here draws them as the desktop app's.
        const hosts = category === "hosts" ? phoneHosts() : null;
        if (hosts) return <HostsManager hosts={hosts} />;
        const settings = phoneAppSettings();
        if (settings) return <InPhone settings={settings} category={category} />;
    }
    if (!bridge?.appSettings) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("notInApp.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("notInApp.body")}</p>
                    </div>
                    <Link href="/account/downloads" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                        {t("notInApp.download")}
                    </Link>
                </CardBody>
            </Card>
        );
    }
    // An app that manages its hosts here draws them from its own list, at once.
    if (category === "hosts" && bridge.appSettings.hosts) return <HostsManager hosts={bridge.appSettings.hosts} />;
    return <InApp bridge={bridge} settings={bridge.appSettings} category={category} />;
}

function InApp({
    bridge,
    settings,
    category
}: {
    bridge: PolarisDesktop;
    settings: NonNullable<PolarisDesktop["appSettings"]>;
    category: core.AppSettingCategory;
}) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const [snapshot, setSnapshot] = useState<core.AppSettingsSnapshot | null>(lastSnapshot);
    const [unavailable, setUnavailable] = useState(false);

    const keep = useCallback((next: core.AppSettingsSnapshot) => {
        lastSnapshot = next;
        setSnapshot(next);
    }, []);

    const refresh = useCallback(async () => {
        const next = core.readAppSettings(await settings.get().catch(() => null));
        if (next) {
            keep(next);
            setUnavailable(false);
        } else if (!lastSnapshot) setUnavailable(true);
    }, [settings, keep]);

    useEffect(() => {
        void refresh();
        const stop = settings.onChange(() => void refresh());
        const visible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        const focused = () => void refresh();
        window.addEventListener("focus", focused);
        document.addEventListener("visibilitychange", visible);
        return () => {
            stop();
            window.removeEventListener("focus", focused);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [settings, refresh]);

    /** Show the change now, and put the value back when the app refuses it. */
    const change = useCallback(
        (next: core.AppSettingChange) => {
            const before = lastSnapshot;
            if (!before || before[next.key] === next.value) return;
            keep({ ...before, [next.key]: next.value });
            void settings
                .set(next)
                .catch(() => null)
                .then((answer) => {
                    const after = core.readAppSettings(answer);
                    if (after) return keep(after);
                    keep(before);
                    toast.show({ title: t("saveFailed") });
                });
        },
        [settings, keep, toast, t]
    );

    if (!snapshot) {
        if (unavailable) {
            return (
                <Card>
                    <CardBody className="flex flex-col items-start gap-3">
                        <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
                        <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                            {t("retry")}
                        </Button>
                    </CardBody>
                </Card>
            );
        }
        return (
            <Card>
                <CardBody className="flex flex-col gap-4" aria-busy="true">
                    {core.appSettingsIn(category).map((entry) => (
                        <Skeleton key={entry.key} className="h-9 w-full" />
                    ))}
                    {core.appSettingsIn(category).length === 0 && <Skeleton className="h-9 w-full" />}
                </CardBody>
            </Card>
        );
    }

    const entries = core
        .appSettingsIn(category)
        .filter((entry) => core.appSettingOffered(entry, snapshot.features) && settingShown(entry, snapshot));

    return (
        <div className="flex flex-col gap-4">
            {category === "voice" && snapshot.voiceWidget && <VoiceWidgetPreview snapshot={snapshot} />}
            {entries.length > 0 && (
                <Card>
                    <CardBody className="flex flex-col gap-4">
                        {entries.map((entry) => (
                            <SettingRow
                                key={entry.key}
                                entry={entry}
                                snapshot={snapshot}
                                settings={settings}
                                onChange={change}
                                onSnapshot={keep}
                            />
                        ))}
                    </CardBody>
                </Card>
            )}
            {category === "voice" && snapshot.voiceWidget && (
                <OverlayGames snapshot={snapshot} settings={settings} onSnapshot={keep} />
            )}
            {category === "voice" && <ResetOverlay settings={settings} onSnapshot={keep} />}
            {category === "clipboard" && <ClearClipboard settings={settings} />}
            {category === "advanced" && snapshot.restartPending && (
                <Card>
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                        <p className="min-w-0 text-sm text-muted-foreground">{t("restart.pending")}</p>
                        <Button size="sm" onClick={() => void settings.relaunch()}>
                            {t("restart.now")}
                        </Button>
                    </CardBody>
                </Card>
            )}
            {category === "hosts" && (
                <Hosts
                    servers={snapshot.servers}
                    server={snapshot.server}
                    hint={t("hosts.manageHint")}
                    onManage={() => void settings.manageHosts()}
                />
            )}
            {category === "updates" && <Updates bridge={bridge} version={snapshot.version} />}
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm">{label}</span>
                {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">{children}</div>
        </div>
    );
}

function SettingRow({
    entry,
    snapshot,
    settings,
    onChange,
    onSnapshot
}: {
    entry: core.AppSettingEntry;
    snapshot: core.AppSettingsSnapshot;
    settings: NonNullable<PolarisDesktop["appSettings"]>;
    onChange: (change: core.AppSettingChange) => void;
    onSnapshot: (next: core.AppSettingsSnapshot) => void;
}) {
    const t = useTranslations("appSettings");
    const key = entry.key as core.AppSettingKey;
    const label =
        key === "launcher" ? t("items.launcher.label", { key: snapshot.launcherKey }) : t(`items.${key}.label`);
    let hint: string = t(`items.${key}.hint`);
    if (key === "launcherClipboard" && !snapshot.launcherClipboardPersists) hint = t("clipboard.memoryOnly");

    if (entry.kind === "shortcut" && key === "overlayLockBinding") {
        const setOverlayShortcut = settings.setOverlayShortcut;
        if (!setOverlayShortcut) return null;
        return (
            <ShortcutRow
                label={label}
                hint={hint}
                shown={snapshot.overlayLockKey ?? ""}
                problem={snapshot.overlayLockProblem === "taken" ? t("shortcut.taken") : null}
                settings={settings}
                onPress={(press) => setOverlayShortcut(press)}
                onDefault={snapshot.overlayLockBinding ? () => setOverlayShortcut(null) : undefined}
                onSnapshot={onSnapshot}
            />
        );
    }
    if (entry.kind === "shortcut") {
        return (
            <ShortcutRow
                label={label}
                hint={t("items.launcherBinding.hint")}
                shown={snapshot.launcherKey}
                problem={snapshot.launcherProblem}
                settings={settings}
                onPress={(press) => settings.setShortcut(press)}
                onSnapshot={onSnapshot}
            />
        );
    }
    if (entry.kind === "range") {
        return (
            <MaxUsersRow
                entry={entry}
                value={snapshot[key] as number}
                onChange={(next) => {
                    const change = core.readAppSettingChange({ key, value: next });
                    if (change) onChange(change);
                }}
            />
        );
    }
    if (entry.kind === "choice") {
        const value = snapshot[key] as string;
        const options = entry.options.map((id) => ({ value: id, label: choiceLabel(t, key, id) }));
        return (
            <Row label={label} hint={hint}>
                <Select
                    value={value}
                    aria-label={label}
                    options={options}
                    onValueChange={(next) => {
                        const change = core.readAppSettingChange({ key, value: next });
                        if (change) onChange(change);
                    }}
                />
            </Row>
        );
    }
    return (
        <Row label={label} hint={hint}>
            <Switch
                checked={snapshot[key] === true}
                aria-label={label}
                onChange={(on) => {
                    const change = core.readAppSettingChange({ key, value: on });
                    if (change) onChange(change);
                }}
            />
        </Row>
    );
}

/** What a choice reads as: the engine and keep names have their own lists, the rest sit under their setting. */
function choiceLabel(t: ReturnType<typeof useTranslations>, key: core.AppSettingKey, id: string): string {
    if (key === "launcherEngine") return t(`engines.${id}`);
    if (key === "launcherClipboardKeep") return t(`keeps.${id}`);
    return t(`items.${key}.options.${id}`);
}

/** A key the app holds (the launcher's, the overlay's lock): Change takes the
 *  next press, Esc keeps the old one, and "Use default" puts the default back. */
function ShortcutRow({
    label,
    hint,
    shown,
    problem: held,
    settings,
    onPress,
    onDefault,
    onSnapshot
}: {
    label: string;
    hint: string;
    /** The key in use, as a person reads it. */
    shown: string;
    /** Why the key in use is not held, or null. */
    problem: string | null;
    settings: NonNullable<PolarisDesktop["appSettings"]>;
    onPress: (press: core.AppKeyPress) => Promise<unknown>;
    onDefault?: () => Promise<unknown>;
    onSnapshot: (next: core.AppSettingsSnapshot) => void;
}) {
    const t = useTranslations("appSettings");
    const [recording, setRecording] = useState(false);
    const [invalid, setInvalid] = useState(false);
    const recordingRef = useRef(false);

    const stop = useCallback(() => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        setRecording(false);
        void settings.record(false).catch(() => undefined);
    }, [settings]);

    useEffect(() => {
        if (!recording) return;
        const press = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") return stop();
            if (MODIFIER_KEYS.includes(event.key)) return;
            const parsed = core.appKeyPressSchema.safeParse({
                code: event.code,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey
            });
            if (!parsed.success) return setInvalid(true);
            void onPress(parsed.data)
                .catch(() => null)
                .then((answer) => {
                    const next = core.readAppSettings(answer);
                    if (!next) return setInvalid(true);
                    recordingRef.current = false;
                    setRecording(false);
                    setInvalid(false);
                    onSnapshot(next);
                });
        };
        document.addEventListener("keydown", press, true);
        return () => document.removeEventListener("keydown", press, true);
    }, [recording, stop, onPress, onSnapshot]);

    // Leaving the page while it listens gives the key back to the app.
    useEffect(() => () => stop(), [stop]);

    const problem = invalid ? t("shortcut.invalid") : held;
    return (
        <div className="flex flex-col gap-1">
            <Row label={label} hint={recording ? t("shortcut.escape") : hint}>
                <kbd className="max-w-48 truncate rounded border border-border px-1.5 py-0.5 font-mono text-xs" title={shown}>
                    {shown}
                </kbd>
                {onDefault && !recording && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            void onDefault()
                                .catch(() => null)
                                .then((answer) => {
                                    const next = core.readAppSettings(answer);
                                    if (next) onSnapshot(next);
                                    else setInvalid(true);
                                });
                        }}
                    >
                        {t("shortcut.default")}
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="secondary"
                    aria-pressed={recording}
                    onClick={() => {
                        if (recording) return stop();
                        recordingRef.current = true;
                        setInvalid(false);
                        setRecording(true);
                        void settings.record(true).catch(() => undefined);
                    }}
                >
                    {recording ? t("shortcut.recording") : t("shortcut.change")}
                </Button>
            </Row>
            {problem && (
                <p role="status" className="text-xs text-danger">
                    {problem}
                </p>
            )}
        </div>
    );
}

function ClearClipboard({ settings }: { settings: NonNullable<PolarisDesktop["appSettings"]> }) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    return (
        <Card>
            <CardBody>
                <Row label={t("clipboard.clear")} hint={t("clipboard.clearHint")}>
                    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                        {t("clipboard.clearConfirm")}
                    </Button>
                </Row>
                <ConfirmDeleteDialog
                    open={open}
                    onOpenChange={setOpen}
                    requireTyping={false}
                    kind={t("clipboard.clearKind")}
                    name={t("clipboard.clearName")}
                    title={`${t("clipboard.clear")}?`}
                    question={t("clipboard.clearQuestion")}
                    confirmLabel={t("clipboard.clearConfirm")}
                    pending={pending}
                    onConfirm={() => {
                        setPending(true);
                        void settings
                            .clearClipboard()
                            .then(
                                () => toast.show({ title: t("clipboard.cleared") }),
                                () => toast.show({ title: t("saveFailed") })
                            )
                            .finally(() => {
                                setPending(false);
                                setOpen(false);
                            });
                    }}
                />
            </CardBody>
        </Card>
    );
}

function Hosts({
    servers,
    server,
    hint,
    onManage
}: {
    servers: core.AppSettingsSnapshot["servers"];
    server: string | null;
    /** What the app's own hosts screen is called where it opens: a window on a computer, a screen on a phone. */
    hint: string;
    onManage: () => void;
}) {
    const t = useTranslations("appSettings");
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                {servers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("hosts.none")}</p>
                ) : (
                    <ul className="flex flex-col gap-3">
                        {servers.map((host) => (
                            <li key={host.origin} className="flex min-w-0 items-center justify-between gap-3">
                                <div className="flex min-w-0 flex-col">
                                    <span className="truncate text-sm" title={host.name ?? host.origin}>
                                        {host.name ?? host.origin}
                                    </span>
                                    {host.name && (
                                        <span className="truncate text-xs text-muted-foreground" title={host.origin}>
                                            {host.origin}
                                        </span>
                                    )}
                                </div>
                                {host.origin === server && (
                                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                        <Check className="size-3.5 shrink-0" aria-hidden />
                                        {t("hosts.current")}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <Row label={t("hosts.manage")} hint={hint}>
                    <Button size="sm" variant="secondary" onClick={onManage}>
                        {t("hosts.manage")}
                    </Button>
                </Row>
            </CardBody>
        </Card>
    );
}

type UpdateState = { readonly kind: "idle" } | { readonly kind: "checking" } | DesktopUpdateCheck;

function Updates({ bridge, version }: { bridge: PolarisDesktop; version: string }) {
    const t = useTranslations("appSettings");
    const [state, setState] = useState<UpdateState>({ kind: "idle" });
    // Opened from the window's cache with no connection: a check or a download
    // page cannot answer, so they wait for one and say so. A restart into an
    // update already downloaded needs none.
    const { online } = useNetworkState();

    // An update already downloaded, or one that finishes while the page is open.
    useEffect(() => {
        let live = true;
        void bridge
            .updateReady?.()
            .then((ready) => {
                if (live && ready) setState({ kind: "ready", version: ready.version });
            })
            .catch(() => undefined);
        const stop = bridge.onUpdateReady?.((ready) => {
            if (ready) setState({ kind: "ready", version: ready.version });
        });
        return () => {
            live = false;
            stop?.();
        };
    }, [bridge]);

    const message = (() => {
        switch (state.kind) {
            case "idle":
                return null;
            case "checking":
                return t("updates.checking");
            case "current":
                return t("updates.current");
            case "downloading":
                return t("updates.downloading", { version: state.version });
            case "ready":
                return t("updates.ready", { version: state.version });
            case "available":
                return t("updates.available", { version: state.version });
            case "failed":
                return t("updates.failed");
            case "unsupported":
                return t("updates.unsupported");
        }
    })();
    const busy = state.kind === "checking" || state.kind === "downloading";
    const waiting = !online && state.kind !== "ready";

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <Row label={t("updates.version", { version: version || bridge.version })} hint={waiting ? t("updates.offline") : message}>
                    {state.kind === "ready" && bridge.installUpdate ? (
                        <Button size="sm" onClick={() => void bridge.installUpdate?.()}>
                            {t("updates.restart")}
                        </Button>
                    ) : state.kind === "available" && !waiting ? (
                        <Link href="/account/downloads" className={buttonVariants({ size: "sm" })}>
                            {t("updates.download")}
                        </Link>
                    ) : bridge.checkForUpdates ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            aria-disabled={busy || waiting}
                            onClick={() => {
                                if (busy || waiting) return;
                                setState({ kind: "checking" });
                                void bridge
                                    .checkForUpdates?.()
                                    .catch(() => null)
                                    .then((found) => setState(readDesktopUpdateCheck(found)));
                            }}
                        >
                            {t("updates.check")}
                        </Button>
                    ) : null}
                </Row>
            </CardBody>
        </Card>
    );
}

/** The app says a value changed on one of its own screens (its servers, mostly). */
const PHONE_CHANGED = "polaris-mobile-app-settings";

function InPhone({ settings, category }: { settings: PhoneAppSettings; category: core.AppSettingCategory; }) {
    const t = useTranslations("appSettings");
    const [snapshot, setSnapshot] = useState<core.AppPhoneSnapshot | null>(() => settings.read());

    useEffect(() => {
        const refresh = () => {
            const next = settings.read();
            if (next) setSnapshot(next);
        };
        const visible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        refresh();
        window.addEventListener("focus", refresh);
        window.addEventListener(PHONE_CHANGED, refresh);
        document.addEventListener("visibilitychange", visible);
        return () => {
            window.removeEventListener("focus", refresh);
            window.removeEventListener(PHONE_CHANGED, refresh);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [settings]);

    if (!core.phoneHasCategory(category)) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("phone.notHere.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("phone.notHere.body")}</p>
                    </div>
                    <Link href="/account/app/general" className={buttonVariants({ size: "sm", variant: "secondary" })}>
                        {t("phone.notHere.back")}
                    </Link>
                </CardBody>
            </Card>
        );
    }
    if (!snapshot) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-3">
                    <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
                    <Button size="sm" variant="secondary" onClick={() => setSnapshot(settings.read())}>
                        {t("retry")}
                    </Button>
                </CardBody>
            </Card>
        );
    }
    if (category === "hosts") {
        return (
            <Hosts
                servers={snapshot.servers}
                server={snapshot.server}
                hint={t("phone.hostsHint")}
                onManage={() => void settings.manageHosts()}
            />
        );
    }
    if (category === "updates") return <PhoneUpdates settings={settings} snapshot={snapshot} />;
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                {snapshot.actions.map((action) => (
                    <Row
                        key={action}
                        label={t(`phone.actions.${action}.label`)}
                        hint={action === "browser" && snapshot.server ? snapshot.server : t(`phone.actions.${action}.hint`)}
                    >
                        <Button size="sm" variant="secondary" onClick={() => void settings.open(action)}>
                            {t("phone.open")}
                        </Button>
                    </Row>
                ))}
                {snapshot.actions.length === 0 && <p className="text-sm text-muted-foreground">{t("phone.none")}</p>}
            </CardBody>
        </Card>
    );
}

type PhoneUpdateState = { readonly kind: "idle"; } | { readonly kind: "checking"; } | core.AppPhoneUpdateCheck;

function PhoneUpdates({ settings, snapshot }: { settings: PhoneAppSettings; snapshot: core.AppPhoneSnapshot; }) {
    const t = useTranslations("appSettings");
    const [state, setState] = useState<PhoneUpdateState>({ kind: "idle" });
    // From the cache with no connection the check cannot answer: it waits for one.
    const { online } = useNetworkState();
    const live = useRef(true);
    useEffect(() => {
        live.current = true;
        return () => {
            live.current = false;
        };
    }, []);

    const message = (() => {
        if (snapshot.updates === "store") return t("updates.unsupported");
        switch (state.kind) {
            case "idle":
                return null;
            case "checking":
                return t("updates.checking");
            case "current":
                return t("updates.current");
            case "available":
                return t("phone.updateOffered", { version: state.version });
            case "store":
                return t("updates.unsupported");
            case "failed":
                return t("updates.failed");
        }
    })();
    const busy = state.kind === "checking";
    const waiting = !online && snapshot.updates === "check";

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <Row label={t("updates.version", { version: snapshot.version })} hint={waiting ? t("updates.offline") : message}>
                    {snapshot.updates === "check" && (
                        <Button
                            size="sm"
                            variant="secondary"
                            aria-disabled={busy || waiting}
                            onClick={() => {
                                if (busy || waiting) return;
                                setState({ kind: "checking" });
                                void settings.checkForUpdates().then((answer) => {
                                    if (live.current) setState(answer);
                                });
                            }}
                        >
                            {t("updates.check")}
                        </Button>
                    )}
                </Row>
            </CardBody>
        </Card>
    );
}
