"use client";

/**
 * Adding a UPS, or changing how one is reached. One form for the three ways
 * in: a USB cable on a machine (picked from what that machine's daemon sees),
 * a NUT server on the network, or an SNMP card. Checked as it is typed against
 * the schema the server parses with; a stored password or community is never
 * shown, and an empty field keeps it.
 */

import { useMemo, useState, type FormEvent } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select
} from "@polaris/ui";
import type { UpsMachine } from "./ups-words";
import * as upsReading from "@/lib/ups/ups-reading";
import type { UpsView, UsbOffer } from "@/lib/ups/ups-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createUpsAction, updateUpsConnectionAction } from "./actions";

type Connection = UpsView["connection"];

interface FormValues {
    connection: Connection;
    name: string;
    machineId: string;
    deviceId: string;
    host: string;
    port: string;
    upsName: string;
    username: string;
    password: string;
    snmpVersion: "v1" | "v2c" | "v3";
    community: string;
    authPassword: string;
    privPassword: string;
}

function initialValues(editing: UpsView | null, offers: readonly UsbOffer[]): FormValues {
    const first = offers[0];
    return {
        connection: editing?.connection ?? (first ? "usb" : "nut"),
        name: editing?.name ?? first?.name ?? "",
        machineId: editing?.machineId ?? first?.machineId ?? "",
        deviceId: editing?.deviceId ?? first?.deviceId ?? "",
        host: editing?.host ?? "",
        port: editing?.port ? String(editing.port) : "",
        upsName: editing?.upsName ?? "",
        username: editing?.username ?? "",
        password: "",
        snmpVersion: (editing?.snmpVersion as FormValues["snmpVersion"] | null) ?? "v2c",
        community: "",
        authPassword: "",
        privPassword: ""
    };
}

/** The input the server is sent, shaped by the connection picked. */
export function connectionInput(values: FormValues): Record<string, unknown> {
    const port = values.port.trim() === "" ? undefined : values.port;
    if (values.connection === "usb") {
        return { connection: "usb", name: values.name, machineId: values.machineId, deviceId: values.deviceId };
    }
    if (values.connection === "nut") {
        return {
            connection: "nut",
            name: values.name,
            host: values.host,
            port,
            upsName: values.upsName,
            username: values.username,
            password: values.password
        };
    }
    return {
        connection: "snmp",
        name: values.name,
        machineId: values.machineId,
        host: values.host,
        port,
        snmpVersion: values.snmpVersion,
        username: values.username,
        community: values.community,
        authPassword: values.authPassword,
        privPassword: values.privPassword
    };
}

const ERROR_KEYS = [
    "required",
    "tooLong",
    "invalidAddress",
    "invalidSecret",
    "invalidUpsName",
    "invalidUser",
    "invalidDevice",
    "unknownMachine",
    "shutdownIncomplete",
    "notFound",
    "failed",
    "invalid"
] as const;
type ErrorKey = (typeof ERROR_KEYS)[number];

function errorKey(message: string | undefined): ErrorKey {
    return (ERROR_KEYS as readonly string[]).includes(message ?? "") ? (message as ErrorKey) : "invalid";
}

