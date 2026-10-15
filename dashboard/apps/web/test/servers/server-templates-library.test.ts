/**
 * The starting points a template can be made from are held to the schema a
 * saved template is, and each one has the words the screen shows for it.
 */

import { describe, expect, it } from "vitest";
import { webCatalogs } from "../../messages";
import { LOCALES, templateSpecSchema } from "@polaris/core";
import { planItems } from "@/lib/server-templates/model";
import { LIBRARY_KEYS, TEMPLATE_LIBRARY, librarySpec } from "@/lib/server-templates/library";

describe("the library of starting points", () => {
    it.each(LIBRARY_KEYS)("%s is a valid template", (key) => {
        expect(templateSpecSchema.safeParse(TEMPLATE_LIBRARY[key]).success).toBe(true);
        expect(librarySpec(key)).toEqual(templateSpecSchema.parse(TEMPLATE_LIBRARY[key]));
    });

    it("starts with a blank one and has something in every other", () => {
        expect(LIBRARY_KEYS[0]).toBe("blank");
        expect(planItems(librarySpec("blank"))).toEqual([]);
        for (const key of LIBRARY_KEYS.slice(1))
            expect(planItems(librarySpec(key)).length).toBeGreaterThan(0);
    });

    it("keeps SSH open to keys and root reachable by key, so Polaris is not locked out", () => {
        const file = librarySpec("sshHardened").files[0]!;
        expect(file.path).toMatch(/^\/etc\/ssh\/sshd_config\.d\/\d\d-.+\.conf$/);
        expect(file.content).toMatch(/^PermitRootLogin prohibit-password$/m);
        expect(file.content).not.toMatch(/PubkeyAuthentication no/);
    });

    it("turns on the daily unattended run in the security updates one", () => {
        const spec = librarySpec("securityUpdates");
        expect(spec.packages).toContain("unattended-upgrades");
        expect(spec.files[0]!.content).toContain('APT::Periodic::Unattended-Upgrade "1";');
    });

    it.each(LOCALES)("names and describes each one in %s", (locale) => {
        const { servers } = webCatalogs.pick(locale, ["servers"]) as unknown as {
            servers: {
                templates: {
                    editor: {
                        library: Record<string, string>;
                        libraryAbout: Record<string, string>;
                    };
                };
            };
        };
        for (const key of LIBRARY_KEYS) {
            expect(servers.templates.editor.library[key], key).toBeTruthy();
            if (key !== "blank")
                expect(servers.templates.editor.libraryAbout[key], key).toBeTruthy();
        }
    });
});
