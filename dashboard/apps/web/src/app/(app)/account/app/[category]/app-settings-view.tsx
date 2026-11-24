"use client";

/**
 * One category of the desktop app's own settings, drawn from the shared schema
 * (`@polaris/core/app-settings`) and read and written through the app's bridge.
 *
 * Every read is local - the app answers over IPC, no network - and the last
 * answer is kept for the session, so moving between categories draws at once
 * and only swaps a value that changed. A change shows immediately and is put
 * back when the app refuses it. The app says when a value changed anywhere
 * else (its tray, its own page, another window), and the page reads again then
 * and whenever it comes back into view.
 */

import Link from "next/link";
import { Check } from "lucide-react";
import * as core from "@polaris/core/app-settings";
import { useDesktopBridge } from "@/components/desktop-app";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readDesktopUpdateCheck, type DesktopUpdateCheck, type PolarisDesktop } from "@/lib/desktop-bridge";
import { Button, buttonVariants, Card, CardBody, ConfirmDeleteDialog, Select, Skeleton, Switch, useToast } from "@polaris/ui";

/** The last snapshot the app gave, so a category opened next draws without waiting. */
let lastSnapshot: core.AppSettingsSnapshot | null = null;

/** Only for tests: forget the kept snapshot. */
export function forgetAppSettingsSnapshot(): void {
    lastSnapshot = null;
}

const MODIFIER_KEYS = ["Control", "Alt", "Shift", "Meta"];

export function AppSettingsView({ category }: { category: core.AppSettingCategory }) {
    const bridge = useDesktopBridge();
    const t = useTranslations("appSettings");
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
        .filter((entry) => !entry.dependsOn || snapshot[entry.dependsOn as core.AppSettingKey] === true);

    return (
        <div className="flex flex-col gap-4">
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
            {category === "hosts" && <Hosts snapshot={snapshot} settings={settings} />}
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

    if (entry.kind === "shortcut") {
        return <ShortcutRow label={label} snapshot={snapshot} settings={settings} onSnapshot={onSnapshot} />;
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

/** The launcher's key: Change takes the next press, Esc keeps the old one. */
function ShortcutRow({
    label,
    snapshot,
    settings,
    onSnapshot
}: {
    label: string;
    snapshot: core.AppSettingsSnapshot;
    settings: NonNullable<PolarisDesktop["appSettings"]>;
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
            void settings
                .setShortcut(parsed.data)
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
    }, [recording, settings, stop, onSnapshot]);

    // Leaving the page while it listens gives the key back to the app.
    useEffect(() => () => stop(), [stop]);

    const problem = invalid ? t("shortcut.invalid") : snapshot.launcherProblem;
    return (
        <div className="flex flex-col gap-1">
            <Row label={label} hint={recording ? t("shortcut.escape") : t("items.launcherBinding.hint")}>
                <kbd className="truncate rounded border border-border px-1.5 py-0.5 font-mono text-xs">
                    {snapshot.launcherKey}
                </kbd>
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
    snapshot,
    settings
}: {
    snapshot: core.AppSettingsSnapshot;
    settings: NonNullable<PolarisDesktop["appSettings"]>;
}) {
    const t = useTranslations("appSettings");
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                {snapshot.servers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("hosts.none")}</p>
                ) : (
                    <ul className="flex flex-col gap-3">
                        {snapshot.servers.map((host) => (
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
                                {host.origin === snapshot.server && (
                                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                        <Check className="size-3.5 shrink-0" aria-hidden />
                                        {t("hosts.current")}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <Row label={t("hosts.manage")} hint={t("hosts.manageHint")}>
                    <Button size="sm" variant="secondary" onClick={() => void settings.manageHosts()}>
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

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <Row label={t("updates.version", { version: version || bridge.version })} hint={message}>
                    {state.kind === "ready" && bridge.installUpdate ? (
                        <Button size="sm" onClick={() => void bridge.installUpdate?.()}>
                            {t("updates.restart")}
                        </Button>
                    ) : state.kind === "available" ? (
                        <Link href="/account/downloads" className={buttonVariants({ size: "sm" })}>
                            {t("updates.download")}
                        </Link>
                    ) : bridge.checkForUpdates ? (
                        <Button
                            size="sm"
                            variant="secondary"
                            aria-disabled={busy}
                            onClick={() => {
                                if (busy) return;
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
