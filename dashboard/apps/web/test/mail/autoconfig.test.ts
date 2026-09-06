/**
 * Reading the document a domain publishes about its own mail servers.
 *
 * The part of discovery that can be tested without a network, and the part most
 * likely to be wrong: these documents are written by hand, frequently malformed,
 * and a wrong answer here is a mailbox that connects to the wrong host with
 * somebody's password.
 *
 * The refusals matter as much as the answers. A document that is missing half of
 * itself has to read as "nobody answered" so discovery falls through to the next
 * question, rather than as a half-filled form somebody has to notice is wrong.
 */

import { describe, expect, it } from "vitest";
import { parseAutoconfig } from "@/lib/mailbox/autoconfig";

const FULL = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <displayName>Example Mail</displayName>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("what it reads", () => {
    it("takes both servers and their security", () => {
        const found = parseAutoconfig(FULL, "someone@example.com");
        expect(found?.imap).toEqual({ host: "imap.example.com", port: 993, security: "tls" });
        expect(found?.smtp).toEqual({ host: "smtp.example.com", port: 587, security: "starttls" });
        expect(found?.serviceName).toBe("Example Mail");
    });

    it("takes the first incoming server, which is the one the publisher recommends", () => {
        const two = FULL.replace(
            "<outgoingServer",
            `<incomingServer type="imap">
              <hostname>imap-backup.example.com</hostname><port>143</port><socketType>STARTTLS</socketType>
            </incomingServer>
            <outgoingServer`
        );
        expect(parseAutoconfig(two, "someone@example.com")?.imap.host).toBe("imap.example.com");
    });

    it("falls back on the port when the document does not say how the socket is protected", () => {
        const vague = FULL.replace("<socketType>SSL</socketType>", "").replace(
            "<socketType>STARTTLS</socketType>",
            ""
        );
        const found = parseAutoconfig(vague, "someone@example.com");
        expect(found?.imap.security).toBe("tls");
        expect(found?.smtp.security).toBe("starttls");
    });
});

describe("what it refuses", () => {
    it("answers nothing for a document with only half of itself", () => {
        const half = FULL.replace(/<outgoingServer[\s\S]*<\/outgoingServer>/, "");
        expect(parseAutoconfig(half, "someone@example.com")).toBeNull();
    });

    it("answers nothing for a port that is not one", () => {
        expect(parseAutoconfig(FULL.replace("<port>993</port>", "<port>0</port>"), "a@b.com")).toBeNull();
        expect(parseAutoconfig(FULL.replace("<port>993</port>", "<port>99999</port>"), "a@b.com")).toBeNull();
    });

    it("answers nothing for something that is not the document at all", () => {
        expect(parseAutoconfig("<html><body>404</body></html>", "a@b.com")).toBeNull();
        expect(parseAutoconfig("", "a@b.com")).toBeNull();
    });
});
