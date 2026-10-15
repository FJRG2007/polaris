/**
 * The one shape every provider is driven through, and the credentials each one
 * takes. Types and schemas only, so the screens and the form validation can use
 * them without loading any adapter.
 */

import { z } from "zod";

export const PROVIDERS = ["digitalocean", "hetzner", "vultr", "linode", "aws", "azure", "gcp", "ionos"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
    digitalocean: "DigitalOcean",
    hetzner: "Hetzner Cloud",
    vultr: "Vultr",
    linode: "Linode (Akamai)",
    aws: "AWS EC2",
    azure: "Microsoft Azure",
    gcp: "Google Compute Engine",
    ionos: "IONOS Cloud"
};

const secret = (max = 4096) => z.string().trim().min(1).max(max);

/** What each provider's account is connected with. */
export const credentialSchemas = {
    digitalocean: z.object({ token: secret(200) }),
    hetzner: z.object({ token: secret(200) }),
    vultr: z.object({ token: secret(200) }),
    linode: z.object({ token: secret(200) }),
    aws: z.object({
        accessKeyId: z.string().trim().regex(/^[A-Z0-9]{16,128}$/),
        secretAccessKey: secret(128)
    }),
    azure: z.object({
        tenantId: z.string().trim().uuid(),
        clientId: z.string().trim().uuid(),
        clientSecret: secret(512),
        subscriptionId: z.string().trim().uuid()
    }),
    gcp: z.object({ serviceAccountJson: secret(12_000) }),
    ionos: z.object({ token: secret(4096) })
} as const satisfies Record<ProviderId, z.ZodTypeAny>;

export type Credentials<P extends ProviderId> = z.infer<(typeof credentialSchemas)[P]>;

/** The fields each provider's form asks for, in order. */
export const CREDENTIAL_FIELDS: Readonly<Record<ProviderId, readonly { key: string; secret: boolean; multiline?: boolean }[]>> = {
    digitalocean: [{ key: "token", secret: true }],
    hetzner: [{ key: "token", secret: true }],
    vultr: [{ key: "token", secret: true }],
    linode: [{ key: "token", secret: true }],
    aws: [
        { key: "accessKeyId", secret: false },
        { key: "secretAccessKey", secret: true }
    ],
    azure: [
        { key: "tenantId", secret: false },
        { key: "subscriptionId", secret: false },
        { key: "clientId", secret: false },
        { key: "clientSecret", secret: true }
    ],
    gcp: [{ key: "serviceAccountJson", secret: true, multiline: true }],
    ionos: [{ key: "token", secret: true }]
};

/** Which providers let a server change size, and whether it must be off first. */
export const RESIZE: Readonly<Record<ProviderId, "online" | "stopped" | "none">> = {
    digitalocean: "stopped",
    hetzner: "stopped",
    vultr: "online",
    linode: "online",
    aws: "stopped",
    azure: "online",
    gcp: "stopped",
    ionos: "online"
};

export interface Choice {
    readonly id: string;
    readonly label: string;
}

export interface SizeChoice extends Choice {
    readonly priceHourly: number | null;
    readonly priceMonthly: number | null;
    readonly currency: string | null;
}

export type MachineStatus = "creating" | "running" | "off" | "transitioning" | "failed" | "unknown";

/** A machine as the provider describes it. */
export interface CloudMachine {
    readonly providerId: string;
    readonly name: string;
    readonly region: string;
    readonly size: string;
    readonly status: MachineStatus;
    readonly ipv4: string | null;
}

export interface CreateSpec {
    readonly name: string;
    readonly region: string;
    readonly size: string;
    readonly image: string;
    /** The first-boot script (see `cloud-init.ts`). */
    readonly userData: string;
}

/** How a machine is found again: its id, and where it lives. */
export interface MachineRef {
    readonly providerId: string;
    readonly region: string;
}

export type PowerAction = "power_on" | "power_off" | "reboot";

export interface ProviderAdapter {
    listRegions(): Promise<readonly Choice[]>;
    listSizes(region: string): Promise<readonly SizeChoice[]>;
    /** Ubuntu and Debian LTS images only. */
    listImages(region: string): Promise<readonly Choice[]>;
    create(spec: CreateSpec): Promise<CloudMachine>;
    /** Null when the provider no longer has it. */
    get(ref: MachineRef): Promise<CloudMachine | null>;
    action(ref: MachineRef, action: PowerAction): Promise<void>;
    /** Absent where the provider's API has no resize. */
    resize?(ref: MachineRef, size: string): Promise<void>;
    destroy(ref: MachineRef): Promise<void>;
    /** The published price of a size in a region; null when the provider has no
     *  price API, which the screen says rather than estimating. */
    monthlyCost(region: string, size: string): Promise<SizeChoice | null>;
}

/** A machine name every provider accepts: a lowercase hostname label. */
export const machineNameSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]([a-z0-9-]{0,48}[a-z0-9])?$/);

/** Keep the Ubuntu and Debian LTS releases out of a provider's image list. */
export function isLtsImage(text: string): boolean {
    const lower = text.toLowerCase();
    if (/\bubuntu\b/.test(lower)) return /\b(22\.04|24\.04)\b/.test(lower) || /\blts\b/.test(lower);
    return /\bdebian\b/.test(lower) && /\b(11|12|13)\b/.test(lower);
}
