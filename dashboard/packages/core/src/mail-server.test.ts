/**
 * The mail server's pure half: the requests sent to the engine, the DNS read out
 * of it, the reports read into Polaris and the rules that decide who hears about
 * incoming mail.
 *
 * The requests are asserted byte for byte against the shapes in the engine's own
 * schema reference, because a wrong encoding (an array where the engine wants a
 * position-keyed object) is refused by the engine and only ever surfaces as a
 * setup that stops half way on a server nobody can see here.
 */

import * as dmarc from "./dmarc.js";
import * as dns from "./mail-dns.js";
import * as server from "./mail-server.js";
import { describe, expect, it } from "vitest";
import * as jmap from "./mail-server-jmap.js";

describe("the requests the engine is sent", () => {
    it("uses the engine's list and set encodings, not JSON arrays", () => {
        expect(jmap.listOf(["a", "b"])).toEqual({ "0": "a", "1": "b" });
        expect(jmap.setOf(["x", "y"])).toEqual({ x: true, y: true });
        expect(jmap.fromList({ "1": "b", "0": "a" })).toEqual(["a", "b"]);
    });

    it("declares the management capability on every request", () => {
        expect(jmap.jmapRequest([jmap.bootstrapCall({ hostname: "mail.example.com", domain: "example.com" })])).toEqual({
            using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
            methodCalls: [
                [
                    "x:Bootstrap/set",
                    {
                        update: {
                            singleton: {
                                serverHostname: "mail.example.com",
                                defaultDomain: "example.com",
                                requestTlsCertificate: true,
                                generateDkimKeys: true
                            }
                        }
                    },
                    "bootstrap"
                ]
            ]
        });
    });

    it("creates a domain the way the schema reference shows it", () => {
        const [name, args] = jmap.domainCreateCall("example.com");
        expect(name).toBe("x:Domain/set");
        expect(args).toEqual({
            create: {
                domain: {
                    name: "example.com",
                    aliases: {},
                    certificateManagement: { "@type": "Manual" },
                    dkimManagement: { "@type": "Automatic" },
                    dnsManagement: { "@type": "Manual" },
                    subAddressing: { "@type": "Enabled" }
                }
            }
        });
    });

    it("creates a mailbox as a User with one password and an optional quota", () => {
        const [, args] = jmap.accountCreateCall({
            name: "alice",
            domainId: "d1",
            password: "correct horse battery",
            quotaBytes: 5 * 1024 * 1024
        });
        const account = (args.create as Record<string, Record<string, unknown>>).account!;
        expect(account["@type"]).toBe("User");
        expect(account.credentials).toEqual({ "0": { "@type": "Password", secret: "correct horse battery" } });
        expect(account.quotas).toEqual({ maxDiskQuota: 5242880 });
        expect(account.roles).toEqual({ "@type": "User" });
    });

    it("makes a forward a mailing list of its recipients", () => {
        const [name, args] = jmap.forwardCreateCall({ name: "sales", domainId: "d1", recipients: ["a@x.test", "b@y.test"] });
        expect(name).toBe("x:MailingList/set");
        expect((args.create as Record<string, Record<string, unknown>>).forward!.recipients).toEqual({
            "a@x.test": true,
            "b@y.test": true
        });
    });

    it("routes outbound mail by quoting a route name, and refuses anything else", () => {
        expect(jmap.outboundRouteCall("polaris-relay")[1]).toEqual({
            update: { singleton: { route: { else: "'polaris-relay'" } } }
        });
        expect(() => jmap.outboundRouteCall("x' || 'y")).toThrow();
        const [, args] = jmap.relayRouteCreateCall({ host: "smtp.sendgrid.net", port: 587, implicitTls: false, username: "apikey", secret: "k" });
        expect((args.create as Record<string, Record<string, unknown>>).relay).toMatchObject({
            "@type": "Relay",
            address: "smtp.sendgrid.net",
            authSecret: { "@type": "Value", secret: "k" }
        });
    });

    it("reads created ids, and turns a refusal into the engine's own words", () => {
        const ok = { methodResponses: [["x:Domain/set", { created: { domain: { id: "d7" } } }, "domain"]] };
        expect(jmap.createdId(ok, "domain", "domain")).toBe("d7");
        const refused = {
            methodResponses: [
                ["x:Domain/set", { notCreated: { domain: { type: "alreadyExists", description: "Domain exists" } } }, "domain"]
            ]
        };
        expect(() => jmap.createdId(refused, "domain", "domain")).toThrow("Domain exists");
        const error = { methodResponses: [["error", { type: "forbidden", description: "No permission" }, "x"]] };
        expect(() => jmap.answerOf(error, "x")).toThrow(jmap.StalwartRefusal);
    });

    it("reads the report mailbox the standard way, and points a domain's reports at it", () => {
        expect(jmap.jmapMailRequest([]).using).toEqual(["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]);
        const [query, get] = jmap.unreadWithAttachmentsCalls("a1", 25);
        expect(query?.[1]).toMatchObject({ accountId: "a1", filter: { notKeyword: "$seen" }, limit: 25 });
        expect(get?.[1]).toMatchObject({ "#ids": { resultOf: "q", name: "Email/query", path: "/ids" } });
        expect(jmap.markSeenCall("a1", ["m1"])[1]).toEqual({ accountId: "a1", update: { m1: { "keywords/$seen": true } } });
        expect(jmap.domainReportAddressCall("d1", "dmarc-reports@example.com")[1]).toEqual({
            update: { d1: { reportAddressUri: "mailto:dmarc-reports@example.com" } }
        });
    });

    it("fills the session's download template, encoded, and keeps only its path", () => {
        const path = jmap.downloadPath("https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}", {
            accountId: "a1",
            blobId: "b/2",
            type: "application/gzip",
            name: "google.com!example.com.xml.gz"
        });
        expect(path).toBe("/jmap/download/a1/b%2F2/google.com!example.com.xml.gz?accept=application%2Fgzip");
    });
});

describe("the zone the engine publishes", () => {
    const zone = [
        "$ORIGIN example.com.",
        "@ 3600 IN MX 10 mail.example.com.",
        '@ IN TXT "v=spf1 mx -all"',
        "202609e._domainkey IN TXT (",
        '    "v=DKIM1; k=ed25519; "',
        '    "p=MCowBQYDK2VwAyEA" ) ; the signing key',
        '_dmarc IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@example.com"',
        '_smtp._tls IN TXT "v=TLSRPTv1; rua=mailto:postmaster@example.com"',
        "_imaps._tcp IN SRV 0 1 993 mail.example.com.",
        "autoconfig IN CNAME mail.example.com."
    ].join("\n");

    it("reads names, joins split TXT strings and follows the origin", () => {
        const records = dns.parseZoneFile(zone);
        expect(records.find((record) => record.type === "MX")).toMatchObject({
            name: "example.com",
            value: "mail.example.com",
            priority: 10,
            ttl: 3600
        });
        const dkim = records.find((record) => record.name === "202609e._domainkey.example.com");
        expect(dkim?.value).toBe("v=DKIM1; k=ed25519; p=MCowBQYDK2VwAyEA");
        expect(records.find((record) => record.type === "SRV")?.value).toBe("0 1 993 mail.example.com");
    });

    it("says what each record is for and which ones mail depends on", () => {
        const expected = dns.expectedMailRecords(dns.parseZoneFile(zone));
        const purposes = expected.map((record) => [dns.purposeOf(record), record.required]);
        expect(purposes).toContainEqual(["mx", true]);
        expect(purposes).toContainEqual(["dkim", true]);
        expect(purposes).toContainEqual(["tls-rpt", false]);
        expect(purposes).toContainEqual(["autoconfig", false]);
    });

    it("grades SPF by what it covers, and fails two of them", () => {
        const spf = dns.expectedMailRecords(dns.parseZoneFile(zone)).find((record) => record.purpose === "spf")!;
        expect(dns.gradeRecord(spf, ["v=spf1 mx -all"]).verdict).toBe("pass");
        expect(dns.gradeRecord(spf, ["v=spf1 mx include:_spf.google.com ~all"]).verdict).toBe("warn");
        expect(dns.gradeRecord(spf, ["v=spf1 include:_spf.google.com ~all"]).verdict).toBe("fail");
        expect(dns.gradeRecord(spf, ["v=spf1 mx -all", "v=spf1 a -all"]).verdict).toBe("fail");
        expect(dns.gradeRecord(spf, []).verdict).toBe("fail");
    });

    it("warns rather than fails for an optional record that is missing", () => {
        const tlsRpt = dns.expectedMailRecords(dns.parseZoneFile(zone)).find((record) => record.purpose === "tls-rpt")!;
        expect(dns.gradeRecord(tlsRpt, []).verdict).toBe("warn");
        const dkim = dns.expectedMailRecords(dns.parseZoneFile(zone)).find((record) => record.purpose === "dkim")!;
        expect(dns.gradeRecord(dkim, []).verdict).toBe("fail");
        expect(dns.gradeRecord(dkim, ["v=DKIM1; k=ed25519; p=MCowBQYDK2VwAyEA"]).verdict).toBe("pass");
    });

    it("adds the server to an existing SPF without dropping its other senders", () => {
        expect(dns.mergeSpf("v=spf1 include:_spf.google.com ~all", "v=spf1 mx -all")).toBe(
            "v=spf1 mx include:_spf.google.com ~all"
        );
        expect(dns.mergeSpf("v=spf1 MX include:_spf.google.com ~all", "v=spf1 mx -all")).toBeNull();
    });
});

describe("DMARC aggregate reports", () => {
    const document = {
        feedback: {
            report_metadata: {
                org_name: "google.com",
                email: "noreply-dmarc-support@google.com",
                report_id: "1234567890",
                date_range: { begin: "1757462400", end: "1757548799" }
            },
            policy_published: { domain: "example.com", p: "reject", sp: "reject", pct: "100" },
            record: [
                {
                    row: { source_ip: "203.0.113.9", count: "12", policy_evaluated: { disposition: "none", dkim: "pass", spf: "pass" } },
                    identifiers: { header_from: "example.com" },
                    auth_results: { dkim: { domain: "example.com", result: "pass", selector: "202609e" }, spf: { domain: "example.com", result: "pass" } }
                },
                {
                    row: { source_ip: "198.51.100.7", count: "3", policy_evaluated: { disposition: "reject", dkim: "fail", spf: "fail" } },
                    identifiers: { header_from: "example.com" },
                    auth_results: { spf: { domain: "spoofer.test", result: "pass" } }
                },
                { row: { source_ip: "not an address", count: "1", policy_evaluated: {} } }
            ]
        }
    };

    it("reads the report and drops a row whose source is not an address", () => {
        const report = dmarc.normalizeDmarcReport(document);
        expect(report.orgName).toBe("google.com");
        expect(report.begin.toISOString()).toBe("2025-09-10T00:00:00.000Z");
        expect(report.rows).toHaveLength(2);
        expect(report.rows[1]?.authSpf).toEqual([{ domain: "spoofer.test", result: "pass" }]);
    });

    it("counts a row as passing only on the receiver's aligned verdict", () => {
        const sources = dmarc.summarizeDmarcSources([dmarc.normalizeDmarcReport(document)]);
        expect(sources[0]).toMatchObject({ sourceIp: "198.51.100.7", verdict: "fail", failed: 3 });
        expect(sources[1]).toMatchObject({ sourceIp: "203.0.113.9", verdict: "pass", passed: 12 });
    });

    it("refuses a document that is not a report", () => {
        expect(() => dmarc.normalizeDmarcReport({ html: {} })).toThrow(dmarc.DmarcReportError);
    });
});

describe("ports, relays and mailboxes", () => {
    it("never calls a silent port 25 a failure", () => {
        expect(server.portVerdict(25, "timeout").verdict).toBe("unverified");
        expect(server.portVerdict(993, "timeout").verdict).toBe("warn");
        expect(server.portVerdict(993, "refused").verdict).toBe("fail");
        expect(server.portVerdict(465, "open").verdict).toBe("pass");
        // From behind the server's own router, a refusal may be the router's.
        expect(server.portVerdict(993, "refused", true).verdict).toBe("unverified");
        expect(server.portVerdict(993, "open", true).verdict).toBe("pass");
    });

    it("derives a regional relay host and refuses one without a region", () => {
        expect(server.resolveRelayHost({ provider: "ses", region: "eu-west-1" })).toBe("email-smtp.eu-west-1.amazonaws.com");
        expect(server.resolveRelayHost({ provider: "ses" })).toBeNull();
        expect(server.resolveRelayHost({ provider: "sendgrid" })).toBe("smtp.sendgrid.net");
        expect(server.mailRelaySchema.safeParse({ serverId: crypto.randomUUID(), provider: "custom" }).success).toBe(false);
    });

    it("takes a quota in megabytes and a password nobody pasted a newline into", () => {
        expect(server.quotaBytes(0)).toBeNull();
        expect(server.quotaBytes(2)).toBe(2097152);
        const base = { serverId: crypto.randomUUID(), domainId: "d1", localPart: "alice" };
        expect(server.mailboxCreateSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
        expect(server.mailboxCreateSchema.safeParse({ ...base, password: "long enough pass\nword" }).success).toBe(false);
        expect(server.mailboxCreateSchema.safeParse({ ...base, password: "long enough password" }).success).toBe(true);
    });
});

describe("rules on incoming mail", () => {
    const rule = { recipient: "billing@*", sender: "*@bank.example", includeSpam: false, enabled: true };
    const event = { spam: false, from: "alerts@bank.example", to: ["billing@example.com"], autoSubmitted: false };

    it("matches wildcards, case aside", () => {
        expect(server.wildcardMatches("*@Bank.example", "ALERTS@bank.example")).toBe(true);
        expect(server.wildcardMatches("a.b@x", "axb@x")).toBe(false);
        expect(server.inboundRuleMatches(rule, event)).toBe(true);
    });

    it("guards against the three ways a rule becomes a flood", () => {
        expect(server.inboundRuleMatches(rule, { ...event, spam: true })).toBe(false);
        expect(server.inboundRuleMatches(rule, { ...event, autoSubmitted: true })).toBe(false);
        expect(server.inboundRuleMatches({ ...rule, sender: "" }, { ...event, from: "mailer-daemon@example.com" })).toBe(false);
    });

    it("fails closed when the event does not say who a message was for", () => {
        expect(server.inboundRuleMatches(rule, { ...event, to: [] })).toBe(false);
    });

    it("reads only the two ingest events, and whatever keys name the message", () => {
        expect(server.readInboundEvent({ type: "auth.success", data: {} })).toBeNull();
        expect(server.readInboundEvent({ type: "message-ingest.spam", data: { from: "X@Y.test", rcptTo: ["a@b.test"] } })).toEqual({
            spam: true,
            from: "x@y.test",
            to: ["a@b.test"],
            autoSubmitted: false
        });
    });
});
