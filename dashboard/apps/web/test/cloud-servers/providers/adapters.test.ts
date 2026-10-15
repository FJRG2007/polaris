/**
 * Every provider adapter, against a fake `fetch`: the request each one builds
 * (method, URL, auth header, body) and how it reads the provider's answer. The
 * answers are fixtures shaped like each provider's documented responses. No
 * real provider is called.
 */

import { generateKeyPairSync } from "node:crypto";
import { ProviderError } from "@polaris-app/cloud-servers/src/lib/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapterFor } from "@polaris-app/cloud-servers/src/lib/providers";
import type { ProviderId } from "@polaris-app/cloud-servers/src/lib/providers/types";

interface Seen {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
}

let seen: Seen[] = [];
let answers: { match: RegExp; status?: number; body: unknown; headers?: Record<string, string> }[] =
    [];

beforeEach(() => {
    seen = [];
    answers = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        seen.push({
            url,
            method: init.method ?? "GET",
            headers: (init.headers ?? {}) as Record<string, string>,
            body: init.body as string | undefined
        });
        const index = answers.findIndex((a) => a.match.test(`${init.method ?? "GET"} ${url}`));
        if (index === -1) return new Response("{}", { status: 404 });
        const [answer] = answers.splice(index, 1);
        const text = typeof answer!.body === "string" ? answer!.body : JSON.stringify(answer!.body);
        return new Response(answer!.status === 204 ? null : text, {
            status: answer!.status ?? 200,
            headers: answer!.headers
        });
    });
});

afterEach(() => vi.unstubAllGlobals());

const SCRIPT = "#!/bin/sh\necho fixture\n";
const spec = {
    name: "web-1",
    region: "fixture-region",
    size: "fixture-size",
    image: "fixture-image",
    userData: SCRIPT
};
const adapter = (provider: ProviderId, credentials: object) =>
    adapterFor(provider, JSON.stringify(credentials));

describe("DigitalOcean", () => {
    const creds = { token: "fixture-token" };
    const droplet = {
        id: 101,
        name: "web-1",
        status: "active",
        size_slug: "s-1vcpu-1gb",
        region: { slug: "ams3" },
        networks: {
            v4: [
                { ip_address: "10.0.0.2", type: "private" },
                { ip_address: "203.0.113.5", type: "public" }
            ]
        }
    };

    it("creates a droplet with the user data and reads it back", async () => {
        answers.push({
            match: /^POST https:\/\/api\.digitalocean\.com\/v2\/droplets$/,
            body: { droplet: { ...droplet, status: "new" } }
        });
        const made = await (await adapter("digitalocean", creds)).create(spec);
        expect(seen[0]!.headers.authorization).toBe("Bearer fixture-token");
        expect(JSON.parse(seen[0]!.body!)).toMatchObject({
            name: "web-1",
            user_data: SCRIPT,
            tags: ["polaris"]
        });
        expect(made).toEqual({
            providerId: "101",
            name: "web-1",
            region: "ams3",
            size: "s-1vcpu-1gb",
            status: "creating",
            ipv4: "203.0.113.5"
        });
    });

    it("reads prices from sizes and treats 404 as gone", async () => {
        answers.push({
            match: /sizes/,
            body: {
                sizes: [
                    {
                        slug: "s-1vcpu-1gb",
                        memory: 1024,
                        vcpus: 1,
                        disk: 25,
                        price_monthly: 6,
                        price_hourly: 0.00893,
                        regions: ["ams3"],
                        available: true
                    }
                ]
            }
        });
        answers.push({
            match: /droplets\/9/,
            status: 404,
            body: { id: "not_found", message: "The resource you requested could not be found." }
        });
        const a = await adapter("digitalocean", creds);
        expect(await a.monthlyCost("ams3", "s-1vcpu-1gb")).toMatchObject({
            priceHourly: 0.00893,
            priceMonthly: 6,
            currency: "USD"
        });
        expect(await a.get({ providerId: "9", region: "ams3" })).toBeNull();
    });

    it("sends power and resize as droplet actions", async () => {
        answers.push(
            { match: /actions/, status: 201, body: { action: {} } },
            { match: /actions/, status: 201, body: { action: {} } }
        );
        const a = await adapter("digitalocean", creds);
        await a.action({ providerId: "101", region: "ams3" }, "power_off");
        await a.resize!({ providerId: "101", region: "ams3" }, "s-2vcpu-2gb");
        expect(seen.map((s) => JSON.parse(s.body!))).toEqual([
            { type: "power_off" },
            { type: "resize", size: "s-2vcpu-2gb", disk: false }
        ]);
    });
});

