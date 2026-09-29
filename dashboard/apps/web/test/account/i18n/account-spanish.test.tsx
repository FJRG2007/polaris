/**
 * The account screens, drawn in Spanish.
 *
 * What is asserted is what a migration gets wrong without noticing: a count
 * that has to agree with its number, a list of choices that used to be a
 * constant frozen in English, and a sentence another module wrote that the
 * screen now has to say in the reader's words.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import type { PrivacySettings } from "@polaris/core";
import { renderToStaticMarkup } from "react-dom/server";
import type { TrustedDeviceRow } from "@/lib/session-directory";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => true, null] }));
vi.mock("@/components/relative-time", () => ({ RelativeTime: ({ iso }: { iso: string }) => iso }));
vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({ date: (iso: string) => iso, dateTime: (iso: string) => iso })
}));
vi.mock("@/app/(app)/account/sessions/actions", () => ({
    forgetTrustedDeviceAction: async () => ({}),
    forgetTrustedDevicesAction: async () => ({ count: 0 }),
    revokeSessionAction: async () => ({}),
    signOutTrustedDeviceAction: async () => ({ count: 0, endedCurrent: false }),
    trustedDeviceAction: async () => ({ detail: undefined })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    savePrivacyAction: async () => ({}),
    createPrivacyListAction: async () => ({}),
    updatePrivacyListAction: async () => ({}),
    deletePrivacyListAction: async () => ({}),
    searchPeopleAction: async () => ({ results: [] })
}));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => undefined }));
vi.mock("@/app/(app)/account/security/two-factor-actions", () => ({
    regenerateBackupCodesAction: async () => ({ codes: [] })
}));

const { TrustedDevicesCard } = await import("@/app/(app)/account/sessions/trusted-devices-card");
const { BackupCodesCard } = await import("@/app/(app)/account/security/backup-codes-card");
const { PrivacyView } = await import("@/app/(app)/account/privacy/privacy-view");
const { knownMessage } = await import("@/app/(app)/account/security/known-sentences");
const { webCatalogs } = await import("../../../messages");
const core = await import("@polaris/core");

function device(overrides: Partial<TrustedDeviceRow> = {}): TrustedDeviceRow {
    return {
        id: "trust-device-aaaaaaaa",
        current: false,
        device: "Chrome on Android",
        ip: "192.168.1.131",
        publicIp: null,
        host: "polaris.local",
        rememberedAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-08-19T10:00:00.000Z",
        ...overrides
    };
}

describe("the remembered devices in Spanish", () => {
    const markup = renderToStaticMarkup(
        withMessages(<TrustedDevicesCard devices={[device(), device({ id: "two", current: true })]} />, "es-ES")
    );

    it("names the columns and the device being read on", () => {
        expect(markup).toContain(">Dispositivo</th>");
        expect(markup).toContain(">Recordado</th>");
        expect(markup).toContain("Este dispositivo");
        expect(markup).not.toContain(">Device</th>");
    });

    it("names each device in the row's own control", () => {
        expect(markup).toContain('aria-label="Dejar de recordar Chrome on Android"');
        expect(markup).toContain("Olvidarlos todos");
    });
});

describe("the backup codes card in Spanish", () => {
    it("agrees the count with its number", () => {
        const one = renderToStaticMarkup(withMessages(<BackupCodesCard twoFactorEnabled remaining={1} />, "es-ES"));
        const many = renderToStaticMarkup(withMessages(<BackupCodesCard twoFactorEnabled remaining={8} />, "es-ES"));
        expect(one).toContain("Queda 1");
        expect(many).toContain("Quedan 8");
        expect(many).not.toContain("8 left");
    });
});

describe("the privacy settings in Spanish", () => {
    const everybody = { audience: "everyone" as const, people: [], listId: null };
    const settings = Object.fromEntries(core.PRIVACY_FIELDS.map((field) => [field, everybody])) as unknown as PrivacySettings;
    const markup = renderToStaticMarkup(
        withMessages(<PrivacyView settings={settings} lists={[]} people={[]} />, "es-ES")
    );

    it("names the sections and the questions that were core's English", () => {
        expect(markup).toContain("Que te encuentren");
        expect(markup).toContain("Quién puede llamarte");
        expect(markup).not.toContain("Who can call you");
    });
});

describe("a sentence written elsewhere", () => {
    const t = webCatalogs.translator("es-ES", "accountSecurity");
    const tv = webCatalogs.translator("es-ES", "validation");

    it("is said in Spanish when the screen knows it", () => {
        expect(knownMessage(t, tv, "Current password is incorrect.")).toBe("La contraseña actual no es correcta.");
        expect(knownMessage(t, tv, "Too many attempts. Try again in 5 minutes.")).toBe(
            "Demasiados intentos. Vuelve a intentarlo dentro de 5 minutos."
        );
    });

    it("is left as it was when it does not", () => {
        expect(knownMessage(t, tv, "Something only the server knows")).toBe("Something only the server knows");
    });
});