export function UpsConnectionDialog({
    open,
    onOpenChange,
    editing,
    machines,
    offers,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The UPS being changed; null adds a new one. */
    editing: UpsView | null;
    machines: readonly UpsMachine[];
    offers: readonly UsbOffer[];
    onSaved: (id: string) => void;
}) {
    const t = useTranslations("servers");
    const [values, setValues] = useState<FormValues>(() => initialValues(editing, offers));
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<ErrorKey | null>(null);

    const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
        setFailure(null);
        setValues((current) => ({ ...current, [key]: value }));
    };

    const parsed = useMemo(
        () => upsReading.upsConnectionSchema.safeParse(upsReading.normalizeUpsInput(connectionInput(values))),
        [values]
    );
    const errors = useMemo(() => {
        const found = new Map<string, ErrorKey>();
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                const field = String(issue.path[0] ?? "");
                if (!found.has(field)) found.set(field, errorKey(issue.message));
            }
        }
        return found;
    }, [parsed]);

    /** An empty field is unfinished, not wrong: its error waits for a value. */
    const fieldError = (field: keyof FormValues) => {
        const value = values[field];
        if (typeof value === "string" && value.trim() === "") return null;
        const key = errors.get(field);
        return key ? t(`ups.errors.${key}`) : null;
    };

    const machineOptions = machines.map((machine) => ({ value: machine.id, label: machine.name }));
    const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? id;
    const offerOptions = offers.map((offer) => ({
        value: `${offer.machineId}/${offer.deviceId}`,
        label: `${offer.name} (${machineName(offer.machineId)})`
    }));
    const usbLocked = editing?.connection === "usb";
    const keepsSecret = editing !== null && editing.connection === values.connection && editing.hasSecret;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!parsed.success || pending) return;
        setPending(true);
        const input = connectionInput(values);
        const result = editing
            ? await updateUpsConnectionAction(editing.id, input)
            : await createUpsAction(input);
        setPending(false);
        if (!result.ok) {
            setFailure(errorKey(result.error));
            return;
        }
        onSaved(editing ? editing.id : (result.value as string));
        onOpenChange(false);
    }

    const field = (key: keyof FormValues, label: string, props: Record<string, unknown> = {}) => {
        const error = fieldError(key);
        return (
            <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span>{label}</span>
                <Input
                    value={values[key] as string}
                    onChange={(event) => set(key, event.target.value as never)}
                    aria-invalid={error ? true : undefined}
                    {...props}
                />
                {error ? <span className="text-xs text-danger-ink">{error}</span> : null}
            </label>
        );
    };
    const secretField = (key: "password" | "community" | "authPassword" | "privPassword", label: string) =>
        field(key, label, {
            type: "password",
            autoComplete: "new-password",
            placeholder: keepsSecret ? t("ups.form.secretKept") : undefined
        });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{editing ? t("ups.form.titleEdit") : t("ups.form.titleAdd")}</DialogTitle>
                    <DialogDescription>{t("ups.description")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
                    {usbLocked ? null : (
                        <SegmentedControl<Connection>
                            aria-label={t("ups.form.type")}
                            value={values.connection}
                            onValueChange={(value) => set("connection", value)}
                            options={[
                                { value: "usb", label: t("ups.connection.usb") },
                                { value: "nut", label: t("ups.connection.nut") },
                                { value: "snmp", label: t("ups.connection.snmp") }
                            ]}
                        />
                    )}
                    {field("name", `${t("ups.form.name")} *`, { required: true, maxLength: 80 })}

                    {values.connection === "usb" && !usbLocked ? (
                        offers.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("ups.form.noDevices")}</p>
                        ) : (
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span>{t("ups.form.device")} *</span>
                                <Select
                                    aria-label={t("ups.form.device")}
                                    placeholder={t("ups.form.pickDevice")}
                                    value={`${values.machineId}/${values.deviceId}`}
                                    options={offerOptions}
                                    onValueChange={(value) => {
                                        const offer = offers.find(
                                            (one) => `${one.machineId}/${one.deviceId}` === value
                                        );
                                        if (!offer) return;
                                        setValues((current) => ({
                                            ...current,
                                            machineId: offer.machineId,
                                            deviceId: offer.deviceId,
                                            name: current.name || offer.name
                                        }));
                                    }}
                                />
                            </label>
                        )
                    ) : null}

                    {values.connection === "snmp" ? (
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            <span>{t("ups.form.machine")} *</span>
                            <Select
                                aria-label={t("ups.form.machine")}
                                placeholder={t("ups.form.pickMachine")}
                                value={values.machineId}
                                options={machineOptions}
                                onValueChange={(value) => set("machineId", value)}
                            />
                        </label>
                    ) : null}

                    {values.connection !== "usb" ? (
                        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                            {field("host", `${t("ups.form.host")} *`, { placeholder: "192.168.1.20", required: true })}
                            {field("port", t("ups.form.port"), {
                                inputMode: "numeric",
                                placeholder: values.connection === "nut" ? "3493" : "161"
                            })}
                        </div>
                    ) : null}

                    {values.connection === "nut" ? (
                        <>
                            {field("upsName", `${t("ups.form.upsName")} *`, { placeholder: "ups", required: true })}
                            <div className="grid grid-cols-2 gap-2">
                                {field("username", t("ups.form.username"), { autoComplete: "off" })}
                                {secretField("password", t("ups.form.password"))}
                            </div>
                            <p className="text-xs text-muted-foreground">{t("ups.form.nutLoginHint")}</p>
                        </>
                    ) : null}

                    {values.connection === "snmp" ? (
                        <>
                            <SegmentedControl<FormValues["snmpVersion"]>
                                aria-label={t("ups.form.version")}
                                value={values.snmpVersion}
                                onValueChange={(value) => set("snmpVersion", value)}
                                options={[
                                    { value: "v1", label: "v1" },
                                    { value: "v2c", label: "v2c" },
                                    { value: "v3", label: "v3" }
                                ]}
                            />
                            {values.snmpVersion === "v3" ? (
                                <>
                                    {field("username", t("ups.form.username"), { autoComplete: "off" })}
                                    <div className="grid grid-cols-2 gap-2">
                                        {secretField("authPassword", t("ups.form.authPassword"))}
                                        {secretField("privPassword", t("ups.form.privPassword"))}
                                    </div>
                                </>
                            ) : (
                                secretField("community", t("ups.form.community"))
                            )}
                        </>
                    ) : null}

                    {failure ? (
                        <p role="alert" className="text-sm text-danger-ink">
                            {t(`ups.errors.${failure}`)}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("ups.form.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!parsed.success || pending}
                            disabled={pending}
                        >
                            {editing ? t("ups.form.submitEdit") : t("ups.form.submitAdd")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
