/**
 * The vault, drawn in Spanish.
 *
 * The lock screen and the setup form are the two screens every vault passes
 * through, and the rest of what is asserted is what a migration misses: a label
 * core keeps in English (when a vault locks itself), a schema's complaint, and a
 * file parser's refusal.
 */

import { describe, expect, it, vi } from "vitest";
import { withMessages } from "../../setup/i18n";
import { translatorFor } from "@/lib/i18n/translate";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_KDF_SETTINGS, VAULT_LOCK_ON_TAB_CLOSE } from "@polaris/core";
import { importRefusalText, unlockTimeoutLabel, vaultSchemaText } from "@/app/(app)/vault/vault-labels";

vi.mock("@/app/(app)/vault/vault-actions", () => ({ createAccountVaultAction: async () => ({}) }));

const { VaultUnlock } = await import("@/app/(app)/vault/vault-unlock");
const { VaultSetup } = await import("@/app/(app)/vault/vault-setup");

const t = translatorFor("es-ES", "vault");
const tv = translatorFor("es-ES", "validation");

describe("the lock screen", () => {
    it("asks for the master password in Spanish", () => {
        const markup = renderToStaticMarkup(
            withMessages(
                <VaultUnlock
                    email="ana@example.com"
                    kdf={DEFAULT_KDF_SETTINGS}
                    protectedKey=""
                    onUnlocked={() => undefined}
                />,
                "es-ES"
            )
        );
        expect(markup).toContain("Tu bóveda está bloqueada");
        expect(markup).toContain('placeholder="Contraseña maestra"');
        expect(markup).toContain("Desbloquear");
        expect(markup).not.toContain("Unlock");
    });
});

describe("setting a vault up", () => {
    it("is drawn in Spanish, with the length it asks for", () => {
        const markup = renderToStaticMarkup(
            withMessages(<VaultSetup email="ana@example.com" name="Ana" onCreated={() => undefined} />, "es-ES")
        );
        expect(markup).toContain("Configura tu bóveda");
        expect(markup).toMatch(/Al menos \d+ caracteres/);
        expect(markup).toContain("Crear mi bóveda");
    });
});

describe("words core keeps in English", () => {
    it("says when a vault locks itself in Spanish", () => {
        expect(unlockTimeoutLabel(t, 5)).toBe("Tras 5 minutos inactiva");
        expect(unlockTimeoutLabel(t, VAULT_LOCK_ON_TAB_CLOSE)).toBe("Al cerrar la pestaña");
    });

    it("turns a schema's complaint into Spanish, length and all", () => {
        expect(vaultSchemaText(t, tv, "Give it a name")).toBe("Ponle un nombre");
        expect(vaultSchemaText(t, tv, "Use at least 12 characters.")).toBe("Usa al menos 12 caracteres.");
    });

    it("says why a file could not be imported, and leaves a parser's own words alone", () => {
        expect(importRefusalText(t, "That XML is not a KeePass export.")).toBe("Ese XML no es una exportación de KeePass.");
        expect(importRefusalText(t, "Unexpected token < in JSON")).toBe("Unexpected token < in JSON");
    });
});
