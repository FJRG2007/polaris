// @vitest-environment jsdom

/**
 * The form that connects a database.
 *
 * Three things are asserted because all three were reported: the engine is
 * picked the way a service is picked in Apps, with the project's own mark;
 * read-only is not ticked for somebody who never asked for it; and a database
 * that is not published on the network can be reached over SSH from here.
 */

import { ed25519Pair } from "./fixtures/ed25519";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { readPrivateKey, SshKeyError } from "@/lib/data/ssh-key";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const saved: unknown[] = [];
const publicKeyAsks: string[] = [];
const FIXTURE_PUBLIC_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixturePublicKeyFixturePublicKeyFix";
const NODE_0 = { id: "22222222-2222-4222-8222-222222222222", name: "node-0", address: "10.0.0.2" };
let tunnelServers: (typeof NODE_0)[] = [NODE_0];

vi.mock("@/app/(app)/apps/databases/actions", () => ({
    // The real key reader, so this exercises the same parsing and passphrase
    // handling the server action wraps - only its rate limiting and
    // translation are stubbed out here.
    inspectKeyAction: async (key: string, passphrase: string | null) => {
        try {
            const read = readPrivateKey(key, passphrase);
            return { type: read.type, fingerprint: read.fingerprint };
        } catch (error) {
            return { error: error instanceof SshKeyError ? error.message : "refused" };
        }
    },
    engineOptionsAction: async () => ({
        engines: [
            { id: "postgres", label: "PostgreSQL", port: 5432 },
            { id: "mysql", label: "MySQL", port: 3306 }
        ]
    }),
    listManagedAction: async () => ({ databases: [] }),
    sshPublicKeyAction: async (id: string) => {
        publicKeyAsks.push(id);
        return { publicKey: FIXTURE_PUBLIC_LINE };
    },
    listTunnelServersAction: async () => ({ servers: tunnelServers }),
    saveConnectionAction: async (input: unknown) => {
        saved.push(input);
        return { id: "new" };
    }
}));

const { ConnectionDialog } = await import("@/app/(app)/apps/databases/connection-dialog");

// What jsdom does not implement and Radix's menus call on the way open.
beforeAll(() => {
    Object.assign(Element.prototype, {
        hasPointerCapture: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        scrollIntoView: () => undefined
    });
});

afterEach(() => {
    cleanup();
    saved.length = 0;
    tunnelServers = [NODE_0];
});

function open() {
    return render(
        <ConnectionDialog connection={null} onClose={() => undefined} onSaved={() => undefined} />,
        { wrapper: MessagesWrapper }
    );
}

