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
 * button pressed on a bridge, a code the maker emails. Those declare `pairing`
 * in the registry, and this dialog draws the step for them - the code to scan,
 * the wait, or a box for the emailed code. A scan or a button is asked about on
 * its own every few seconds, so nobody has to press anything once they have
 * scanned; an emailed code is sent once it is typed, and a wrong one leaves the
 * box there to try again. An attempt that runs out stops and offers a new one.
 * Which kind of step, how often and for how long are the registry's; nothing
 * here names a make.
 *
 * A pairing can also ask for a file after its first step - Philips' fan and
 * heater cloud needs a value read out of the maker's own app. The poll answers
 * that step with what it saw so far, the dialog says why the file is needed and
 * where to get it, streams it to `/api/home/pairing/file` (an action carries a
 * megabyte; an app is a hundred times that) and polls again with what comes
 * back - a handle to what was read, never the value. Where the attempt found
 * something already, it can also go on without the file.
 *
 * A credential is written once and never shown again. There is no reveal and no
 * masked copy of it in a field on the next visit: it is a key to somebody's front
 * door, and a screen that can print it back is a screen somebody can be walked
 * into opening.
 */

import Link from "next/link";
import * as actions from "../actions";
import * as kinds from "../../lib/device-kinds";
import type { DeviceView } from "../../lib/device-kinds";
import * as registry from "../../lib/device-connections";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceAccountView } from "../../lib/device-accounts";
import {
    Check,
    ChevronRight,
    ExternalLink,
    Loader2,
    RefreshCw,
    Search,
    Upload
} from "lucide-react";
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
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import { englishPlaces } from "../../../messages";
import type { PlacesTranslator } from "../../lib/i18n";

const { runAction } = hostUi.runAction;
const { IntegrationLogo } = hostUi.logos;
const { QRCodeSVG } = hostUi.qrCode;

/** One attempt at pairing, as the server started it. */
interface Pairing {
    readonly state: Record<string, string>;
    readonly qr?: string;
}

/** A file the attempt asked for after its first step. */
interface FileStep {
    readonly state: Record<string, string>;
    readonly summary: string;
    readonly skippable: boolean;
}

/** What a poll answered, as far as finishing goes. */
interface PollAnswer {
    readonly error?: string;
    readonly waiting?: boolean;
    readonly next?: FileStep;
    readonly unsupported?: string[];
    readonly devices?: DeviceView[];
    readonly accounts?: DeviceAccountView[];
}

/** Send a file to the pairing's file step and answer the state it adds, or
 *  the refusal to show. */
