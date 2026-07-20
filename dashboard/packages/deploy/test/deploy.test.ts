import { describe, expect, it } from "vitest";
import { imageTag, serviceName, shortHash, slugify } from "../src/naming.js";
import { isMagicBase, magicDomain } from "../src/subdomain.js";
import { quoteArg, quoteArgv } from "../src/shell.js";
import { buildCommand, buildSpec } from "../src/builders/index.js";
import { configHash, traefikLabels } from "../src/traefik.js";

describe("naming", () => {
    it("produces DNS-label-safe slugs", () => {
        expect(slugify("My App!!")).toBe("my-app");
        expect(slugify("  a__b  ")).toBe("a-b");
        expect(slugify("---x---")).toBe("x");
        expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(63);
    });

    it("hashes stably and short", () => {
        expect(shortHash("abc")).toBe(shortHash("abc"));
        expect(shortHash("abc")).toHaveLength(6);
        expect(shortHash("abc", 4)).toHaveLength(4);
    });

    it("names a service DNS-safe with a collision-proof suffix", () => {
        const a = serviceName("proj", "web", "id-1");
        const b = serviceName("proj", "web", "id-2");
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[a-z0-9-]+$/);
        expect(a.length).toBeLessThanOrEqual(63);
    });

    it("tags images with the commit or latest", () => {
        expect(imageTag("My App", "abcdef1234567890")).toBe("my-app:abcdef123456");
        expect(imageTag("My App")).toBe("my-app:latest");
    });
});

describe("subdomain", () => {
    it("encodes the ip in the hostname with a dashed form", () => {
        const host = magicDomain("web", "1.2.3.4");
        expect(host).toMatch(/^web-[0-9a-f]{6}-1-2-3-4\.sslip\.io$/);
    });

    it("omits the ip segment when there is no ip", () => {
        expect(magicDomain("web", "")).toMatch(/^web-[0-9a-f]{6}\.sslip\.io$/);
    });

    it("keeps two same-slug apps on distinct hosts", () => {
        expect(magicDomain("web", "1.1.1.1")).not.toBe(magicDomain("web ", "1.1.1.1"));
    });

    it("recognizes magic bases", () => {
        expect(isMagicBase("sslip.io")).toBe(true);
        expect(isMagicBase("traefik.me")).toBe(true);
        expect(isMagicBase("example.com")).toBe(false);
    });
});

describe("shell quoting", () => {
    it("leaves safe tokens bare", () => {
        expect(quoteArg("docker")).toBe("docker");
        expect(quoteArg("a=b/c.d:e-f")).toBe("a=b/c.d:e-f");
    });

    it("quotes and escapes dangerous input", () => {
        expect(quoteArg("a b")).toBe("'a b'");
        expect(quoteArg("a'b")).toBe(`'a'\\''b'`);
        expect(quoteArg("$(rm -rf /)")).toBe(`'$(rm -rf /)'`);
    });

    it("joins an argv safely", () => {
        expect(quoteArgv(["docker", "run", "my image"])).toBe("docker run 'my image'");
    });
});

describe("builders", () => {
    it("normalizes a dockerfile spec and tags it by commit", () => {
        const spec = buildSpec({
            method: "dockerfile",
            name: "api",
            commitSha: "deadbeefcafe0000",
            contextPath: "/ctx",
            buildArgs: { NODE_ENV: "production" }
        });
        expect(spec.imageTag).toBe("api:deadbeefcafe");
        expect(spec.dockerfilePath).toBe("Dockerfile");
        expect(buildCommand(spec)).toEqual([
            "docker",
            "build",
            "-t",
            "api:deadbeefcafe",
            "-f",
            "Dockerfile",
            "--build-arg",
            "NODE_ENV=production",
            "/ctx"
        ]);
    });

    it("pulls for an image source and does not tag it", () => {
        const spec = buildSpec({ method: "image", name: "cache", contextPath: "/ctx", imageRef: "redis:7" });
        expect(spec.imageTag).toBe("");
        expect(buildCommand(spec)).toEqual(["docker", "pull", "redis:7"]);
    });

    it("emits no build command for compose (it builds inline on up)", () => {
        const spec = buildSpec({ method: "compose", name: "stack", contextPath: "/ctx", composeYaml: "services: {}" });
        expect(buildCommand(spec)).toEqual([]);
    });

    it("builds a nixpacks command with env flags", () => {
        const spec = buildSpec({ method: "nixpacks", name: "web", contextPath: "/ctx", buildArgs: { PORT: "3000" } });
        expect(buildCommand(spec)).toEqual(["nixpacks", "build", "/ctx", "--name", "web:latest", "--env", "PORT=3000"]);
    });

    it("defaults the buildpacks builder", () => {
        const spec = buildSpec({ method: "buildpacks", name: "web", contextPath: "/ctx" });
        expect(buildCommand(spec)).toContain("paketobuildpacks/builder-jammy-base");
    });
});

describe("traefik labels", () => {
    it("returns nothing when there are no domains", () => {
        expect(traefikLabels({ serviceName: "web", network: "polaris-proxy", domains: [] })).toEqual({});
    });

    it("emits a websecure router with LE and an http->https redirect", () => {
        const labels = traefikLabels({
            serviceName: "web",
            network: "polaris-proxy",
            domains: [{ hostname: "web.sslip.io", targetPort: 3000, certResolver: "le" }]
        });
        expect(labels["traefik.enable"]).toBe("true");
        expect(labels["traefik.http.services.web.loadbalancer.server.port"]).toBe("3000");
        expect(labels["traefik.http.routers.web.tls.certresolver"]).toBe("letsencrypt");
        expect(labels["traefik.http.routers.web.rule"]).toBe("Host(`web.sslip.io`)");
        expect(labels["traefik.http.routers.web-web.middlewares"]).toBe("polaris-redirect-https@docker");
    });

    it("adds a path prefix to the rule", () => {
        const labels = traefikLabels({
            serviceName: "api",
            network: "polaris-proxy",
            domains: [{ hostname: "h", targetPort: 80, pathPrefix: "/v1", certResolver: "none" }]
        });
        expect(labels["traefik.http.routers.api.rule"]).toBe("Host(`h`) && PathPrefix(`/v1`)");
        expect(labels["traefik.http.routers.api.entrypoints"]).toBe("web");
    });

    it("hashes label sets order-independently", () => {
        const a = traefikLabels({ serviceName: "w", network: "n", domains: [{ hostname: "h", targetPort: 1, certResolver: "le" }] });
        const b = { ...a };
        expect(configHash(a)).toBe(configHash(b));
        expect(configHash({ ...a, extra: "x" })).not.toBe(configHash(a));
    });
});
