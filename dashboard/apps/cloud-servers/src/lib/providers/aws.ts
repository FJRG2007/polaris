/**
 * AWS EC2, through the EC2 Query API signed with Signature Version 4.
 *
 * API reference: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Welcome.html
 *   Actions used (Version 2016-11-15): DescribeRegions, DescribeInstanceTypes,
 *   DescribeImages, DescribeSecurityGroups, CreateSecurityGroup,
 *   AuthorizeSecurityGroupIngress, RunInstances, DescribeInstances,
 *   StartInstances, StopInstances, RebootInstances, ModifyInstanceAttribute,
 *   TerminateInstances.
 * Query parameters: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Query-Requests.html
 * Image owners: Canonical 099720109477, Debian 136693071363 (the IDs each
 * publisher documents for its official AMIs).
 *
 * Prices: the Price List Query API, one filtered GetProducts call per type and
 * region (see `pricing/aws-pricing.ts`).
 */

import { z } from "zod";
import { signV4 } from "../auth/sigv4";
import { awsHourlyPrice } from "../pricing/aws-pricing";
import { parseWith, send, ProviderError } from "../http";
import { child, items, parseXml, textOf, type XmlNode } from "../xml";
import type { CloudMachine, Credentials, MachineStatus, ProviderAdapter } from "./types";

const VERSION = "2016-11-15";
const DEFAULT_REGION = "us-east-1";
const SECURITY_GROUP = "polaris-cloud-servers";

const IMAGES: readonly { owner: string; pattern: string; label: string }[] = [
    {
        owner: "099720109477",
        pattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
        label: "Ubuntu 24.04 LTS"
    },
    {
        owner: "099720109477",
        pattern: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
        label: "Ubuntu 22.04 LTS"
    },
    { owner: "136693071363", pattern: "debian-12-amd64-*", label: "Debian 12" }
];

const STATUS: Readonly<Record<string, MachineStatus>> = {
    pending: "creating",
    running: "running",
    "shutting-down": "transitioning",
    stopping: "transitioning",
    stopped: "off",
    terminated: "failed"
};

const instanceSchema = z.object({
    instanceId: z.string().regex(/^i-[0-9a-f]+$/),
    state: z.string(),
    instanceType: z.string(),
    ipAddress: z.string().nullable(),
    availabilityZone: z.string(),
    name: z.string()
});

/** One instance element, as the schema above reads it. */
export function readInstance(node: XmlNode): z.infer<typeof instanceSchema> {
    const tags = items(node, "tagSet");
    return parseWith(instanceSchema, {
        instanceId: textOf(node, "instanceId"),
        state: textOf(child(node, "instanceState"), "name"),
        instanceType: textOf(node, "instanceType"),
        ipAddress: textOf(node, "ipAddress"),
        availabilityZone: textOf(child(node, "placement"), "availabilityZone"),
        name:
            textOf(
                tags.find((t) => textOf(t, "key") === "Name"),
                "value"
            ) ?? ""
    });
}

function machine(i: z.infer<typeof instanceSchema>): CloudMachine {
    return {
        providerId: i.instanceId,
        name: i.name,
        region: i.availabilityZone.replace(/[a-z]$/, ""),
        size: i.instanceType,
        status: STATUS[i.state] ?? "unknown",
        ipv4: i.ipAddress
    };
}

/** The form body of one action, parameters in the order given. */
export function queryBody(action: string, params: Readonly<Record<string, string>>): string {
    return new URLSearchParams({ Action: action, Version: VERSION, ...params }).toString();
}

