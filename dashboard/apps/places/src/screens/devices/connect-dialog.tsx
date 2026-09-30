"use client";

/**
 * Connecting something the devices at a place are reached through.
 *
 * The make and the way in are two questions, not one, and both are the reader's
 * to answer. A lock maker is a web account reachable from anywhere and a box on
 * the same network answering in milliseconds; a switch maker is a cloud project
 * and a key on the device itself. Which of those somebody has - and which they
 * are willing to depend on - is not something a form can work out for them, so it
 * is asked, with what each one costs written next to it.
 *
 * Everything below those two questions is drawn from the registry: the fields, the
 * hints, what is a secret and what is an address, and the steps for the part that
 * genuinely is not Polaris' to do. Adding a make adds no markup here.
 *
 * Some ways in are done rather than typed: a code scanned with the maker's app, a
 * button pressed on a bridge. Those declare `pairing` in the registry, and this
 * dialog draws the step for them - the code to scan, or the wait - and asks on
 * its own every few seconds whether it has happened, so nobody has to press
 * anything once they have scanned. An attempt that runs out stops asking and
 * offers a new one. Which kind of step, how often and for how long are the
 * registry's; nothing here names a make.
 *
 * A credential is written once and never shown again. There is no reveal and no
 * masked copy of it in a field on the next visit: it is a key to somebody's front
 * door, and a screen that can print it back is a screen somebody can be walked
 * into opening.
 */

