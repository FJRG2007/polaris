"use client";

/**
 * The Network filter's Devices: names for the addresses in the log, and groups of
 * devices with lists of their own. Each list adds through its header button and
 * a dialog, the way every list screen does.
 */

import { Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    SearchableSelect,
    Switch,
    useResetOnOpen
} from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { RuleField, serviceName, lines, rejected } from "./fields";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import { DnsNetworkCard } from "./network-card";
import { DnsSaveBar } from "./save-bar";

/** Addresses, a range and a name pattern, as typed into a group. */
const GROUP_CLIENTS_EXAMPLE = "192.168.1.20\n192.168.1.64/26\nkids-*"; // i18n-ignore example values

export function DnsDevicesSection() {
    const t = useTranslations("dnsBlocker");
    const [devices, setDevices] = useField("devices");
    const [clientGroups, setClientGroups] = useField("clientGroups");
    const { status } = useDnsBlocker();
    /** The address the device dialog opens with, or null while it is closed. */
    const [naming, setNaming] = useState<string | null>(null);
    const [grouping, setGrouping] = useState(false);
    const devicesFull = devices.length >= dns.DNS_LIMITS.devices;
    const groupsFull = clientGroups.length >= dns.DNS_LIMITS.clientGroups;

    return (
        <div className="flex flex-col gap-4">
            {status?.state === "blocking" ? <DnsNetworkCard onName={(address) => setNaming(address)} /> : null}
            <Card>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle>{t("devices.title")}</CardTitle>
                        <p className="text-xs text-muted-foreground">{t("devices.intro")}</p>
                    </div>
                    <Button
                        size="sm"
                        disabled={devicesFull}
                        title={devicesFull ? t("devices.full") : undefined}
                        onClick={() => setNaming("")}
                    >
                        <Plus className="size-4" />
                        {t("devices.addDevice")}
                    </Button>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {devices.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
                    ) : (
                        <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                                    <tr>
                                        <th scope="col" className="w-1/2 px-3 py-2 text-start font-medium">
                                            {t("devices.name")}
                                        </th>
                                        <th scope="col" className="w-1/2 px-3 py-2 text-start font-medium">
                                            {t("devices.address")}
                                        </th>
                                        <th scope="col" className="px-3 py-2">
                                            <span className="sr-only">{t("devices.actions")}</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {devices.map((device, index) => (
                                        <tr key={`${device.name}-${device.address}-${index}`} className="border-t border-border">
                                            <td className="max-w-0 px-3 py-2 align-middle">
                                                <span className="block truncate font-medium" title={device.name}>
                                                    {device.name}
                                                </span>
                                            </td>
                                            <td className="max-w-0 px-3 py-2 align-middle">
                                                <span className="block truncate text-xs text-muted-foreground" title={device.address}>
                                                    {device.address}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 align-middle">
                                                <span className="flex justify-end">
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        aria-label={`${t("devices.remove")}: ${device.name}`}
                                                        title={t("devices.remove")}
                                                        onClick={() =>
                                                            setDevices((current) => current.filter((_, at) => at !== index))
                                                        }
                                                    >
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle>{t("groups.title")}</CardTitle>
                        <p className="text-xs text-muted-foreground">{t("groups.intro")}</p>
                    </div>
                    <Button
                        size="sm"
                        disabled={groupsFull}
                        title={groupsFull ? t("devices.full") : undefined}
                        onClick={() => setGrouping(true)}
                    >
                        <Plus className="size-4" />
                        {t("groups.add")}
                    </Button>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {clientGroups.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("groups.empty")}</p>
                    ) : null}
                    {clientGroups.map((group, index) => (
                        <div
                            key={`${group.name}-${index}`}
                            className="flex min-w-0 items-start gap-2 rounded-md bg-muted p-2 text-sm"
                        >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate font-medium" title={group.name}>
                                    {group.name}
                                </span>
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={group.clients.join(", ")}
                                >
                                    {group.clients.join(", ")}
                                </span>
                                <span className="truncate text-xs">
                                    {group.categories.length + group.services.length === 0
                                        ? t("groups.nothing")
                                        : [
                                              ...group.categories.map((category) =>
                                                  t(`categories.${category}`)
                                              ),
                                              ...group.services.map(serviceName)
                                          ].join(", ")}
                                </span>
                            </div>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t("groups.remove")}
                                title={t("groups.remove")}
                                onClick={() =>
                                    setClientGroups((current) =>
                                        current.filter((_, at) => at !== index)
                                    )
                                }
                            >
                                <Trash2 />
                            </Button>
                        </div>
                    ))}
                </CardBody>
            </Card>
            <DeviceDialog
                address={naming}
                onClose={() => setNaming(null)}
                onAdd={(device) => setDevices((current) => [...current, device])}
            />
            <GroupDialog
                open={grouping}
                onClose={() => setGrouping(false)}
                onAdd={(group) => setClientGroups((current) => [...current, group])}
            />
            <DnsSaveBar />
        </div>
    );
}

/** Names one device; `address` is what it opens with (from the network card), null while closed. */
function DeviceDialog({
    address,
    onClose,
    onAdd
}: {
    address: string | null;
    onClose: () => void;
    onAdd: (device: dns.DnsDevice) => void;
}) {
    const t = useTranslations("dnsBlocker");
    const [deviceName, setDeviceName] = useState("");
    const [deviceAddress, setDeviceAddress] = useState("");
    const [openedWith, setOpenedWith] = useState<string | null>(null);
    if (address !== openedWith) {
        setOpenedWith(address);
        if (address !== null) {
            setDeviceName("");
            setDeviceAddress(address);
        }
    }
    const newDevice = dns.dnsDeviceSchema.safeParse({ name: deviceName, address: deviceAddress });
    const deviceIssue = newDevice.success
        ? null
        : (newDevice.error.issues.find((issue) =>
              issue.path[0] === "name" ? deviceName.trim() !== "" : deviceAddress.trim() !== ""
          )?.message ?? null);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!newDevice.success) return;
        onAdd(newDevice.data);
        onClose();
    };

    return (
        <Dialog open={address !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("devices.addTitle")}</DialogTitle>
                    <DialogDescription>{t("devices.intro")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={submit}>
                    <Input
                        autoFocus={address === ""}
                        value={deviceName}
                        placeholder={t("devices.namePlaceholder")}
                        aria-label={t("devices.name")}
                        aria-invalid={deviceIssue === "invalidDeviceName"}
                        onChange={(event) => setDeviceName(event.target.value)}
                    />
                    <Input
                        value={deviceAddress}
                        placeholder="192.168.1.20"
                        aria-label={t("devices.address")}
                        aria-invalid={deviceIssue === "invalidDeviceAddress"}
                        onChange={(event) => setDeviceAddress(event.target.value)}
                    />
                    {deviceIssue ? (
                        <span className="text-xs text-danger-ink">
                            {deviceIssue === "invalidDeviceName"
                                ? t("validation.invalidDeviceName")
                                : t("validation.invalidDeviceAddress")}
                        </span>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("devices.cancel")}
                        </Button>
                        <Button type="submit" disabled={!newDevice.success}>
                            {t("devices.add")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** A new device group: its name, its devices, and what it blocks. */
function GroupDialog({
    open,
    onClose,
    onAdd
}: {
    open: boolean;
    onClose: () => void;
    onAdd: (group: dns.DnsClientGroup) => void;
}) {
    const t = useTranslations("dnsBlocker");
    const [groupName, setGroupName] = useState("");
    const [groupClients, setGroupClients] = useState("");
    const [groupCategories, setGroupCategories] = useState<dns.DnsCategory[]>([]);
    const [groupServices, setGroupServices] = useState<string[]>([]);
    useResetOnOpen(open, () => {
        setGroupName("");
        setGroupClients("");
        setGroupCategories([]);
        setGroupServices([]);
    });
    const badGroupClients = rejected(groupClients, dns.normalizeDnsClient);
    const newGroup = dns.dnsClientGroupSchema.safeParse({
        name: groupName,
        clients: lines(groupClients),
        categories: groupCategories,
        services: groupServices
    });

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!newGroup.success) return;
        onAdd(newGroup.data);
        setGroupName("");
        setGroupClients("");
        setGroupCategories([]);
        setGroupServices([]);
        onClose();
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("groups.addTitle")}</DialogTitle>
                    <DialogDescription>{t("groups.intro")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={submit}>
                    <Input
                        autoFocus
                        value={groupName}
                        placeholder={t("groups.namePlaceholder")}
                        aria-label={t("groups.name")}
                        onChange={(event) => setGroupName(event.target.value)}
                    />
                    <RuleField
                        label={t("groups.clients")}
                        value={groupClients}
                        onChange={setGroupClients}
                        bad={badGroupClients}
                        badText={t("validation.invalidClient")}
                        placeholder={GROUP_CLIENTS_EXAMPLE}
                    />
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {dns.DNS_CATEGORIES.map((category) => (
                            <label key={category} className="flex items-center gap-2 text-sm">
                                <Switch
                                    checked={groupCategories.includes(category)}
                                    onChange={(on: boolean) =>
                                        setGroupCategories((current) =>
                                            on
                                                ? [...current, category]
                                                : current.filter((item) => item !== category)
                                        )
                                    }
                                />
                                <span>{t(`categories.${category}`)}</span>
                            </label>
                        ))}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <SearchableSelect
                            className="w-full sm:w-64"
                            value=""
                            placeholder={t("groups.addService")}
                            aria-label={t("groups.addService")}
                            searchPlaceholder={t("services.search")}
                            emptyText={t("services.none")}
                            onValueChange={(id) =>
                                setGroupServices((current) =>
                                    current.includes(id) ? current : [...current, id]
                                )
                            }
                            options={dns.DNS_SERVICES.filter(
                                (service) => !groupServices.includes(service.id)
                            ).map((service) => ({ value: service.id, label: service.name }))}
                        />
                        {groupServices.map((id) => (
                            <Button
                                key={id}
                                type="button"
                                size="xs"
                                variant="secondary"
                                aria-label={t("groups.removeService", {
                                    name: serviceName(id)
                                })}
                                title={t("groups.removeService", { name: serviceName(id) })}
                                onClick={() =>
                                    setGroupServices((current) =>
                                        current.filter((item) => item !== id)
                                    )
                                }
                            >
                                {serviceName(id)}
                                <X />
                            </Button>
                        ))}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("devices.cancel")}
                        </Button>
                        <Button type="submit" disabled={!newGroup.success}>
                            {t("groups.add")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