export function createAdapter(credentials: Credentials<"aws">): ProviderAdapter {
    async function call(
        region: string,
        action: string,
        params: Record<string, string> = {}
    ): Promise<XmlNode> {
        if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
            throw new ProviderError("Unknown AWS region.", null);
        const url = `https://ec2.${region}.amazonaws.com/`;
        const body = queryBody(action, params);
        const headers = signV4({
            method: "POST",
            url,
            headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
            body,
            service: "ec2",
            region,
            credentials,
            now: new Date()
        });
        const { host: _host, ...sent } = headers;
        const response = await send(url, { method: "POST", headers: sent, body });
        try {
            return parseXml(await response.text());
        } catch {
            throw new ProviderError("AWS answered with a document Polaris could not read.", null);
        }
    }

    async function securityGroup(region: string): Promise<string> {
        const found = await call(region, "DescribeSecurityGroups", {
            "Filter.1.Name": "group-name",
            "Filter.1.Value.1": SECURITY_GROUP
        });
        const existing = textOf(items(found, "securityGroupInfo")[0], "groupId");
        if (existing) return existing;
        const created = await call(region, "CreateSecurityGroup", {
            GroupName: SECURITY_GROUP,
            GroupDescription: "SSH for servers Polaris created and enrolled"
        });
        const groupId = textOf(created, "groupId");
        if (!groupId)
            throw new ProviderError("AWS did not return the security group it created.", null);
        // Polaris connects over SSH with a key only; password logins are off on
        // these images.
        await call(region, "AuthorizeSecurityGroupIngress", {
            GroupId: groupId,
            "IpPermissions.1.IpProtocol": "tcp",
            "IpPermissions.1.FromPort": "22",
            "IpPermissions.1.ToPort": "22",
            "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0"
        });
        return groupId;
    }

    const ids = (ref: { providerId: string }) => ({ "InstanceId.1": ref.providerId });

    return {
        async listRegions() {
            const root = await call(DEFAULT_REGION, "DescribeRegions");
            return items(root, "regionInfo")
                .map((r) => textOf(r, "regionName"))
                .filter((name): name is string => !!name)
                .sort()
                .map((name) => ({ id: name, label: name }));
        },
        async listSizes(region) {
            const root = await call(region, "DescribeInstanceTypes", {
                "Filter.1.Name": "current-generation",
                "Filter.1.Value.1": "true",
                "Filter.2.Name": "processor-info.supported-architecture",
                "Filter.2.Value.1": "x86_64",
                MaxResults: "100"
            });
            return items(root, "instanceTypeSet")
                .map((t) => ({
                    id: textOf(t, "instanceType") ?? "",
                    vcpus: textOf(child(t, "vCpuInfo"), "defaultVCpus"),
                    memory: Number(textOf(child(t, "memoryInfo"), "sizeInMiB") ?? 0)
                }))
                .filter((t) => t.id)
                .sort((a, b) => a.memory - b.memory)
                .map((t) => ({
                    id: t.id,
                    label: `${t.id} (${t.vcpus} vCPU, ${Math.round(t.memory / 102.4) / 10} GB RAM)`,
                    priceHourly: null,
                    priceMonthly: null,
                    currency: null
                }));
        },
        async listImages(region) {
            const found = await Promise.all(
                IMAGES.map(async (image) => {
                    const root = await call(region, "DescribeImages", {
                        "Owner.1": image.owner,
                        "Filter.1.Name": "name",
                        "Filter.1.Value.1": image.pattern,
                        "Filter.2.Name": "state",
                        "Filter.2.Value.1": "available"
                    });
                    const newest = items(root, "imagesSet")
                        .map((i) => ({
                            id: textOf(i, "imageId"),
                            created: textOf(i, "creationDate") ?? ""
                        }))
                        .filter((i): i is { id: string; created: string } => !!i.id)
                        .sort((a, b) => b.created.localeCompare(a.created))[0];
                    return newest ? { id: newest.id, label: image.label } : null;
                })
            );
            return found.filter((i): i is { id: string; label: string } => i !== null);
        },
        async create(spec) {
            const groupId = await securityGroup(spec.region);
            const root = await call(spec.region, "RunInstances", {
                ImageId: spec.image,
                InstanceType: spec.size,
                MinCount: "1",
                MaxCount: "1",
                UserData: Buffer.from(spec.userData).toString("base64"),
                "SecurityGroupId.1": groupId,
                "TagSpecification.1.ResourceType": "instance",
                "TagSpecification.1.Tag.1.Key": "Name",
                "TagSpecification.1.Tag.1.Value": spec.name,
                "TagSpecification.1.Tag.2.Key": "polaris",
                "TagSpecification.1.Tag.2.Value": "cloud-servers"
            });
            const [node] = items(root, "instancesSet");
            if (!node) throw new ProviderError("AWS did not return the instance it started.", null);
            return machine(readInstance(node));
        },
        async get(ref) {
            try {
                const root = await call(ref.region, "DescribeInstances", ids(ref));
                const node = items(items(root, "reservationSet")[0], "instancesSet")[0];
                return node ? machine(readInstance(node)) : null;
            } catch (caught) {
                if (caught instanceof ProviderError && /InvalidInstanceID/.test(caught.message))
                    return null;
                throw caught;
            }
        },
        async action(ref, action) {
            const verb =
                action === "power_on"
                    ? "StartInstances"
                    : action === "power_off"
                      ? "StopInstances"
                      : "RebootInstances";
            await call(ref.region, verb, ids(ref));
        },
        async resize(ref, size) {
            await call(ref.region, "ModifyInstanceAttribute", {
                InstanceId: ref.providerId,
                "InstanceType.Value": size
            });
        },
        async destroy(ref) {
            await call(ref.region, "TerminateInstances", ids(ref));
        },
        async monthlyCost(region, size) {
            const hourly = await awsHourlyPrice(credentials, size, region);
            return hourly === null
                ? null
                : {
                      id: size,
                      label: size,
                      priceHourly: hourly,
                      priceMonthly: null,
                      currency: "USD"
                  };
        }
    };
}
