// @vitest-environment jsdom

/**
 * Reading and writing the files people arrive with and leave with.
 *
 * Every one of these is somebody's whole vault, so the failures worth pinning
 * are the quiet ones: a column matched to the wrong field puts a username where
 * a title goes and nobody notices until they need the login; a folder lost on
 * the way in turns an organized vault into one long list; an export another
 * manager refuses to read is a vault nobody can leave.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as portability from "../../src/lib/vault/portability";
import { emptyItem, type VaultItem } from "../../src/app/(app)/vault/vault-model";

/** A login, filled in enough to be recognizable on the way back. */
function login(values: Partial<VaultItem> & { name: string }): VaultItem {
    return { ...emptyItem(core.CIPHER_LOGIN), ...values };
}

describe("readImportFile - CSV", () => {
    it("reads what a browser writes", () => {
        const read = portability.readImportFile(
            "passwords.csv",
            'name,url,username,password,note\nGitHub,https://github.com,ana,hunter2,"the work one"\n'
        );
        expect(read.items).toHaveLength(1);
        expect(read.items[0]).toMatchObject({
            name: "GitHub",
            login: { username: "ana", password: "hunter2" },
            notes: "the work one"
        });
        expect(read.items[0]?.login.uris).toEqual(["https://github.com"]);
    });

    it("reads a KeePass 1 export, where the title column is called Account", () => {
        // The trap: "Account" is the title and "Login Name" is the username, so
        // a reader that treats "account" as a username swaps the two.
        const read = portability.readImportFile(
            "keepass.csv",
            '"Account","Login Name","Password","Web Site","Comments"\n"Bank","ana","hunter2","https://bank.example","savings"\n'
        );
        expect(read.items[0]).toMatchObject({
            name: "Bank",
            login: { username: "ana", password: "hunter2" }
        });
    });

    it("reads a KeePassXC export, keeping the group as a folder", () => {
        const read = portability.readImportFile(
            "keepassxc.csv",
            '"Group","Title","Username","Password","URL","Notes","TOTP"\n"Root/Work","Mail","ana","hunter2","https://mail.example","","otpauth://totp/x?secret=ABC"\n'
        );
        expect(read.folders).toEqual(["Root/Work"]);
        expect(read.itemFolder).toEqual([0]);
        expect(read.items[0]?.login.totp).toBe("otpauth://totp/x?secret=ABC");
    });

    it("reads a LastPass export, whose folder column is called grouping", () => {
        const read = portability.readImportFile(
            "lastpass.csv",
            "url,username,password,totp,extra,name,grouping,fav\nhttps://a.example,ana,hunter2,,a note,Site A,Personal,1\n"
        );
        expect(read.folders).toEqual(["Personal"]);
        expect(read.items[0]).toMatchObject({ name: "Site A", notes: "a note" });
    });

    it("files two rows of one folder under a single folder", () => {
        const read = portability.readImportFile(
            "two.csv",
            "name,username,password,folder\nA,a,1,Work\nB,b,2,Work\n"
        );
        expect(read.folders).toEqual(["Work"]);
        expect(read.itemFolder).toEqual([0, 0]);
    });

    it("refuses a file with nothing recognizable in it", () => {
        expect(() => portability.readImportFile("x.csv", "a,b,c\n1,2,3\n")).toThrow();
    });
});

describe("readImportFile - Bitwarden JSON", () => {
    const file = JSON.stringify({
        encrypted: false,
        folders: [{ id: "f1", name: "Work" }],
        items: [
            {
                id: "i1",
                folderId: "f1",
                type: 1,
                name: "GitHub",
                notes: "n",
                favorite: true,
                login: { username: "ana", password: "hunter2", uris: [{ uri: "https://gh" }] },
                fields: [{ name: "pin", value: "1234", type: 1 }]
            }
        ]
    });

    it("keeps the folder an item was in", () => {
        const read = portability.readImportFile("bitwarden.json", file);
        expect(read.folders).toEqual(["Work"]);
        expect(read.itemFolder).toEqual([0]);
        expect(read.items[0]).toMatchObject({ name: "GitHub", favorite: true });
        expect(read.items[0]?.fields).toEqual([{ name: "pin", value: "1234", type: 1 }]);
    });

    it("says so rather than importing an encrypted export as junk", () => {
        expect(() =>
            portability.readImportFile("x.json", JSON.stringify({ encrypted: true, items: [] }))
        ).toThrow(/encrypted/i);
    });
});