import Link from "next/link";
import * as actions from "../actions";
import { useEffect, useMemo, useRef, useState } from "react";
import * as kinds from "../../lib/device-kinds";
import type { DeviceView } from "../../lib/device-kinds";
import * as registry from "../../lib/device-connections";
import { Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { DeviceAccountView } from "../../lib/device-accounts";
import {
    Badge,
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { usePlacesT } from "../use-places-t";
import type { PlacesTranslator } from "../../lib/i18n";
import { englishPlaces } from "../../../messages";

const { runAction } = hostUi.runAction;
const { IntegrationLogo } = hostUi.logos;
const { QRCodeSVG } = hostUi.qrCode;

/** One attempt at pairing, as the server started it. */
interface Pairing {
    readonly state: Record<string, string>;
    readonly qr?: string;
}

/** A make's name as the picker shows it: its own, or the words for the
 *  catch-all that is not a make. */
function brandWords(brand: string, t: PlacesTranslator): string {
    return brand === englishPlaces("connections.brandMqtt") ? t("connections.brandMqtt") : brand;
}

/** What comes back once something is connected: everything the screen behind this
 *  has to redraw, so it never has to go and ask again. */
export interface Connected {
    readonly devices: DeviceView[];
    readonly accounts: DeviceAccountView[];
}

/** What a make brings in, as one line. Written once because the card shows it and
 *  carries the same words as its own title, and two of those drifting apart is a
 *  tooltip that says something the row does not. */
function kindsOf(entry: registry.DeviceBrand, t: PlacesTranslator): string {
    return entry.kinds.map((kind) => kinds.kindText(kind, t).toLowerCase()).join(", ");
}

function Field({
    connection,
    field,
    value,
    onChange
}: {
    connection: registry.DeviceConnection;
    field: registry.ConnectionField;
    value: string;
    onChange: (value: string) => void;
}) {
    const t = usePlacesT();
    const words = registry.fieldWords(t, connection, field);
    const issue = registry.fieldIssue(field, value, t, words.label);
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
                {words.label}
                {field.optional === true ? (
                    <span className="text-foreground-subtle"> {t("deviceDialog.optional")}</span>
                ) : (
                    <span className="text-danger"> *</span>
                )}
            </span>
            {field.choices ? (
                <Select
                    value={value || field.defaultValue || ""}
                    onValueChange={onChange}
                    options={(words.choices ?? []).map((choice) => ({
                        value: choice.value,
                        label: choice.label
                    }))}
                    aria-label={words.label}
                />
            ) : (
                <Input
                    type={field.secret === true ? "password" : "text"}
                    value={value}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={words.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                    aria-label={words.label}
                />
            )}
            {words.hint && <span className="text-xs text-foreground-subtle">{words.hint}</span>}
            {issue && <span className="text-xs text-danger">{issue}</span>}
        </label>
    );
}

export function ConnectDialog({
    open,
    reconnect,
    onClose,
    onConnected
}: {
    open: boolean;
    /** The account being given a new credential, where that is what this is. Its
     *  connection cannot change: a token is replaced, a way in is not. */
    reconnect: DeviceAccountView | null;
    onClose: () => void;
    onConnected: (result: Connected) => void;
}) {
    const t = usePlacesT();
    const brands = useMemo(() => registry.deviceBrands(), []);
    const [brand, setBrand] = useState(brands[0]?.brand ?? "");
    const [chosen, setChosen] = useState(
        registry.recommendedConnection(brands[0]?.brand ?? "")?.id ?? ""
    );
    const [label, setLabel] = useState("");
    const [fields, setFields] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    /** The attempt being waited on, for a connection made by pairing. */
    const [pairing, setPairing] = useState<Pairing | null>(null);
    const [expired, setExpired] = useState(false);

    const connectionId = reconnect ? reconnect.connection : chosen;
    const connection = registry.deviceConnection(connectionId);
    const ofBrand = useMemo(() => registry.connectionsOfBrand(brand), [brand]);
    const complete = connection ? registry.fieldsComplete(connection, fields) : false;
    const said = connection ? registry.connectionWords(t, connection) : null;

    /** What a poll needs that may change between renders without the attempt
     *  changing - the screen behind this hands a new callback every render, and
     *  restarting the wait for that would reset how long a code has left. */
    const latest = useRef({ label, fields, reconnect, onConnected });
    latest.current = { label, fields, reconnect, onConnected };

    // An account being reconnected is shown with what it was pointed at, since
    // that is what it is most likely to be pointed at again. Only what the
    // registry calls shown ever arrives here; a credential never does.
    useEffect(() => {
        setFields(reconnect ? { ...reconnect.settings } : {});
    }, [reconnect]);

    // A closed dialog is waiting for nothing.
    useEffect(() => {
        if (open) return;
        setPairing(null);
        setExpired(false);
    }, [open]);

    // Ask whether the other side has agreed, every few seconds, until it has, it
    // refuses, or the attempt runs out.
    useEffect(() => {
        const steps = connection?.pairing;
        if (!open || !pairing || expired || !connection || !steps) return;
        let stopped = false;
        let asking = false;
        const ask = async () => {
            if (stopped || asking) return;
            asking = true;
            const now = latest.current;
            const result = await runAction(
                () =>
                    actions.pollDevicePairingAction({
                        connection: connection.id,
                        label: now.label,
                        fields: now.fields,
                        state: pairing.state,
                        accountId: now.reconnect?.id
                    }),
                setError
            );
            asking = false;
            // A poll that did not get through is asked again on the next tick;
            // the code on the screen is still good.
            if (!result) return;
            if (!result.error && !result.waiting) {
                stopped = true;
                setPairing(null);
                setExpired(false);
                setFields({});
                setLabel("");
                latest.current.onConnected({ devices: result.devices ?? [], accounts: result.accounts ?? [] });
                return;
            }
            if (stopped) return;
            if (result.error) {
                stopped = true;
                setPairing(null);
                setError(result.error);
                return;
            }
            setError("");
        };
        const timer = window.setInterval(() => void ask(), steps.pollMs);
        const lapse = window.setTimeout(() => setExpired(true), steps.lifetimeMs);
        return () => {
            stopped = true;
            window.clearInterval(timer);
            window.clearTimeout(lapse);
        };
    }, [open, pairing, expired, connection]);

    /** A make with one way in is not a question, so the second list is only drawn
     *  where there is something to weigh up - and picking a make always settles on
     *  its recommended one. */
    const pickBrand = (next: string) => {
        setBrand(next);
        setChosen(registry.recommendedConnection(next)?.id ?? "");
        setFields({});
        setError("");
        setPairing(null);
    };

    const pickConnection = (next: string) => {
        setChosen(next);
        setFields({});
        setError("");
        setPairing(null);
    };

    /** Begin an attempt at pairing - or a fresh one, when the last ran out. */
    const startPairing = async () => {
        if (!connection || !complete || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => actions.startDevicePairingAction({ connection: connection.id, label, fields }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error || !result.state) {
            setError(result.error ?? "");
            return;
        }
        setExpired(false);
        setPairing({ state: result.state, qr: result.qr });
    };

    const submit = async () => {
        if (!connection || !complete || saving) return;
        setSaving(true);
        setError("");
        const payload = { connection: connection.id, label, fields };
        const result = await runAction(
            () =>
                reconnect
                    ? actions.reconnectDeviceAccountAction(reconnect.id, payload)
                    : actions.connectDeviceAccountAction(payload),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setFields({});
        setLabel("");
        onConnected({ devices: result.devices ?? [], accounts: result.accounts ?? [] });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {reconnect ? t("connect.reconnectTitle", { name: reconnect.label }) : t("connect.title")}
                    </DialogTitle>
                    <DialogDescription>
                        {reconnect
                            ? t("connect.reconnectIntro")
                            : t("connect.intro")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {!reconnect && !pairing && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">{t("connect.make")}</span>
                            <div className="grid gap-2 sm:grid-cols-2">
                                {brands.map((entry) => (
                                    <button
                                        key={entry.brand}
                                        type="button"
                                        onClick={() => pickBrand(entry.brand)}
                                        aria-pressed={entry.brand === brand}
                                        className={cn(
                                            "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-fast",
                                            entry.brand === brand
                                                ? "border-accent bg-accent/10"
                                                : "border-border bg-card hover:border-border-strong"
                                        )}
                                    >
                                        <IntegrationLogo
                                            slug={entry.logo}
                                            className="size-6 w-8 shrink-0 object-contain"
                                        />
                                        <span className="flex min-w-0 flex-col">
                                            <span
                                                className="truncate text-sm font-medium"
                                                title={brandWords(entry.brand, t)}
                                            >
                                                {brandWords(entry.brand, t)}
                                            </span>
                                            <span
                                                className="truncate text-[0.6875rem] text-foreground-subtle"
                                                title={kindsOf(entry, t)}
                                            >
                                                {kindsOf(entry, t)}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {!reconnect && !pairing && ofBrand.length > 1 && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">{t("connect.how")}</span>
                            <div className="flex flex-col gap-2">
                                {ofBrand.map((entry) => (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        onClick={() => pickConnection(entry.id)}
                                        aria-pressed={entry.id === chosen}
                                        className={cn(
                                            "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors duration-fast",
                                            entry.id === chosen
                                                ? "border-accent bg-accent/10"
                                                : "border-border bg-card hover:border-border-strong"
                                        )}
                                    >
                                        <Check
                                            className={cn(
                                                "mt-0.5 size-4 shrink-0",
                                                entry.id === chosen
                                                    ? "text-accent"
                                                    : "text-transparent"
                                            )}
                                        />
                                        <span className="flex min-w-0 flex-col gap-0.5">
                                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                                                {registry.connectionWords(t, entry).label}
                                                {entry.recommended === true && (
                                                    <Badge className="border-accent/30 bg-accent/10 text-accent">
                                                        {t("connect.recommended")}
                                                    </Badge>
                                                )}
                                            </span>
                                            <span className="text-[0.6875rem] text-muted-foreground">
                                                {registry.connectionWords(t, entry).reach} -{" "}
                                                {registry.connectionWords(t, entry).summary}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {connection && !pairing && (
                        <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
                            <span className="flex items-center gap-2 text-xs font-medium">
                                <IntegrationLogo
                                    slug={connection.logo}
                                    className="size-4 w-6 shrink-0 object-contain"
                                />
                                {said?.label} - {said?.reach}
                            </span>
                            <span className="text-xs text-muted-foreground">{said?.summary}</span>
                            {said?.note && (
                                <span className="text-xs text-foreground-subtle">{said.note}</span>
                            )}
                        </div>
                    )}

                    {!pairing && said && said.steps.length > 0 && (
                        <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-muted-foreground">
                            {said.steps.map((step, index) => (
                                <li key={step}>
                                    {index === 0 && said.link && step.includes(said.link.label) ? (
                                        <>
                                            {step.split(said.link.label)[0]}
                                            <Link
                                                href={said.link.href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="inline-flex items-center gap-1 text-foreground underline"
                                            >
                                                {said.link.label}
                                                <ExternalLink className="size-3" />
                                            </Link>
                                            {step.split(said.link.label)[1]}
                                        </>
                                    ) : (
                                        step
                                    )}
                                </li>
                            ))}
                        </ol>
                    )}

                    {pairing && connection?.pairing && (
                        <div className="flex flex-col items-center gap-3 text-center">
                            {connection.pairing.kind === "qr" && pairing.qr && (
                                <div
                                    role="img"
                                    aria-label={t("connect.pair.codeLabel")}
                                    className="relative rounded-lg bg-white p-3"
                                >
                                    <QRCodeSVG
                                        value={pairing.qr}
                                        size={168}
                                        level="Q"
                                        bgColor="#ffffff"
                                        fgColor="#000000"
                                    />
                                    {expired && (
                                        <div className="absolute inset-0 grid place-items-center rounded-lg bg-background/90 p-2">
                                            <p className="text-xs text-muted-foreground">
                                                {t("connect.pair.expired")}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                            {said?.pairingPrompt && (
                                <p className="max-w-sm text-xs text-muted-foreground">
                                    {said.pairingPrompt}
                                </p>
                            )}
                            {expired ? (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void startPairing()}
                                    disabled={saving}
                                >
                                    {saving ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <RefreshCw className="size-4" />
                                    )}
                                    {t("connect.pair.newCode")}
                                </Button>
                            ) : (
                                <p
                                    className="flex items-center gap-2 text-xs text-foreground-subtle"
                                    aria-live="polite"
                                >
                                    <Loader2 className="size-3.5 animate-spin" />
                                    {connection.pairing.kind === "qr"
                                        ? t("connect.pair.waiting")
                                        : t("connect.pair.waitingPress")}
                                </p>
                            )}
                        </div>
                    )}

                    {!pairing &&
                        connection &&
                        connection.fields.map((field) => (
                            <Field
                                key={field.key}
                                connection={connection}
                                field={field}
                                value={fields[field.key] ?? ""}
                                onChange={(value) =>
                                    setFields((current) => ({ ...current, [field.key]: value }))
                                }
                            />
                        ))}

                    {!pairing && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">
                                {t("connect.label")}{" "}
                                <span className="text-foreground-subtle">{t("deviceDialog.optional")}</span>
                            </span>
                            <Input
                                value={label}
                                maxLength={60}
                                placeholder={reconnect?.label ?? (connection ? brandWords(connection.brand, t) : "")}
                                onChange={(event) => setLabel(event.target.value)}
                                aria-label={t("connect.label")}
                            />
                        </label>
                    )}

                    {error && (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        {t("common.cancel")}
                    </Button>
                    {pairing ? (
                        <Button variant="outline" onClick={() => setPairing(null)}>
                            {t("connect.pair.back")}
                        </Button>
                    ) : (
                        <Button
                            onClick={() => void (connection?.pairing ? startPairing() : submit())}
                            disabled={!complete || saving}
                            aria-disabled={!complete || saving}
                        >
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            {saving
                                ? t("connect.checking")
                                : connection?.pairing
                                  ? connection.pairing.kind === "qr"
                                      ? t("connect.pair.showCode")
                                      : t("connect.pair.start")
                                  : t("connect.connect")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
