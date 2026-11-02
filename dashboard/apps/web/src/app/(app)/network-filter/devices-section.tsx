"use client";

/**
 * The Network filter's Devices: names for the addresses in the log, and groups of
 * devices with lists of their own.
 */

import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    SearchableSelect,
    Switch
} from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { RuleField, serviceName, lines, rejected } from "./fields";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import { DnsNetworkCard } from "./network-card";
import { DnsSaveBar } from "./save-bar";

/** The field a device seen on the network is named in. */
const DEVICE_NAME_FIELD = "dns-device-name";

/** Addresses, a range and a name pattern, as typed into a group. */
const GROUP_CLIENTS_EXAMPLE = "192.168.1.20\n192.168.1.64/26\nkids-*"; // i18n-ignore example values

export function DnsDevicesSection() {
    const t = useTranslations("dnsBlocker");
    const [devices, setDevices] = useField("devices");
    const [clientGroups, setClientGroups] = useField("clientGroups");
    const [deviceName, setDeviceName] = useState("");
    const [deviceAddress, setDeviceAddress] = useState("");
    const { status } = useDnsBlocker();
    const nameDevice = (address: string) => {
        setDeviceAddress(address);
        const field = document.getElementById(DEVICE_NAME_FIELD);
        field?.scrollIntoView({ block: "center", behavior: "smooth" });
        field?.focus({ preventScroll: true });
    };
    const [groupName, setGroupName] = useState("");
    const [groupClients, setGroupClients] = useState("");
    const [groupCategories, setGroupCategories] = useState<dns.DnsCategory[]>([]);
    const [groupServices, setGroupServices] = useState<string[]>([]);
    const newDevice = dns.dnsDeviceSchema.safeParse({ name: deviceName, address: deviceAddress });
    const deviceIssue = newDevice.success
        ? null
        : (newDevice.error.issues.find((issue) =>
              issue.path[0] === "name" ? deviceName.trim() !== "" : deviceAddress.trim() !== ""
          )?.message ?? null);
    const badGroupClients = rejected(groupClients, dns.normalizeDnsClient);
    const newGroup = dns.dnsClientGroupSchema.safeParse({
        name: groupName,
        clients: lines(groupClients),
        categories: groupCategories,
        services: groupServices
    });

    return (
        <div className="flex flex-col gap-4">
            {status?.state === "blocking" ? <DnsNetworkCard onName={nameDevice} /> : null}
            <Card>
                <CardHeader>
                    <CardTitle>{t("devices.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("devices.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {devices.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
                    ) : (
                        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {devices.map((device, index) => (
                                <li
                                    key={`${device.name}-${device.address}-${index}`}
                                    className="flex min-w-0 items-center gap-2 rounded-md bg-muted p-2 text-sm"
                                >
                                    <span className="min-w-0 flex-1 break-all font-medium">
                                        {device.name}
                                    </span>
                                    <span className="min-w-0 break-all text-xs text-muted-foreground">
                                        {device.address}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`${t("devices.remove")}: ${device.name}`}
                                        title={t("devices.remove")}
                                        onClick={() =>
                                            setDevices((current) =>
                                                current.filter((_, at) => at !== index)
                                            )
                                        }
                                    >
                                        <Trash2 />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <Input
                            id={DEVICE_NAME_FIELD}
                            className="sm:w-56"
                            value={deviceName}
                            placeholder={t("devices.namePlaceholder")}
                            aria-label={t("devices.name")}
                            aria-invalid={deviceIssue === "invalidDeviceName"}
                            onChange={(event) => setDeviceName(event.target.value)}
                        />
                        <Input
                            className="sm:w-56"
                            value={deviceAddress}
                            placeholder="192.168.1.20"
                            aria-label={t("devices.address")}
                            aria-invalid={deviceIssue === "invalidDeviceAddress"}
                            onChange={(event) => setDeviceAddress(event.target.value)}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={
                                !newDevice.success || devices.length >= dns.DNS_LIMITS.devices
                            }
                            onClick={() => {
                                if (!newDevice.success) return;
                                setDevices((current) => [...current, newDevice.data]);
                                setDeviceName("");
                                setDeviceAddress("");
                            }}
                        >
                            <Plus />
                            {t("devices.add")}
                        </Button>
                    </div>
                    {deviceIssue ? (
                        <span className="text-xs text-danger-ink">
                            {deviceIssue === "invalidDeviceName"
                                ? t("validation.invalidDeviceName")
                                : t("validation.invalidDeviceAddress")}
                        </span>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("groups.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("groups.intro")}</p>
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
                    <div className="flex flex-col gap-2">
                        <Input
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
                        <div>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                    !newGroup.success ||
                                    clientGroups.length >= dns.DNS_LIMITS.clientGroups
                                }
                                onClick={() => {
                                    if (!newGroup.success) return;
                                    setClientGroups((current) => [...current, newGroup.data]);
                                    setGroupName("");
                                    setGroupClients("");
                                    setGroupCategories([]);
                                    setGroupServices([]);
                                }}
                            >
                                <Plus />
                                {t("groups.add")}
                            </Button>
                        </div>
                    </div>
                </CardBody>
            </Card>
            <DnsSaveBar />
        </div>
    );
}
