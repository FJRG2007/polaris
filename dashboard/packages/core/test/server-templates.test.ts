/**
 * What a server template may hold. Every value is refused as typed when the tool
 * on the other end would not accept it, and an item listed twice is refused
 * because the two could never both be true.
 */

import { describe, expect, it } from "vitest";
import {
    hostTemplateInputSchema,
    templateAssignInputSchema,
    templateFixInputSchema,
    templateSpecSchema
} from "../src/schemas/server-templates.js";

const ID = "8d6c3f1e-2b4a-4c7d-9e0f-1a2b3c4d5e6f";

/** The messages of every issue, by path. */
function issues(input: unknown): Record<string, string> {
    const parsed = templateSpecSchema.safeParse(input);
    if (parsed.success) return {};
    return Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join("."), issue.message])
    );
}

describe("a template's expected state", () => {
    it("fills every list in when none is given", () => {
        expect(templateSpecSchema.parse({})).toEqual({
            packages: [],
            services: [],
            files: [],
            sysctl: [],
            users: [],
            firewall: []
        });
    });

    it("defaults a service to running and starting at boot, and a file to 644", () => {
        const spec = templateSpecSchema.parse({
            services: [{ name: "nginx" }],
            files: [{ path: "/etc/motd", content: "hi" }]
        });
        expect(spec.services[0]).toEqual({ name: "nginx", running: true, enabled: true });
        expect(spec.files[0]!.mode).toBe("644");
    });

    it("trims values and drops the leading zero of a mode", () => {
        const spec = templateSpecSchema.parse({
            packages: [" nginx "],
            files: [{ path: "/etc/x", content: "", mode: "0600" }]
        });
        expect(spec.packages).toEqual(["nginx"]);
        expect(spec.files[0]!.mode).toBe("600");
    });

    it("reads a firewall port typed as text", () => {
        expect(templateSpecSchema.parse({ firewall: [{ port: "443" }] }).firewall).toEqual([
            { port: 443, protocol: "tcp" }
        ]);
    });

    it.each([
        ["a package with capitals", { packages: ["Nginx"] }, "packages.0", "packageName"],
        ["a package with a space", { packages: ["nginx certbot"] }, "packages.0", "packageName"],
        ["a package that starts like a flag", { packages: ["-y"] }, "packages.0", "packageName"],
        [
            "a service with a slash",
            { services: [{ name: "../nginx" }] },
            "services.0.name",
            "serviceName"
        ],
        [
            "a relative file",
            { files: [{ path: "etc/motd", content: "" }] },
            "files.0.path",
            "filePath"
        ],
        [
            "a file that climbs out",
            { files: [{ path: "/etc/../root/x", content: "" }] },
            "files.0.path",
            "filePath"
        ],
        ["a directory", { files: [{ path: "/etc/", content: "" }] }, "files.0.path", "filePath"],
        [
            "a path with a newline",
            { files: [{ path: "/etc/a\nb", content: "" }] },
            "files.0.path",
            "filePath"
        ],
        [
            "content with a NUL",
            { files: [{ path: "/etc/a", content: "a\0b" }] },
            "files.0.content",
            "fileContent"
        ],
        [
            "a four-digit mode",
            { files: [{ path: "/etc/a", content: "", mode: "4755" }] },
            "files.0.mode",
            "fileMode"
        ],
        [
            "a mode with an 8",
            { files: [{ path: "/etc/a", content: "", mode: "648" }] },
            "files.0.mode",
            "fileMode"
        ],
        [
            "a sysctl key with spaces",
            { sysctl: [{ key: "net ipv4", value: "1" }] },
            "sysctl.0.key",
            "sysctlKey"
        ],
        [
            "a sysctl value over two lines",
            { sysctl: [{ key: "vm.swappiness", value: "1\n2" }] },
            "sysctl.0.value",
            "sysctlValue"
        ],
        ["an account with capitals", { users: [{ name: "Deploy" }] }, "users.0.name", "userName"],
        [
            "a group with a space",
            { users: [{ name: "deploy", groups: ["sudo docker"] }] },
            "users.0.groups.0",
            "userName"
        ]
    ])("refuses %s", (_, input, path, message) => {
        expect(issues(input)[path]).toBe(message);
    });

    it("refuses a port outside 1-65535 and a protocol other than tcp or udp", () => {
        expect(issues({ firewall: [{ port: 0 }] })).toHaveProperty("firewall.0.port");
        expect(issues({ firewall: [{ port: 65536 }] })).toHaveProperty("firewall.0.port");
        expect(issues({ firewall: [{ port: 22, protocol: "icmp" }] })).toHaveProperty(
            "firewall.0.protocol"
        );
    });

    it("refuses a file over its size", () => {
        expect(
            issues({ files: [{ path: "/etc/a", content: "x".repeat(32 * 1024 + 1) }] })
        ).toHaveProperty("files.0.content");
    });

    it("accepts a path a shell would read as a command: it is only ever an argument", () => {
        expect(
            templateSpecSchema.safeParse({
                files: [{ path: "/tmp/$(reboot);`id`'\"", content: "" }]
            }).success
        ).toBe(true);
    });

    describe("an item listed twice", () => {
        it.each([
            ["a package", { packages: ["nginx", "nginx"] }, "packages.1"],
            [
                "a unit, with or without .service",
                { services: [{ name: "nginx" }, { name: "nginx.service", running: false }] },
                "services.1.name"
            ],
            [
                "a file",
                {
                    files: [
                        { path: "/etc/a", content: "1" },
                        { path: "/etc/a", content: "2" }
                    ]
                },
                "files.1.path"
            ],
            [
                "a setting",
                {
                    sysctl: [
                        { key: "vm.swappiness", value: "1" },
                        { key: "vm.swappiness", value: "60" }
                    ]
                },
                "sysctl.1.key"
            ],
            [
                "an account",
                { users: [{ name: "deploy" }, { name: "deploy", groups: ["sudo"] }] },
                "users.1.name"
            ],
            [
                "a port and protocol",
                { firewall: [{ port: 22 }, { port: "22", protocol: "tcp" }] },
                "firewall.1.port"
            ]
        ])("refuses %s on the second entry", (_, input, path) => {
            expect(issues(input)).toEqual({ [path]: "duplicate" });
        });

        it("lets one port be open for both protocols", () => {
            expect(
                issues({
                    firewall: [
                        { port: 53, protocol: "tcp" },
                        { port: 53, protocol: "udp" }
                    ]
                })
            ).toEqual({});
        });
    });
});

