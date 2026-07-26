/**
 * User-facing copy for the server environments. Each entry says what the choice
 * means and how a domain reaches a server like that, because that is the practical
 * difference between a home line and a data-centre box.
 */

import type { ServerEnvironment } from "@polaris/core";

export interface EnvironmentMeta {
    label: string;
    /** What this choice means, shown while picking. */
    summary: string;
    /** How a domain is pointed at a server like this. */
    routing: string;
    tone: "primary" | "warning" | "success" | "neutral";
}

export const ENVIRONMENT_META: Record<ServerEnvironment, EnvironmentMeta> = {
    "home-nat": {
        label: "Home or office LAN",
        summary: "Private IP behind a router you control.",
        routing:
            "A domain needs ports 80 and 443 forwarded to this server, or a tunnel. Use DuckDNS or another updater if the ISP IP changes.",
        tone: "primary"
    },
    "home-cgnat": {
        label: "Home behind carrier NAT",
        summary: "The ISP shares one public IP across customers - common on mobile, fibre resellers and Starlink.",
        routing: "Port forwarding cannot work here. A domain only reaches this server through a tunnel.",
        tone: "warning"
    },
    vps: {
        label: "VPS or dedicated server",
        summary: "Holds its own public IP.",
        routing: "Point the domain's A record straight at this server; its own edge issues the certificate.",
        tone: "success"
    },
    cloud: {
        label: "Cloud VM",
        summary: "AWS, GCP, Azure or similar - public IP behind a firewall you configure.",
        routing: "Point the A record at the instance and allow 80/443 in its security group. Use a reserved IP so the record keeps working.",
        tone: "success"
    },
    unknown: {
        label: "Not set",
        summary: "Polaris could not tell where this server lives.",
        routing: "Set where it lives to get the right way to point a domain at it.",
        tone: "neutral"
    }
};

/** The answerable options in the order they are offered; `unknown` is a state, not a choice. */
export const ENVIRONMENT_CHOICES: ServerEnvironment[] = ["home-nat", "home-cgnat", "vps", "cloud"];