describe("Hetzner Cloud", () => {
    const server = {
        id: 42,
        name: "web-1",
        status: "running",
        server_type: { name: "cx22" },
        datacenter: { location: { name: "fsn1" } },
        public_net: { ipv4: { ip: "203.0.113.6" } }
    };

    it("creates with a label and maps actions to their paths", async () => {
        answers.push({
            match: /^POST .*\/v1\/servers$/,
            status: 201,
            body: { server, action: {}, root_password: "fixture-not-kept" }
        });
        answers.push({ match: /actions\/poweron/, status: 201, body: { action: {} } });
        const a = await adapter("hetzner", { token: "fixture-token" });
        const made = await a.create(spec);
        expect(JSON.parse(seen[0]!.body!)).toMatchObject({
            server_type: "fixture-size",
            location: "fixture-region",
            user_data: SCRIPT
        });
        expect(made).toMatchObject({
            providerId: "42",
            status: "running",
            ipv4: "203.0.113.6",
            region: "fsn1"
        });
        expect(JSON.stringify(made)).not.toContain("fixture-not-kept");
        await a.action({ providerId: "42", region: "fsn1" }, "power_on");
        expect(seen[1]!.url).toBe("https://api.hetzner.cloud/v1/servers/42/actions/poweron");
    });

    it("reads the gross price of the region", async () => {
        answers.push({
            match: /server_types/,
            body: {
                server_types: [
                    {
                        name: "cx22",
                        cores: 2,
                        memory: 4,
                        disk: 40,
                        deprecated: false,
                        prices: [
                            {
                                location: "fsn1",
                                price_hourly: { gross: "0.0071" },
                                price_monthly: { gross: "4.3500" }
                            }
                        ]
                    }
                ]
            }
        });
        expect(
            await (await adapter("hetzner", { token: "t" })).monthlyCost("fsn1", "cx22")
        ).toMatchObject({
            priceHourly: 0.0071,
            priceMonthly: 4.35,
            currency: "EUR"
        });
    });
});

describe("Vultr", () => {
    it("sends the user data base64-encoded and reads the instance", async () => {
        answers.push({
            match: /^POST .*\/v2\/instances$/,
            status: 202,
            body: {
                instance: {
                    id: "fixture-uuid",
                    label: "web-1",
                    main_ip: "0.0.0.0",
                    status: "pending",
                    power_status: "running",
                    region: "ams",
                    plan: "vc2-1c-1gb"
                }
            }
        });
        const made = await (
            await adapter("vultr", { token: "t" })
        ).create({ ...spec, image: "2284" });
        const body = JSON.parse(seen[0]!.body!);
        expect(Buffer.from(body.user_data, "base64").toString()).toBe(SCRIPT);
        expect(body.os_id).toBe(2284);
        expect(made).toMatchObject({ status: "creating", ipv4: null });
    });
});

describe("Linode", () => {
    it("sends metadata user data and a root password it never returns", async () => {
        answers.push({
            match: /^POST .*\/linode\/instances$/,
            body: {
                id: 7,
                label: "web-1",
                status: "provisioning",
                region: "nl-ams",
                type: "g6-nanode-1",
                ipv4: ["192.168.1.2", "203.0.113.7"]
            }
        });
        const made = await (await adapter("linode", { token: "t" })).create(spec);
        const body = JSON.parse(seen[0]!.body!);
        expect(Buffer.from(body.metadata.user_data, "base64").toString()).toBe(SCRIPT);
        expect(body.root_pass.length).toBeGreaterThan(20);
        expect(made).toEqual({
            providerId: "7",
            name: "web-1",
            region: "nl-ams",
            size: "g6-nanode-1",
            status: "creating",
            ipv4: "203.0.113.7"
        });
    });
});