describe("the inputs around a template", () => {
    it("needs a name and keeps the description short", () => {
        expect(hostTemplateInputSchema.safeParse({ name: "  ", spec: {} }).success).toBe(false);
        expect(
            hostTemplateInputSchema.safeParse({
                name: "Web",
                description: "x".repeat(501),
                spec: {}
            }).success
        ).toBe(false);
        expect(hostTemplateInputSchema.parse({ name: " Web ", spec: {} })).toMatchObject({
            name: "Web",
            description: ""
        });
    });

    it("assigns by ids only, with auto-fix off unless asked", () => {
        expect(templateAssignInputSchema.parse({ templateId: ID, hostId: ID })).toEqual({
            templateId: ID,
            hostId: ID,
            autoFix: false
        });
        expect(templateAssignInputSchema.safeParse({ templateId: "x", hostId: ID }).success).toBe(
            false
        );
    });

    it("fixes everything when no key is named, and caps the keys named", () => {
        expect(templateFixInputSchema.parse({ assignmentId: ID }).keys).toBeUndefined();
        expect(
            templateFixInputSchema.safeParse({ assignmentId: ID, keys: Array(401).fill("pkg:a") })
                .success
        ).toBe(false);
        expect(templateFixInputSchema.safeParse({ assignmentId: ID, keys: [""] }).success).toBe(
            false
        );
    });
});