/** A saved connection reached over SSH, as the list hands one to the form. */
function tunnelled(tunnel: Record<string, unknown>) {
    return render(
        <ConnectionDialog
            connection={
                {
                    id: "11111111-1111-4111-8111-111111111111",
                    name: "Production",
                    engine: "postgres",
                    origin: "saved",
                    managedDatabaseId: null,
                    where: "127.0.0.1:5432",
                    database: null,
                    username: "app",
                    readOnly: false,
                    tls: false,
                    host: "127.0.0.1",
                    port: 5432,
                    tunnel,
                    note: null,
                    unreachable: false,
                    lastUsedAt: null,
                    createdAt: null
                } as never
            }
            onClose={() => undefined}
            onSaved={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

const MANUAL_TUNNEL = {
    mode: "manual",
    host: "ssh.example.com",
    port: 2222,
    username: "root",
    authMethod: "password",
    jumpHostId: null,
    jumpHostName: null,
    jumpMissing: false
};

describe("the connection form", () => {
    it("picks the engine with its own mark, not a list of words", async () => {
        open();
        const trigger = screen.getByRole("combobox", { name: "Engine" });
        // The mark of what is chosen is mirrored in the closed trigger.
        expect(trigger.querySelector("svg")).toBeTruthy();

        await userEvent.click(trigger);
        const option = await screen.findByRole("option", { name: /PostgreSQL/ });
        expect(option.querySelector("svg")).toBeTruthy();
    });

    it("leaves read-only off until somebody turns it on", () => {
        open();
        expect(screen.getByRole("switch", { name: "Read-only" }).getAttribute("aria-checked")).toBe(
            "false"
        );
    });

    it("offers the SSH tunnel, with the servers Polaris already has", async () => {
        open();
        await userEvent.click(screen.getByRole("switch", { name: "Reach it over SSH" }));
        expect(
            await screen.findByRole("combobox", { name: "Server to tunnel through" })
        ).toBeTruthy();

        await userEvent.click(screen.getByRole("radio", { name: "Another login" }));
        expect(screen.getByPlaceholderText("ssh.example.com")).toBeTruthy();
        expect(screen.getByPlaceholderText("root")).toBeTruthy();
        expect(screen.getByRole("radio", { name: "Private key" })).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Server to jump through" })).toBeTruthy();
    });

    it("says what is wrong with an address as it is typed, and refuses to save it", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Name"), "Production");
        await userEvent.type(screen.getByLabelText("Host"), "postgres://db.example.com/app");

        expect(await screen.findByText(/without the rest of a URL/)).toBeTruthy();
        expect(screen.getByRole("button", { name: /Add it/ }).hasAttribute("disabled")).toBe(true);
    });

    it("says the server has to be picked rather than disabling Save in silence", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Name"), "Production");
        await userEvent.type(screen.getByLabelText("Host"), "127.0.0.1");
        await userEvent.click(screen.getByRole("switch", { name: "Reach it over SSH" }));

        expect(await screen.findByText("Pick the server to tunnel through.")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Add it/ }).hasAttribute("disabled")).toBe(true);

        await userEvent.click(screen.getByRole("combobox", { name: "Server to tunnel through" }));
        await userEvent.click(await screen.findByRole("option", { name: /node-0/ }));

        expect(screen.getByRole("button", { name: /Add it/ }).hasAttribute("disabled")).toBe(false);
    });

    it("asks for the secret again when the SSH login switches to a key", async () => {
        tunnelled(MANUAL_TUNNEL);
        const save = screen.getByRole("button", { name: /Save/ });
        expect(save.hasAttribute("disabled")).toBe(false);

        await userEvent.click(screen.getByRole("radio", { name: "Private key" }));

        expect(save.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/drop the file here, or choose it/)).toBeTruthy();
    });

    it("makes the reader answer the jump picker when that bastion was removed", async () => {
        tunnelled({ ...MANUAL_TUNNEL, jumpMissing: true });
        const save = screen.getByRole("button", { name: /Save/ });
        expect(save.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/was removed from Servers/)).toBeTruthy();

        await userEvent.click(screen.getByRole("combobox", { name: "Server to jump through" }));
        await userEvent.click(await screen.findByRole("option", { name: "Straight to it" }));

        expect(save.hasAttribute("disabled")).toBe(false);
    });

    it("says which server was removed rather than leaving an empty picker", async () => {
        tunnelled({ mode: "server", hostId: null, hostName: null });

        expect(await screen.findByText(/was removed from Servers/)).toBeTruthy();
        expect(screen.getByRole("button", { name: /Save/ }).hasAttribute("disabled")).toBe(true);
    });

    it("sends what was filled in, read-only off", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Name"), "Production");
        await userEvent.type(screen.getByLabelText("Host"), "db.example.com");
        await userEvent.click(screen.getByRole("button", { name: /Add it/ }));

        expect(saved[0]).toMatchObject({
            name: "Production",
            engine: "postgres",
            host: "db.example.com",
            readOnly: false,
            ssh: null
        });
    });

    it("turns SSL on, verifying the certificate and name, for a public host, and off for a private one", async () => {
        open();
        const host = screen.getByLabelText("Host");
        const ssl = () => screen.getByRole("switch", { name: "Enable SSL" });

        await userEvent.type(host, "db.example.com");
        expect(ssl().getAttribute("aria-checked")).toBe("true");
        expect(
            (
                screen.getByRole("radio", {
                    name: /Check the certificate and the name/
                }) as HTMLInputElement
            ).checked
        ).toBe(true);

        await userEvent.clear(host);
        await userEvent.type(host, "10.0.0.4");
        expect(ssl().getAttribute("aria-checked")).toBe("false");
        expect(
            screen.queryByRole("radio", { name: /Check the certificate and the name/ })
        ).toBeNull();
    });

    it("shows the SSL options only once SSL is on, each mode said in plain words", async () => {
        open();
        await userEvent.type(screen.getByLabelText("Host"), "10.0.0.4");
        expect(screen.queryByRole("radiogroup", { name: "How strict" })).toBeNull();

        await userEvent.click(screen.getByRole("switch", { name: "Enable SSL" }));
        const modes = screen.getByRole("radiogroup", { name: "How strict" });
        expect(within(modes).getAllByRole("radio")).toHaveLength(3);
        expect(modes.textContent).toContain("does not check who answers");
        expect(modes.textContent).toContain("signed by an authority you trust");
        expect(modes.textContent).toContain("issued for this exact address");

        await userEvent.click(within(modes).getByRole("radio", { name: /Encrypt only/ }));
        expect(screen.getByText(/someone on the network can read/)).toBeTruthy();
        await userEvent.click(within(modes).getByRole("radio", { name: /Check the certificate$/ }));
        expect(screen.getByRole("combobox", { name: "Check against" })).toBeTruthy();
    });

    it("fills the form from a pasted connection URL, and keeps nothing of the URL", async () => {
        open();
        const url = screen.getByLabelText("Connection URL");
        await userEvent.type(
            url,
            "postgres://app_user:s3cret@db.example.com:6543/shop?sslmode=require"
        );
        await userEvent.click(screen.getByRole("button", { name: "Import" }));

        expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("db.example.com");
        expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("6543");
        expect((screen.getByLabelText("Database") as HTMLInputElement).value).toBe("shop");
        expect((screen.getByLabelText("User") as HTMLInputElement).value).toBe("app_user");
        expect(
            screen.getByRole("switch", { name: "Enable SSL" }).getAttribute("aria-checked")
        ).toBe("true");
        expect(
            (screen.getByRole("radio", { name: /Encrypt only/ }) as HTMLInputElement).checked
        ).toBe(true);
        expect((url as HTMLInputElement).value).toBe("");
        expect(screen.getByRole("status").textContent).toContain("Filled in from the URL");

        await userEvent.type(screen.getByLabelText("Name"), "Shop");
        await userEvent.click(screen.getByRole("button", { name: /Add it/ }));
        expect(saved[0]).toMatchObject({ password: "s3cret", tlsMode: "require", port: 6543 });
    });

    it("says why a URL cannot be imported instead of filling half the form", async () => {
        open();
        await userEvent.type(
            screen.getByLabelText("Connection URL"),
            "mongodb+srv://u:p@cluster0.example.net/app"
        );
        await userEvent.click(screen.getByRole("button", { name: "Import" }));
        expect(screen.getByText(/SRV/)).toBeTruthy();
        expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("");
    });

    it("opens another login straight away when Polaris has no servers, with the password in view", async () => {
        tunnelServers = [];
        open();
        await userEvent.click(screen.getByRole("switch", { name: "Reach it over SSH" }));
        expect(await screen.findByPlaceholderText("ssh.example.com")).toBeTruthy();
        expect(screen.queryByRole("radio", { name: "A server in Polaris" })).toBeNull();
        expect(screen.getByText(/No servers in Polaris yet/)).toBeTruthy();
        expect(screen.getByText("SSH password")).toBeTruthy();
        // The way in is a choice with a visible name, not an unlabeled toggle.
        expect(screen.getByRole("radiogroup", { name: "Sign in with" })).toBeTruthy();
    });

    it("puts the SSH tunnel before the encryption, where it is seen", () => {
        open();
        const ssh = screen.getByRole("switch", { name: "Reach it over SSH" });
        const ssl = screen.getByRole("switch", { name: "Enable SSL" });
        expect(ssh.compareDocumentPosition(ssl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("imports a private key by drag-and-drop, reads it for real, and never echoes the passphrase back", async () => {
        tunnelled(MANUAL_TUNNEL);
        await userEvent.click(screen.getByRole("radio", { name: "Private key" }));

        const passphrase = "correct horse battery staple";
        const pair = ed25519Pair({
            passphrase,
            cipher: "aes256-ctr",
            rounds: 16
        });
        const file = new File([pair.private], "id_ed25519");
        const field = screen.getByRole("textbox", { name: "Private key" });

        fireEvent.drop(field, { dataTransfer: { files: [file] } });
        await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(pair.private));

        // Locked key: the form asks for the passphrase instead of guessing or
        // moving on, and the field that holds it stays masked. (The show/hide
        // toggle the password Input renders defeats jsdom's implicit
        // label-control lookup, so the input is found through its label text
        // instead of `getByLabelText`.)
        const passphraseLabel = await screen.findByText("Key passphrase");
        const passphraseField = passphraseLabel.closest("label")!.querySelector("input")!;
        expect(passphraseField.getAttribute("type")).toBe("password");

        await userEvent.type(passphraseField, passphrase);

        // The real `readPrivateKey` runs on the dropped file; once it unlocks,
        // its type and fingerprint are shown - and only those, never the
        // passphrase or the key material itself.
        const summary = await screen.findByText(/^ssh-ed25519 SHA256:/, {}, { timeout: 2000 });
        expect(summary.textContent).not.toContain(passphrase);
        expect(document.body.textContent).not.toContain(passphrase);
    });
});

describe("a saved SSH key", () => {
    const KEY_TUNNEL = {
        mode: "manual",
        host: "ssh.example.com",
        port: 2222,
        username: "root",
        authMethod: "key",
        jumpHostId: null,
        jumpHostName: null,
        jumpMissing: false,
        keyType: "ssh-ed25519",
        keyFingerprint: "SHA256:fixtureFingerprintThatIsLongEnoughToWrapOnAPhoneScreen",
        hostKeyFingerprint: "SHA256:fixtureHostKey"
    };

    it("shows its whole fingerprint and, on request, its public line with a copy button", async () => {
        publicKeyAsks.length = 0;
        tunnelled(KEY_TUNNEL);

        const fingerprint = screen.getByText(/SHA256:fixtureFingerprint/);
        expect(fingerprint.className).toContain("break-all");
        expect(fingerprint.className).not.toContain("truncate");
        expect(publicKeyAsks).toEqual([]);

        await userEvent.click(screen.getByRole("button", { name: "Show public key" }));

        expect(await screen.findByText(FIXTURE_PUBLIC_LINE)).toBeTruthy();
        expect(publicKeyAsks).toEqual(["11111111-1111-4111-8111-111111111111"]);
        expect(screen.getByText(/authorized_keys/)).toBeTruthy();
        expect(screen.getByRole("button", { name: /Public key/ }).getAttribute("title")).toBeTruthy();

        await userEvent.click(screen.getByRole("button", { name: "Hide public key" }));
        expect(screen.queryByText(FIXTURE_PUBLIC_LINE)).toBeNull();
    });
});
