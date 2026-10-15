/**
 * Starting points for a new template. Package names are the Debian and Ubuntu
 * ones; a template is edited after it is started from one of these. Each entry
 * is read through the same schema a saved template is (`librarySpec`), and a
 * test holds every one of them to it. Pure, and safe to import from the browser.
 */

import { templateSpecSchema, type TemplateSpec, type TemplateSpecInput } from "@polaris/core";

/** Read first by sshd, ahead of a cloud image's `50-cloud-init.conf`: for most
 *  settings the first value sshd reads is the one it keeps. */
const SSH_BASELINE = `# Kept by Polaris from a server template. Edit the template, not this file.
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 4
`;

/** What `dpkg-reconfigure unattended-upgrades` writes when it is turned on. */
const AUTO_UPGRADES = `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`;

export const TEMPLATE_LIBRARY = {
    blank: {},
    sshHardened: {
        packages: ["openssh-server"],
        files: [
            { path: "/etc/ssh/sshd_config.d/10-polaris.conf", content: SSH_BASELINE, mode: "644" }
        ]
    },
    securityUpdates: {
        packages: ["unattended-upgrades"],
        services: [{ name: "unattended-upgrades", running: true, enabled: true }],
        files: [
            { path: "/etc/apt/apt.conf.d/20auto-upgrades", content: AUTO_UPGRADES, mode: "644" }
        ]
    },
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
        sysctl: [
            { key: "net.ipv4.conf.all.accept_redirects", value: "0" },
            { key: "net.ipv4.conf.all.send_redirects", value: "0" },
            { key: "net.ipv4.tcp_syncookies", value: "1" },
            { key: "kernel.kptr_restrict", value: "2" }
        ]
    }
} as const satisfies Record<string, TemplateSpecInput>;

export type LibraryKey = keyof typeof TEMPLATE_LIBRARY;

export const LIBRARY_KEYS = Object.keys(TEMPLATE_LIBRARY) as LibraryKey[];

/** One starting point, as the full spec a template holds. */
export function librarySpec(key: LibraryKey): TemplateSpec {
    return templateSpecSchema.parse(TEMPLATE_LIBRARY[key]);
}