async function uploadPairingFile(
    connection: string,
    file: File
): Promise<{ state?: Record<string, string>; error?: string }> {
    try {
        const response = await fetch(
            `/api/home/pairing/file?connection=${encodeURIComponent(connection)}`,
            {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: file
            }
        );
        const body = (await response.json().catch(() => ({}))) as {
            state?: Record<string, string>;
            error?: string;
        };
        if (!response.ok || !body.state) return { error: body.error ?? "" };
        return { state: body.state };
    } catch {
        return { error: "" };
    }
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

/** Case and accents folded away, so "cancion" finds "Canción". */
function folded(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The makes that answer what was typed, the way Home Assistant's "add
 * integration" list does: every word has to be somewhere in the make's name, what
 * it brings in, or the names and words of its ways in - a word found nowhere
 * leaves nothing, rather than a list of near misses. Names that start with the
 * query come first, then the rest, each in alphabetical order.
 */
function matchingBrands(
    brands: readonly registry.DeviceBrand[],
    query: string,
    t: PlacesTranslator
): readonly registry.DeviceBrand[] {
    const words = folded(query).split(/\s+/).filter(Boolean);
    const named = (entry: registry.DeviceBrand) => folded(brandWords(entry.brand, t));
    const sorted = [...brands].sort((a, b) => named(a).localeCompare(named(b)));
    if (words.length === 0) return sorted;
    const matches = sorted.filter((entry) => {
        const ways = registry.connectionsOfBrand(entry.brand);
        const haystack = folded(
            [
                brandWords(entry.brand, t),
                kindsOf(entry, t),
                ...ways.flatMap((way) => [
                    way.label,
                    registry.connectionWords(t, way).label,
                    ...(way.search ?? [])
                ])
            ].join(" ")
        );
        return words.every((word) => haystack.includes(word));
    });
    const lead = words.join(" ");
    return [
        ...matches.filter((entry) => named(entry).startsWith(lead)),
        ...matches.filter((entry) => !named(entry).startsWith(lead))
    ];
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
                    type={
                        field.secret === true
                            ? "password"
                            : field.format === "email"
                              ? "email"
                              : "text"
                    }
                    value={value}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={words.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                    onBlur={() => {
                        const normalized = registry.normalizeField(field, value);
                        if (normalized !== value) onChange(normalized);
                    }}
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
    /** No make until one is picked from the list: the list is the first step. */
    const [brand, setBrand] = useState("");
    const [chosen, setChosen] = useState("");
    const [query, setQuery] = useState("");
    const shown = useMemo(() => matchingBrands(brands, query, t), [brands, query, t]);
    const picked = brands.find((entry) => entry.brand === brand) ?? null;
    /** The first step: the list of makes, before one is picked. */
    const choosing = !reconnect && !picked;
    const [label, setLabel] = useState("");
    const [fields, setFields] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    /** The attempt being waited on, for a connection made by pairing. */
    const [pairing, setPairing] = useState<Pairing | null>(null);
    const [expired, setExpired] = useState(false);
    /** The code typed for a pairing that is emailed one. */
    const [code, setCode] = useState("");
    /** The file the attempt asked for after its code, and the one chosen. */
    const [fileStep, setFileStep] = useState<FileStep | null>(null);
    const [chosenFile, setChosenFile] = useState<File | null>(null);
    /** A connection made with models it cannot fully operate yet: said once,
     *  before the dialog closes, rather than left to be found row by row. */
    const [finished, setFinished] = useState<{
        readonly result: Connected;
        readonly unsupported: readonly string[];
    } | null>(null);

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
        setBrand("");
        setChosen("");
        setQuery("");
        setPairing(null);
        setExpired(false);
        setCode("");
        setFinished(null);
        setFileStep(null);
        setChosenFile(null);
    }, [open]);

    // Ask whether the other side has agreed, every few seconds, until it has, it
    // refuses, or the attempt runs out.
    useEffect(() => {
        const steps = connection?.pairing;
        if (!open || !pairing || expired || !connection || !steps) return;
        // An emailed code is not waited on: it is sent when it is typed.
        if (steps.kind === "code") {
            const lapse = window.setTimeout(() => setExpired(true), steps.lifetimeMs);
            return () => window.clearTimeout(lapse);
        }
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
                latest.current.onConnected({
                    devices: result.devices ?? [],
                    accounts: result.accounts ?? []
                });
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
        setFileStep(null);
    };

    const pickConnection = (next: string) => {
        setChosen(next);
        setFields({});
        setError("");
        setPairing(null);
        setFileStep(null);
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
        setCode("");
        setFileStep(null);
        setChosenFile(null);
        setPairing({ state: result.state, qr: result.qr });
    };

    /** What a poll that sent something answered: a refusal stays on the step
     *  it came from, a file step is drawn, and a connection closes the dialog -
     *  after naming any model it cannot fully operate yet. */
    const settle = (result: PollAnswer) => {
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.next) {
            setFileStep(result.next);
            setChosenFile(null);
            return;
        }
        if (result.waiting) return;
        setPairing(null);
        setFileStep(null);
        setChosenFile(null);
        setExpired(false);
        setCode("");
        setFields({});
        setLabel("");
        const connected = { devices: result.devices ?? [], accounts: result.accounts ?? [] };
        if (result.unsupported && result.unsupported.length > 0) {
            setFinished({ result: connected, unsupported: result.unsupported });
            return;
        }
        onConnected(connected);
    };

    /** Poll once with a state, for a step that sends something. */
    const pollWith = async (state: Record<string, string>) => {
        if (!connection) return;
        const result = await runAction(
            () =>
                actions.pollDevicePairingAction({
                    connection: connection.id,
                    label,
                    fields,
                    state,
                    accountId: reconnect?.id
                }),
            setError
        );
        if (result) settle(result);
    };

    const fileSpec = connection?.pairing?.file;
    const fileWords = said?.pairingFile;
    /** Why a chosen file cannot be sent, before it is: not an app file, or
     *  larger than the step takes. */
    const fileIssue =
        chosenFile && fileSpec
            ? !fileSpec.accept
                  .split(",")
                  .some((ending) => chosenFile.name.toLowerCase().endsWith(ending.trim()))
                ? t("connect.pair.fileType", { accept: fileSpec.accept.replace(/,/g, ", ") })
                : chosenFile.size > fileSpec.maxBytes
                  ? t("connect.pair.fileLarge")
                  : ""
            : "";

    /** Upload the chosen file, then ask again with what reading it gave. */
    const sendFile = async () => {
        if (!connection || !fileStep || !chosenFile || fileIssue || saving) return;
        setSaving(true);
        setError("");
        const uploaded = await uploadPairingFile(connection.id, chosenFile);
        if (!uploaded.state) {
            setSaving(false);
            setError(uploaded.error || t("connect.pair.fileFailed"));
            return;
        }
        await pollWith({ ...fileStep.state, ...uploaded.state });
        setSaving(false);
    };

    /** Finish with what was found before the file step. */
    const skipFile = async () => {
        if (!fileStep || saving) return;
        setSaving(true);
        setError("");
        await pollWith({ ...fileStep.state, skip: "1" });
        setSaving(false);
    };

    /** Send the emailed code. A wrong one leaves the box where it is, saying why,
     *  so it can be typed again or a new one asked for. */
    const sendCode = async () => {
        const typed = code.replace(/\s+/g, "");
        if (!connection || !pairing || !typed || saving || expired) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.pollDevicePairingAction({
                    connection: connection.id,
                    label,
                    fields,
                    state: { ...pairing.state, code: typed },
                    accountId: reconnect?.id
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        settle(result);
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
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (next) return;
                // Closed on the notice: the account is connected all the same,
                // so the screen behind is told, not left without it.
                if (finished) {
                    const done = finished.result;
                    setFinished(null);
                    onConnected(done);
                    return;
                }
                onClose();
            }}
        >
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {reconnect
                            ? t("connect.reconnectTitle", { name: reconnect.label })
                            : t("connect.title")}
                    </DialogTitle>
                    <DialogDescription>
                        {reconnect ? t("connect.reconnectIntro") : t("connect.intro")}
                    </DialogDescription>
                </DialogHeader>

                {finished ? (
                    <>
                        <p role="status" className="text-sm text-muted-foreground">
                            {t("connect.unsupported", {
                                models: finished.unsupported.join(", "),
                                count: finished.unsupported.length
                            })}
                        </p>
                        <DialogFooter>
                            <Button
                                onClick={() => {
                                    const done = finished.result;
                                    setFinished(null);
                                    onConnected(done);
                                }}
                            >
                                {t("connect.done")}
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <>
                        <div className="flex flex-col gap-4">
                            {choosing && (
                                <div className="flex flex-col gap-2">
                                    <div className="relative">
                                        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            autoFocus
                                            type="search"
                                            value={query}
                                            className="pl-9"
                                            spellCheck={false}
                                            autoComplete="off"
                                            placeholder={t("connect.search")}
                                            aria-label={t("connect.search")}
                                            onChange={(event) => setQuery(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key !== "Enter" || !shown[0]) return;
                                                event.preventDefault();
                                                pickBrand(shown[0].brand);
                                            }}
                                        />
                                    </div>
                                    {shown.length === 0 ? (
                                        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                                            {t("connect.noMatch", { query: query.trim() })}
                                        </p>
                                    ) : (
                                        <ul
                                            aria-label={t("connect.make")}
                                            className="-mx-1 flex max-h-[min(24rem,55vh)] flex-col overflow-y-auto"
                                        >
                                            {shown.map((entry) => (
                                                <li key={entry.brand}>
                                                    <button
                                                        type="button"
                                                        onClick={() => pickBrand(entry.brand)}
                                                        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-fast hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                                                    >
                                                        <IntegrationLogo
                                                            slug={entry.logo}
                                                            className="size-6 w-8 shrink-0 object-contain"
                                                        />
                                                        <span className="flex min-w-0 flex-1 flex-col">
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
                                                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}

                            {!reconnect && !pairing && picked && (
                                <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
                                    <IntegrationLogo
                                        slug={picked.logo}
                                        className="size-6 w-8 shrink-0 object-contain"
                                    />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span
                                            className="truncate text-sm font-medium"
                                            title={brandWords(picked.brand, t)}
                                        >
                                            {brandWords(picked.brand, t)}
                                        </span>
                                        <span
                                            className="truncate text-[0.6875rem] text-foreground-subtle"
                                            title={kindsOf(picked, t)}
                                        >
                                            {kindsOf(picked, t)}
                                        </span>
                                    </span>
                                    <Button variant="ghost" size="sm" onClick={() => pickBrand("")}>
                                        {t("connect.change")}
                                    </Button>
                                </div>
                            )}
                            {!reconnect && !pairing && ofBrand.length > 1 && (
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-xs text-muted-foreground">
                                        {t("connect.how")}
                                    </span>
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
                                    <span className="text-xs text-muted-foreground">
                                        {said?.summary}
                                    </span>
                                    {said?.note && (
                                        <span className="text-xs text-foreground-subtle">
                                            {said.note}
                                        </span>
                                    )}
                                </div>
                            )}

                            {!pairing && said && said.steps.length > 0 && (
                                <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-muted-foreground">
                                    {said.steps.map((step, index) => (
                                        <li key={step}>
                                            {index === 0 &&
                                            said.link &&
                                            step.includes(said.link.label) ? (
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

                            {pairing && !fileStep && connection?.pairing?.kind === "code" && (
                                <div className="flex flex-col gap-3">
                                    {said?.pairingPrompt && (
                                        <p className="text-xs text-muted-foreground">
                                            {said.pairingPrompt}
                                        </p>
                                    )}
                                    <label className="flex flex-col gap-1.5">
                                        <span className="text-xs text-muted-foreground">
                                            {t("connect.pair.codeField")}
                                            <span className="text-danger"> *</span>
                                        </span>
                                        <Input
                                            value={code}
                                            maxLength={32}
                                            spellCheck={false}
                                            autoComplete="one-time-code"
                                            autoFocus
                                            disabled={expired}
                                            onChange={(event) => setCode(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") void sendCode();
                                            }}
                                            aria-label={t("connect.pair.codeField")}
                                        />
                                    </label>
                                    {expired && (
                                        <p className="text-xs text-muted-foreground">
                                            {t("connect.pair.codeExpired")}
                                        </p>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="self-start"
                                        onClick={() => void startPairing()}
                                        disabled={saving}
                                    >
                                        <RefreshCw className="size-4" />
                                        {t("connect.pair.resend")}
                                    </Button>
                                </div>
                            )}

                            {pairing && fileStep && fileSpec && fileWords && (
                                <div className="flex flex-col gap-3">
                                    <p className="text-sm font-medium">{fileWords.title}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {fileWords.why(fileStep.summary)}
                                    </p>
                                    <label className="flex flex-col gap-1.5">
                                        <span className="text-xs text-muted-foreground">
                                            {fileWords.field}
                                            <span className="text-danger"> *</span>
                                        </span>
                                        <input
                                            type="file"
                                            accept={fileSpec.accept}
                                            disabled={saving}
                                            onChange={(event) => {
                                                setError("");
                                                setChosenFile(event.target.files?.[0] ?? null);
                                            }}
                                            aria-label={fileWords.field}
                                            className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:text-foreground"
                                        />
                                    </label>
                                    {fileIssue && (
                                        <span className="text-xs text-danger">{fileIssue}</span>
                                    )}
                                    <p className="text-xs text-foreground-subtle">
                                        {fileWords.link &&
                                        fileWords.where.includes(fileWords.link) ? (
                                            <>
                                                {fileWords.where.split(fileWords.link)[0]}
                                                <Link
                                                    href={fileSpec.href}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 text-foreground underline"
                                                >
                                                    {fileWords.link}
                                                    <ExternalLink className="size-3 shrink-0" />
                                                </Link>
                                                {fileWords.where.split(fileWords.link)[1]}
                                            </>
                                        ) : (
                                            fileWords.where
                                        )}
                                    </p>
                                    {saving && (
                                        <p
                                            className="flex items-center gap-2 text-xs text-foreground-subtle"
                                            aria-live="polite"
                                        >
                                            <Loader2 className="size-3.5 shrink-0 animate-spin" />
                                            {t("connect.pair.fileReading")}
                                        </p>
                                    )}
                                </div>
                            )}

                            {pairing &&
                                connection?.pairing &&
                                connection.pairing.kind !== "code" && (
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
                                            setFields((current) => ({
                                                ...current,
                                                [field.key]: value
                                            }))
                                        }
                                    />
                                ))}

                            {!pairing && !choosing && (
                                <label className="flex flex-col gap-1.5">
                                    <span className="text-xs text-muted-foreground">
                                        {t("connect.label")}{" "}
                                        <span className="text-foreground-subtle">
                                            {t("deviceDialog.optional")}
                                        </span>
                                    </span>
                                    <Input
                                        value={label}
                                        maxLength={60}
                                        placeholder={
                                            reconnect?.label ??
                                            (connection ? brandWords(connection.brand, t) : "")
                                        }
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
                                <>
                                    <Button
                                        variant="outline"
                                        onClick={() => {
                                            setPairing(null);
                                            setFileStep(null);
                                            setChosenFile(null);
                                        }}
                                        disabled={saving}
                                    >
                                        {t("connect.pair.back")}
                                    </Button>
                                    {fileStep && fileStep.skippable && fileWords?.skip && (
                                        <Button
                                            variant="outline"
                                            onClick={() => void skipFile()}
                                            disabled={saving}
                                        >
                                            {fileWords.skip}
                                        </Button>
                                    )}
                                    {fileStep && (
                                        <Button
                                            onClick={() => void sendFile()}
                                            disabled={!chosenFile || Boolean(fileIssue) || saving}
                                            aria-disabled={
                                                !chosenFile || Boolean(fileIssue) || saving
                                            }
                                        >
                                            {saving ? (
                                                <Loader2 className="size-4 animate-spin" />
                                            ) : (
                                                <Upload className="size-4" />
                                            )}
                                            {saving
                                                ? t("connect.checking")
                                                : t("connect.pair.fileSend")}
                                        </Button>
                                    )}
                                    {!fileStep && connection?.pairing?.kind === "code" && (
                                        <Button
                                            onClick={() => void sendCode()}
                                            disabled={!code.trim() || saving || expired}
                                            aria-disabled={!code.trim() || saving || expired}
                                        >
                                            {saving && <Loader2 className="size-4 animate-spin" />}
                                            {saving ? t("connect.checking") : t("connect.connect")}
                                        </Button>
                                    )}
                                </>
                            ) : choosing ? null : (
                                <Button
                                    onClick={() =>
                                        void (connection?.pairing ? startPairing() : submit())
                                    }
                                    disabled={!complete || saving}
                                    aria-disabled={!complete || saving}
                                >
                                    {saving && <Loader2 className="size-4 animate-spin" />}
                                    {saving
                                        ? t("connect.checking")
                                        : connection?.pairing
                                          ? connection.pairing.kind === "qr"
                                              ? t("connect.pair.showCode")
                                              : connection.pairing.kind === "code"
                                                ? t("connect.pair.getCode")
                                                : t("connect.pair.start")
                                          : t("connect.connect")}
                                </Button>
                            )}
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
