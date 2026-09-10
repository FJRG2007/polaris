/**
 * The one-click services: each is whole, and its variables come out as the
 * service stores them.
 */

import { describe, expect, it } from "vitest";
import { hasReferences, referencesIn } from "./deploy-references.js";
import { SERVICE_TEMPLATES, serviceTemplate, templateVariables } from "./service-templates.js";

describe("the template list", () => {
    it("names each template once, with an image, a port and mount paths that are paths", () => {
        const ids = SERVICE_TEMPLATES.map((template) => template.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const template of SERVICE_TEMPLATES) {
            expect(template.image).toMatch(/^[a-z0-9./_-]+(:[\w.-]+)?$/);
            expect(template.port).toBeGreaterThan(0);
            for (const volume of template.volumes) expect(volume.mountPath.startsWith("/")).toBe(true);
            // A secret is generated, never also written as a plain value.
            for (const key of template.secrets) expect(template.env[key]).toBeUndefined();
        }
    });
});

describe("templateVariables", () => {
    it("writes the public address as a reference to the service itself", () => {
        const vars = templateVariables(serviceTemplate("n8n")!, "automations", () => "x");
        const webhook = vars.find((entry) => entry.key === "WEBHOOK_URL");
        expect(webhook?.value).toBe("${{automations.POLARIS_PUBLIC_URL}}");
        expect(hasReferences(webhook?.value ?? "")).toBe(true);
        expect(referencesIn(webhook?.value ?? "")[0]).toMatchObject({ name: "automations", key: "POLARIS_PUBLIC_URL" });
    });

    it("generates each secret and marks it secret", () => {
        let n = 0;
        const vars = templateVariables(serviceTemplate("vaultwarden")!, "vault", () => `secret-${++n}`);
        expect(vars.find((entry) => entry.key === "ADMIN_TOKEN")).toEqual({
            key: "ADMIN_TOKEN",
            value: "secret-1",
            isSecret: true
        });
        expect(vars.find((entry) => entry.key === "SIGNUPS_ALLOWED")?.isSecret).toBe(false);
    });
});