describe("AWS EC2", () => {
    const creds = { accessKeyId: "AKIDEXAMPLEFIXTURE", secretAccessKey: "fixture/secret" };
    const instanceXml = `<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><instancesSet><item>
        <instanceId>i-0123456789abcdef0</instanceId><instanceState><code>0</code><name>pending</name></instanceState>
        <instanceType>t3.micro</instanceType><placement><availabilityZone>eu-west-1b</availabilityZone></placement>
        <tagSet><item><key>Name</key><value>web-1</value></item></tagSet></item></instancesSet></RunInstancesResponse>`;

    it("signs a form-encoded RunInstances and reads the XML answer", async () => {
        answers.push({
            match: /ec2\.eu-west-1/,
            body: "<DescribeSecurityGroupsResponse><securityGroupInfo><item><groupId>sg-0fixture</groupId></item></securityGroupInfo></DescribeSecurityGroupsResponse>"
        });
        answers.push({ match: /ec2\.eu-west-1/, body: instanceXml });
        const made = await (
            await adapter("aws", creds)
        ).create({ ...spec, region: "eu-west-1", size: "t3.micro", image: "ami-0fixture" });
        const run = new URLSearchParams(seen[1]!.body!);
        expect(run.get("Action")).toBe("RunInstances");
        expect(run.get("Version")).toBe("2016-11-15");
        expect(run.get("SecurityGroupId.1")).toBe("sg-0fixture");
        expect(Buffer.from(run.get("UserData")!, "base64").toString()).toBe(SCRIPT);
        expect(seen[1]!.headers.authorization).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLEFIXTURE\/\d{8}\/eu-west-1\/ec2\/aws4_request, /
        );
        expect(seen[1]!.headers.host).toBeUndefined();
        expect(made).toEqual({
            providerId: "i-0123456789abcdef0",
            name: "web-1",
            region: "eu-west-1",
            size: "t3.micro",
            status: "creating",
            ipv4: null
        });
    });

    it("refuses an unknown region before calling anything", async () => {
        const a = await adapter("aws", creds);
        await expect(
            a.get({ providerId: "i-0123456789abcdef0", region: "../evil" })
        ).rejects.toBeInstanceOf(ProviderError);
        expect(seen).toHaveLength(0);
    });
});

describe("Azure", () => {
    const creds = {
        tenantId: "00000000-0000-4000-8000-000000000001",
        clientId: "00000000-0000-4000-8000-000000000002",
        clientSecret: "fixture-secret",
        subscriptionId: "00000000-0000-4000-8000-000000000003"
    };

    it("gets a client-credentials token, then reads a VM and its address", async () => {
        answers.push({
            match: /login\.microsoftonline\.com/,
            body: { access_token: "fixture-access", expires_in: 3599, token_type: "Bearer" }
        });
        answers.push({
            match: /virtualMachines\/web-1\?\$expand=instanceView/,
            body: {
                name: "web-1",
                location: "westeurope",
                properties: {
                    provisioningState: "Succeeded",
                    hardwareProfile: { vmSize: "Standard_B1s" },
                    instanceView: {
                        statuses: [
                            { code: "ProvisioningState/succeeded" },
                            { code: "PowerState/deallocated" }
                        ]
                    }
                }
            }
        });
        answers.push({
            match: /publicIPAddresses\/web-1-ip/,
            body: { properties: { ipAddress: "203.0.113.8" } }
        });
        const vm = await (
            await adapter("azure", creds)
        ).get({ providerId: "westeurope/web-1", region: "westeurope" });
        const token = new URLSearchParams(seen[0]!.body!);
        expect(token.get("grant_type")).toBe("client_credentials");
        expect(token.get("scope")).toBe("https://management.azure.com/.default");
        expect(seen[1]!.headers.authorization).toBe("Bearer fixture-access");
        expect(vm).toEqual({
            providerId: "westeurope/web-1",
            name: "web-1",
            region: "westeurope",
            size: "Standard_B1s",
            status: "off",
            ipv4: "203.0.113.8"
        });
    });

    it("reads the Linux pay-as-you-go hourly price from the retail prices API", async () => {
        answers.push({
            match: /prices\.azure\.com/,
            body: {
                Items: [
                    {
                        retailPrice: 0.02,
                        unitOfMeasure: "1 Hour",
                        currencyCode: "USD",
                        productName: "Virtual Machines BS Series Windows",
                        skuName: "B1s"
                    },
                    {
                        retailPrice: 0.002,
                        unitOfMeasure: "1 Hour",
                        currencyCode: "USD",
                        productName: "Virtual Machines BS Series",
                        skuName: "B1s Spot"
                    },
                    {
                        retailPrice: 0.0104,
                        unitOfMeasure: "1 Hour",
                        currencyCode: "USD",
                        productName: "Virtual Machines BS Series",
                        skuName: "B1s"
                    }
                ]
            }
        });
        expect(
            await (await adapter("azure", creds)).monthlyCost("westeurope", "Standard_B1s")
        ).toMatchObject({ priceHourly: 0.0104, currency: "USD" });
        expect(decodeURIComponent(seen[0]!.url)).toContain("armSkuName eq 'Standard_B1s'");
        expect(await (await adapter("azure", creds)).monthlyCost("west'europe", "x")).toBeNull();
    });
});

