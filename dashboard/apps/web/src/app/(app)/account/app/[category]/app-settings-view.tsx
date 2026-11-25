"use client";

/**
 * One category of the desktop or phone app's own settings, drawn from the shared schema
 * (`@polaris/core/app-settings`) and read and written through the app's bridge.
 *
 * The rows, their names and their explanations are known before the app is
 * asked anything, so they draw at once; the values come from the last answer
 * kept on this device - or the schema's defaults, on a device that has never
 * seen an answer - and are swapped only where the app's answer differs
 * (`useAppSettingsValues`). A change shows immediately and is put back when
 * the app refuses it. The app says when a value changed anywhere else (its
 * tray, its own page, another window), and the page reads again then and
 * whenever it comes back into view.
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
import { ThisDeviceApp } from "@/components/this-app/this-device-app";
import { phoneAppSettings, phoneHosts, type PhoneAppSettings } from "@/lib/mobile-bridge";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { MaxUsersRow, OverlayGames, ResetOverlay, VoiceWidgetPreview } from "./voice-widget-preview";
import { useAppSettingsValues } from "@/components/this-app/app-settings-values";
import { Button, buttonVariants, Card, CardBody, ConfirmDeleteDialog, Select, Skeleton, Switch, useToast } from "@polaris/ui";

export { forgetAppSettingsSnapshot } from "@/components/this-app/app-settings-values";

const MODIFIER_KEYS = ["Control", "Alt", "Shift", "Meta"];

/** Whether a setting is listed: every switch it sits under, all the way up, is on. */
export function settingShown(entry: core.AppSettingEntry, snapshot: core.AppSettingsSnapshot | null): boolean {
    let parent = entry.dependsOn;
    for (let depth = 0; parent && depth < 8; depth++) {
        if (snapshot?.[parent as core.AppSettingKey] !== true) return false;
        parent = (core.APP_SETTINGS as readonly core.AppSettingEntry[]).find((item) => item.key === parent)?.dependsOn;
    }
    return true;
}

/** A whole category: its title, its line, and its rows. Drawn the same by the page and its loading state. */
export function AppSettingsScreen({ category }: { category: core.AppSettingCategory }) {
    const t = useTranslations("appSettings");
    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t(`categories.${category}.title`)}</h1>
                <AppSettingsIntro category={category} />
            </div>
            {/* The app's version and its updates, first thing under General. */}
            {category === "general" && <ThisDeviceApp />}
            <AppSettingsView category={category} />
        </div>
    );
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
    return <InApp settings={bridge.appSettings} category={category} />;
}

function InApp({
    settings,
    category
}: {
    settings: NonNullable<PolarisDesktop["appSettings"]>;
    category: core.AppSettingCategory;
}) {
    const t = useTranslations("appSettings");
    const { snapshot, known, unavailable, refresh, change, keep } = useAppSettingsValues(settings, category);

    // Never seen on this device and the app did not answer: the defaults would be a guess, so say so.
    if (!known && unavailable) {
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

    // A row only one app's build has waits for that app to list the feature; the rest draw now.
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
                    servers={known ? snapshot.servers : null}
                    server={snapshot.server}
                    hint={t("hosts.manageHint")}
                    onManage={() => void settings.manageHosts()}
                />
            )}
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
    let label: string = t(`items.${key}.label`);
    if (key === "launcher") label = t("items.launcher.label", { key: snapshot.launcherKey });
    let hint: string = t(`items.${key}.hint`);
    if (key === "launcherClipboard" && !snapshot.launcherClipboardPersists) hint = t("clipboard.memoryOnly");
    // A key somebody chose replaces the default keys the hint names.
    if (key === "voiceWidget" && snapshot.overlayLockBinding && snapshot.overlayLockKey) {
        hint = t("items.voiceWidget.hintKey", { key: snapshot.overlayLockKey });
    }

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
    /** Null while this device has never seen the list: a placeholder line in its place. */
    servers: core.AppSettingsSnapshot["servers"] | null;
    server: string | null;
    /** What the app's own hosts screen is called where it opens: a window on a computer, a screen on a phone. */
    hint: string;
    onManage: () => void;
}) {
    const t = useTranslations("appSettings");
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                {servers === null ? (
                    <Skeleton aria-busy="true" className="h-5 w-48" />
                ) : servers.length === 0 ? (
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