describe("readImportFile - KeePass XML", () => {
    const file = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile>
  <Meta><DatabaseName>db</DatabaseName></Meta>
  <Root>
    <Group>
      <Name>Database</Name>
      <Entry>
        <String><Key>Title</Key><Value>Loose</Value></String>
        <String><Key>UserName</Key><Value>root</Value></String>
        <String><Key>Password</Key><Value>hunter2</Value></String>
      </Entry>
      <Group>
        <Name>Work</Name>
        <Entry>
          <String><Key>Title</Key><Value>Mail</Value></String>
          <String><Key>UserName</Key><Value>ana</Value></String>
          <String><Key>Password</Key><Value>pw</Value></String>
          <String><Key>URL</Key><Value>https://mail.example</Value></String>
          <String><Key>Notes</Key><Value>work mail</Value></String>
          <String><Key>otp</Key><Value>otpauth://totp/x?secret=ABC</Value></String>
          <String><Key>Employee id</Key><Value>42</Value></String>
        </Entry>
      </Group>
    </Group>
  </Root>
</KeePassFile>`;

    it("reads the entries and turns the group tree into folder names", () => {
        const read = portability.readImportFile("keepass.xml", file);
        expect(read.items.map((item) => item.name)).toEqual(["Loose", "Mail"]);
        // The outermost group is the database, not a folder, so the loose entry
        // is filed nowhere and the nested one is filed under its own group.
        expect(read.itemFolder).toEqual([-1, 0]);
        expect(read.folders).toEqual(["Work"]);
    });

    it("keeps a key KeePass had no column for as a custom field", () => {
        const read = portability.readImportFile("keepass.xml", file);
        expect(read.items[1]?.fields).toEqual([
            { name: "Employee id", value: "42", type: core.FIELD_TEXT }
        ]);
        expect(read.items[1]?.login.totp).toBe("otpauth://totp/x?secret=ABC");
    });

    it("refuses an export whose values are still protected", () => {
        expect(() =>
            portability.readImportFile(
                "p.xml",
                `<KeePassFile><Root><Group><Name>d</Name><Entry><String><Key>Password</Key><Value Protected="True">abc</Value></String></Entry></Group></Root></KeePassFile>`
            )
        ).toThrow(/protected/i);
    });

    it("sends somebody with a .kdbx to the export menu instead of failing oddly", () => {
        expect(() => portability.readImportFile("db.kdbx", "")).toThrow(/File > Export/);
    });
});

describe("writeExport", () => {
    const folders = [{ id: "f1", name: "Work" }];
    const items = [
        login({
            name: 'Odd "name" & <tag>',
            folderId: "f1",
            login: {
                username: "ana",
                password: "line1\nline2",
                totp: "otpauth://totp/x?secret=ABC",
                uris: ["https://a.example"]
            }
        }),
        login({ name: "Loose", login: { username: "b", password: "p", totp: "", uris: [] } })
    ];

    it("writes JSON another Polaris can read straight back", () => {
        const file = portability.writeExport("json", items, folders);
        const read = portability.readImportFile("x.json", file.text);
        expect(read.items.map((item) => item.name)).toEqual(items.map((item) => item.name));
        expect(read.folders).toEqual(["Work"]);
        expect(read.itemFolder).toEqual([0, -1]);
    });

    it("writes JSON that brings an SSH key back with its key body", () => {
        const key: VaultItem = {
            ...emptyItem(core.CIPHER_SSH_KEY),
            name: "Deploy key",
            sshKey: {
                privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----",
                publicKey: "ssh-ed25519 AAAA",
                keyFingerprint: "SHA256:abc"
            }
        };
        const file = portability.writeExport("json", [key], []);
        const read = portability.readImportFile("x.json", file.text);
        expect(read.items[0]).toMatchObject({
            type: core.CIPHER_SSH_KEY,
            name: "Deploy key",
            sshKey: key.sshKey
        });
    });

    it("writes CSV that survives a round trip, quotes and newlines included", () => {
        const file = portability.writeExport("csv", items, folders);
        expect(file.extension).toBe("csv");
        const read = portability.readImportFile("x.csv", file.text);
        expect(read.items[0]).toMatchObject({
            name: 'Odd "name" & <tag>',
            login: { username: "ana", password: "line1\nline2" }
        });
        expect(read.folders).toEqual(["Work"]);
    });

    it("writes KeePass XML that parses, with a group per folder", () => {
        const file = portability.writeExport("keepass", items, folders);
        const read = portability.readImportFile("x.xml", file.text);
        expect(read.items.map((item) => item.name).sort()).toEqual([
            "Loose",
            'Odd "name" & <tag>'
        ]);
        // The name carried characters that end an XML tag; if they were not
        // escaped the file would not have parsed at all.
        expect(file.text).toContain("&amp;");
        expect(file.text).toContain("&lt;tag&gt;");
    });

    it("drops the control characters XML cannot carry", () => {
        const file = portability.writeExport(
            "keepass",
            [login({ name: `bad${String.fromCharCode(1)}name` })],
            []
        );
        expect(file.text).not.toContain(String.fromCharCode(1));
        expect(() => portability.readImportFile("x.xml", file.text)).not.toThrow();
    });
});
