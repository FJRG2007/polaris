/**
 * Starting points for a new template. Package names are the Debian and Ubuntu
 * ones; a template is edited after it is started from one of these. Pure, and
 * safe to import from the browser.
 */

import type { TemplateSpecInput } from "@polaris/core";

export const TEMPLATE_LIBRARY = {
    blank: {},
    webServer: {
        packages: ["nginx", "certbot"],
        services: [{ name: "nginx", running: true, enabled: true }],
        firewall: [
            { port: 22, protocol: "tcp" },
            { port: 80, protocol: "tcp" },
            { port: 443, protocol: "tcp" }
        ]
    },
    database: {
        packages: ["postgresql"],
        services: [{ name: "postgresql", running: true, enabled: true }],
        firewall: [{ port: 22, protocol: "tcp" }]
    },
    dockerHost: {
        packages: ["docker.io"],
        services: [{ name: "docker", running: true, enabled: true }],
        sysctl: [{ key: "net.ipv4.ip_forward", value: "1" }]
    },
    bruteForce: {
        packages: ["fail2ban"],
        services: [{ name: "fail2ban", running: true, enabled: true }]
    },
    hardened: {
        packages: ["unattended-upgrades"],
        sysctl: [
            { key: "net.ipv4.conf.all.accept_redirects", value: "0" },
            { key: "net.ipv4.conf.all.send_redirects", value: "0" },
            { key: "net.ipv4.tcp_syncookies", value: "1" },
            { key: "kernel.kptr_restrict", value: "2" }
        ]
    }
} as const satisfies Record<string, TemplateSpecInput>;

export type LibraryKey = keyof typeof TEMPLATE_LIBRARY;