describe("Google Compute Engine", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const creds = {
        serviceAccountJson: JSON.stringify({
            type: "service_account",
            project_id: "fixture-project",
            client_email: "fixture@fixture-project.iam.gserviceaccount.com",
            private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
        })
    };

    it("exchanges a JWT for a token and creates with a startup script", async () => {
        answers.push({
            match: /oauth2\.googleapis\.com/,
            body: { access_token: "fixture-access", expires_in: 3599, token_type: "Bearer" }
        });
        answers.push({ match: /instances$/, body: { kind: "compute#operation" } });
        const made = await (
            await adapter("gcp", creds)
        ).create({
            ...spec,
            region: "europe-west1-b",
            size: "e2-small",
            image: "projects/debian-cloud/global/images/family/debian-12"
        });
        expect(new URLSearchParams(seen[0]!.body!).get("grant_type")).toBe(
            "urn:ietf:params:oauth:grant-type:jwt-bearer"
        );
        expect(seen[1]!.url).toBe(
            "https://compute.googleapis.com/compute/v1/projects/fixture-project/zones/europe-west1-b/instances"
        );
        expect(JSON.parse(seen[1]!.body!).metadata).toEqual({
            items: [{ key: "startup-script", value: SCRIPT }]
        });
        expect(made.status).toBe("creating");
    });

    it("refuses a key file that is not a service account", async () => {
        await expect(
            adapter("gcp", { serviceAccountJson: '{"type":"user"}' })
        ).rejects.toBeInstanceOf(ProviderError);
    });
});

describe("IONOS Cloud", () => {
    it("reuses its data center and public LAN, and creates the server with its disk and NIC", async () => {
        answers.push({
            match: /GET .*\/datacenters\?depth=1/,
            body: {
                items: [
                    {
                        id: "dc-fixture",
                        properties: { name: "polaris-cloud-servers-de-fra", location: "de/fra" }
                    }
                ]
            }
        });
        answers.push({
            match: /lans\?depth=1/,
            body: { items: [{ id: "1", properties: { public: true } }] }
        });
        answers.push({
            match: /POST .*\/datacenters\/dc-fixture\/servers$/,
            status: 202,
            body: { id: "srv-fixture" }
        });
        const made = await (
            await adapter("ionos", { token: "fixture-token" })
        ).create({
            ...spec,
            region: "de/fra",
            size: "2c-4gb",
            image: "ubuntu:latest"
        });
        const body = JSON.parse(seen[2]!.body!);
        expect(body.properties).toEqual({ name: "web-1", cores: 2, ram: 4096 });
        expect(body.entities.volumes.items[0].properties).toMatchObject({
            imageAlias: "ubuntu:latest",
            size: 20
        });
        expect(
            Buffer.from(body.entities.volumes.items[0].properties.userData, "base64").toString()
        ).toBe(SCRIPT);
        expect(body.entities.nics.items[0].properties).toEqual({
            name: "public",
            lan: 1,
            dhcp: true
        });
        expect(made).toMatchObject({ providerId: "dc-fixture/srv-fixture", status: "creating" });
    });
});

describe("rate limits", () => {
    it("waits and retries a 429, then gives up with the provider's sentence", async () => {
        answers.push({
            match: /regions/,
            status: 429,
            body: { message: "Too many requests" },
            headers: { "retry-after": "0" }
        });
        answers.push({
            match: /regions/,
            status: 429,
            body: { message: "Too many requests" },
            headers: { "retry-after": "0" }
        });
        answers.push({
            match: /regions/,
            status: 429,
            body: { message: "Too many requests" },
            headers: { "retry-after": "0" }
        });
        const error = await (await adapter("digitalocean", { token: "t" }))
            .listRegions()
            .catch((e: unknown) => e);
        expect(seen).toHaveLength(3);
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).message).toBe("429: Too many requests");
    });
});
