/**
 * What to do inside the router, spelled out per brand.
 *
 * Telling an operator to "forward 80 and 443" is only useful to someone who has done
 * it before: the menu is named differently on every box, the sign-in is rarely the
 * WiFi password, and the form asks for five values that have to be exactly right.
 * So the advice carries the address of the admin page, where to sign in, the menu
 * path, and the values to type - and the ones Polaris knows (its own LAN address,
 * the ports) are filled in rather than described.
 *
 * Pure: the domains panel renders it, and it is shared with the notification copy.
 * What is not verifiable from here is worded as such - the gateway is inferred from
 * this server's own address, and the sign-in on an ISP-supplied box is whatever the
 * ISP set, which is why the label on the router is always the first answer.
 */

import {
    inBlock,
    DEFAULT_PORT_BLOCKS,
    type PortBlocks,
    type PortPolicy
} from "@/lib/apps/port-block";

export type RouterBrand =
    | "zte"
    | "huawei"
    | "tplink"
    | "asus"
    | "fritzbox"
    | "netgear"
    | "mikrotik"
    | "unifi"
    | "openwrt"
    | "movistar"
    | "livebox"
    | "vodafone"
    | "sagemcom"
    | "nokia"
    | "xiaomi"
    | "linksys"
    | "dlink"
    | "mercusys"
    | "tenda"
    | "googlewifi"
    | "eero"
    | "other";

/**
 * What a guide can walk somebody through. A brand claims a topic only when its
 * steps were read off the vendor's own documentation (the URL sits next to them),
 * so a picker for one topic lists only the brands that have it - plus the generic
 * entry, which describes where to look rather than naming a menu.
 */
export type RouterTopic = "forward" | "dns";

/** One setting on the router's own pages, quoted as they show it. */
export interface RouterDnsSetting {
    /** Menu path to the page that holds it. */
    readonly path: string;
    /** The field or switch, as the page labels it. */
    readonly field: string;
    /** What goes in it: this server's LAN address, a DHCP option carrying that
     *  address, this server's IPv6 address, or the switch turned off. */
    readonly value: "address" | "dhcpOption6" | "addressV6" | "off";
    /** The control that commits it, when the vendor's docs name one. */
    readonly save: string | null;
    /** The vendor document the path and labels were read from. */
    readonly source: string;
}

/**
 * How devices on this network end up asking the network filter.
 *
 * `direct` routers hand this server's address to devices with their lease, so the
 * blocker sees each device. `relay` routers only let the router's own upstream be
 * changed: devices keep asking the router, which asks Polaris for them - blocking
 * still works, but every lookup is logged as coming from the router.
 */
export interface RouterDnsGuide {
    readonly mode: "direct" | "relay";
    readonly lan: RouterDnsSetting;
    /** Where the IPv6 DNS server announced to devices is set, when documented. */
    readonly ipv6: RouterDnsSetting | null;
    /** A feature of the router's own that sends devices somewhere else, to turn off. */
    readonly conflict: RouterDnsSetting | null;
}

/** A value the fixed-address form asks for, and where that value comes from. */
export interface RouterReserveField {
    /** What this brand's form calls it. */
    readonly label: string;
    readonly value: "name" | "mac" | "ip";
}

/**
 * How a brand pins this server to one address. Two shapes, because routers split
 * evenly between them: a table you add an entry to, and a device list where the
 * lease already there is made permanent. Telling an operator to "reserve it in the
 * DHCP settings" is only useful for the first kind, and only if they find the tab -
 * on ZTE the LAN page has three, and the reservation is not on the one named DHCP.
 */
export type RouterReservation =
    | {
          readonly kind: "form";
          readonly path: string;
          /** The control that starts a new entry. */
          readonly add: string;
          readonly fields: readonly RouterReserveField[];
          /** The control that commits it. */
          readonly save: string;
      }
    | {
          readonly kind: "device";
          readonly path: string;
          /** What to do to this server's entry once found, in the router's words. */
          readonly action: string;
      };

export interface RouterBrandGuide {
    readonly id: RouterBrand;
    readonly label: string;
    /** What this guide covers; see `RouterTopic`. */
    readonly topics: readonly RouterTopic[];
    /** The vendor document the forwarding steps were checked against. Null for the
     *  guides written from the device's own pages before sources were recorded. */
    readonly forwardSource: string | null;
    /** Pointing devices at the network filter, when this brand's docs say how. */
    readonly dns: RouterDnsGuide | null;
    /** The name its admin page answers on, when it has one besides the gateway IP. */
    readonly admin: string | null;
    /** The phone app that is the only way in, on a brand with no admin page at all.
     *  Sending somebody to the gateway address of one of those is sending them to a
     *  page that does not exist. */
    readonly app: string | null;
    /** The factory sign-in, as far as one brand-wide answer exists. */
    readonly signIn: string;
    /** Where and how to give this server a fixed address. */
    readonly reserve: RouterReservation;
    /** Menu path to the port-forwarding form. */
    readonly forwardPath: string;
    /** The fields that form asks for, when this brand names them its own way. */
    readonly forwardFields: readonly RouterFormField[] | null;
    /** The control that commits a rule, when the brand names it something particular. */
    readonly forwardSave: string | null;
    /** What this brand's Protocol field calls "both", when it offers one. Rules that
     *  differ only by transport are then a single rule, which is one fewer thing to
     *  get wrong in a form nobody enjoys. Null where the field is one-or-the-other. */
    readonly combinedProtocol: string | null;
    /** How long a rule's name may be, on a brand that caps it short enough to
     *  refuse the names Polaris writes. Null leaves them as they are. */
    readonly nameLimit: number | null;
    /** What still has to be done for a saved rule to be in force, on a brand that
     *  does not turn one on for you. */
    readonly forwardEnable: string | null;
    /** Menu path to whatever is holding 80 and 443, when the brand has a usual one. */
    readonly remotePath: string | null;
    /** What is different about this brand, in the operator's way. */
    readonly caution: string | null;
}

/** One rule to create. Both are the same shape; only the port differs. */
export interface RouterForwardRule {
    readonly name: string;
    readonly protocol: string;
    readonly port: number;
    /** The last port of a range, when the rule covers one. A rule that opens the
     *  whole block game servers are allocated from is written once and never
     *  revisited, which is the point of the range policy. */
    readonly endPort?: number;
}

/**
 * What a forwarding form asks for. Generic labels cover most brands, but some name
 * the same five things differently enough that an operator cannot map one to the
 * other - ZTE asks for a "LAN Host" and two port RANGES, and there is no row called
 * "internal port" anywhere on the page.
 */
export type RouterForwardValue =
    /** The rule's name. */
    | "name"
    /** TCP. */
    | "protocol"
    /** The port, once. */
    | "port"
    /** The port as a range, for forms whose port fields are `from ~ to`. */
    | "portRange"
    /** This server's LAN address. */
    | "ip"
    /** "any source", for forms that ask which WAN addresses the rule accepts. */
    | "anySource"
    /** The port, in a TCP-only box: filled for a TCP rule, left empty otherwise. */
    | "tcpPort"
    /** The port, in a UDP-only box: filled for a UDP rule, left empty otherwise. */
    | "udpPort";

export interface RouterFormField {
    readonly label: string;
    readonly value: RouterForwardValue;
}

/**
 * The generic forwarding advice: where to look, not a menu to open. The "other"
 * entry is made of it, and so are the brands whose forwarding pages were not
 * checked against a document - they do not claim the topic, so no forwarding
 * picker lists them, but a guide is a whole guide whatever it is looked up for.
 */
const LOOK_FOR_IT: Omit<RouterBrandGuide, "id" | "label" | "topics" | "forwardSource" | "dns"> = {
    admin: null,
    app: null,
    signIn: "The user and password on the label underneath the router - on most boxes this is not the WiFi password. If it was changed and is lost, a factory reset is the only way back in.",
    reserve: {
        kind: "form",
        path: "the DHCP or LAN settings, under a name like Address Reservation, DHCP Binding or Static Lease",
        add: "the button that adds an entry",
        fields: [
            // i18n-ignore said in the reader's words by admin/domains/router-words.ts
            { label: "MAC address", value: "mac" },
            // i18n-ignore said in the reader's words by admin/domains/router-words.ts
            { label: "IP address", value: "ip" }
        ],
        save: "Save"
    },
    forwardPath:
        "Look for Port forwarding, Virtual server, NAT/PAT or Applications & Gaming - the same form under four different names.",
    forwardFields: null,
    forwardSave: null,
    combinedProtocol: null,
    nameLimit: null,
    // Said for every unknown brand because it is the failure with nothing to
    // see: the rule is listed, its values are right, and it does nothing.
    forwardEnable:
        "If the rule has an Enable or Status switch, turn it on - some firmware saves a new rule switched off.",
    remotePath: "Look for Remote management, Web access from WAN or Remote administration.",
    caution: null
};

export const ROUTER_BRANDS: readonly RouterBrandGuide[] = [
    {
        id: "zte",
        // i18n-ignore a brand's name
        label: "ZTE",
        // Written from the H3640's own pages; ZTE publishes no manual for ISP firmware.
        // DNS: the DHCP Server page of ZTE's own guides for the same web interface -
        // https://www.zteitalia.it/wp-content/uploads/2020/11/ZXHN-H2640V1.0MaintenanceManagement.pdf
        // (5.3.1, "ISP DNS", "Primary DNS", "Apply") and the H3140 guide at guide.aruba.it,
        // worded identically. The H3640 shows that page as a tab of Local Network > LAN,
        // beside DHCP Binding, with no IPv4 level between. Primary DNS can only be typed
        // once ISP DNS is off (bandaancha.eu/foros/cambiar-dns-router-h3600-v9-1747773);
        // some ISP builds lock or drop the change (bandaancha.eu/foros
        // /puede-cambiar-ip-interfaz-wan-zte-h3640-1760078, Hyperoptic's H298A manual), and
        // the ISP's IPv6 keeps handing devices its own DNS (bandaancha.eu/foros
        // /desactivar-ipv6-router-pihole-bloqueador-1749414) - both in notes.zte.
        topics: ["forward", "dns"],
        forwardSource: null,
        dns: {
            mode: "direct",
            lan: {
                path: "Local Network > LAN > DHCP Server, with ISP DNS set to Off",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Primary DNS",
                value: "address",
                save: "Apply",
                source: "https://www.zteitalia.it/wp-content/uploads/2020/11/ZXHN-H2640V1.0MaintenanceManagement.pdf"
            },
            ipv6: null,
            conflict: null
        },
        admin: null,
        app: null,
        signIn: "The user and password printed on the label underneath the router. On an ISP box the user is usually `admin` and the password is the one on the label, not the WiFi key.",
        reserve: {
            kind: "form",
            // Not the DHCP Server tab, which is where the name sends everyone first:
            // that one sets the pool. The binding tab is the one that pins an address.
            path: "Local Network > LAN > DHCP Binding",
            add: "New Item",
            fields: [
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "Name", value: "name" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "MAC Address", value: "mac" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "IP Address", value: "ip" }
            ],
            save: "Create New Item"
        },
        forwardPath: "Internet > Security > Port Forwarding",
        // Verbatim from the H3640 form, in its order. None of the labels match the
        // generic ones: the destination is "LAN Host", both port fields are ranges,
        // and there is a WAN source range that has to be left wide open.
        forwardFields: [
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Name", value: "name" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Protocol", value: "protocol" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "WAN Host IP Address", value: "anySource" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "LAN Host", value: "ip" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "WAN Port", value: "portRange" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "LAN Host Port", value: "portRange" }
        ],
        forwardSave: "Create New Item",
        // The Protocol dropdown carries a both-at-once entry, so the two call rules
        // are one rule on this brand. Worth the special case: a rule typed into a
        // router by hand is a rule that can be mistyped or left switched off.
        combinedProtocol: "TCP And UDP",
        // The Name field is capped at 16 characters and the form refuses anything
        // longer outright, so `polaris-games-tcp` cannot be typed at all.
        nameLimit: 16,
        forwardEnable:
            "The rule is created switched off. Set it to on in the list of rules once it is saved, or the ports stay closed behind a rule that looks right.",
        remotePath:
            "Management & Diagnosis > Remote management (some builds keep it under Internet > Security > Access control)",
        caution:
            "ZTE firmware supplied by an ISP reserves 80, 443, 21 and 7547 for its own management and refuses to forward them. If the form rejects the rule, the ports cannot be opened on this router - publish Polaris through a tunnel instead, under Advanced below."
    },
    {
        id: "huawei",
        // i18n-ignore a brand's name
        label: "Huawei",
        // Written from the device's own pages; ISP firmware has no public manual.
        // DNS: Huawei's web page reference for the HG8145V5/HG8245H5 family, as
        // Makedonski Telekom publishes it (1.6.2.3, "Primary DNS Server", "Apply").
        // Older units such as the HG8245H keep the page directly under LAN
        // (https://cleanbrowsing.org/support/routers/huawei-hg8240).
        topics: ["forward", "dns"],
        forwardSource: null,
        dns: {
            mode: "direct",
            lan: {
                path: "LAN > DHCP Server Configuration (Advanced Configuration > LAN Configuration on newer models)",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Primary DNS Server",
                value: "address",
                save: "Apply",
                source: "https://www.telekom.mk/content/upatstva/Huawei%20HG8145v5,%20web%20page%20guide.pdf"
            },
            ipv6: null,
            conflict: null
        },
        admin: "http://192.168.100.1",
        app: null,
        signIn: "The user and password on the label. ISP units keep port forwarding behind an installer account the label does not carry - ask your provider for it if the menu is missing.",
        reserve: {
            kind: "form",
            path: "LAN > DHCP Static IP Configuration",
            add: "New",
            fields: [
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "MAC Address", value: "mac" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "IP Address", value: "ip" }
            ],
            save: "Apply"
        },
        forwardPath: "Forward Rules > Port Mapping Configuration, with Type set to Custom",
        forwardFields: null,
        forwardSave: null,
        combinedProtocol: null,
        nameLimit: null,
        forwardEnable: null,
        remotePath:
            "Security > ACL Rules, which is what usually publishes the admin page on the WAN side",
        caution: null
    },
    {
        id: "tplink",
        // i18n-ignore a brand's name
        label: "TP-Link",
        // DNS: https://www.tp-link.com/support/faq/3230/ (Archer web interface).
        topics: ["forward", "dns"],
        forwardSource: "https://www.tp-link.com/us/support/faq/1379/",
        dns: {
            mode: "direct",
            lan: {
                path: "Advanced > Network > DHCP Server",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Primary DNS",
                value: "address",
                save: "Save",
                source: "https://www.tp-link.com/support/faq/3230/"
            },
            ipv6: null,
            conflict: null
        },
        admin: "http://tplinkwifi.net",
        app: null,
        signIn: "The account you created on first setup. A router never set up asks for `admin` / `admin`.",
        reserve: {
            kind: "form",
            path: "Advanced > Network > DHCP Server > Address Reservation",
            add: "Add",
            fields: [
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "MAC Address", value: "mac" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "IP Address", value: "ip" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "Description", value: "name" }
            ],
            save: "Save"
        },
        forwardPath: "Advanced > NAT Forwarding > Virtual Servers > Add",
        forwardFields: null,
        forwardSave: null,
        combinedProtocol: null,
        nameLimit: null,
        forwardEnable: null,
        remotePath: "Advanced > System Tools > Administration > Remote Management",
        caution: null
    },
    {
        id: "asus",
        // i18n-ignore a brand's name
        label: "ASUS",
        // DNS: https://www.asus.com/support/faq/1011703/ - left blank, the router answers itself.
        topics: ["forward", "dns"],
        forwardSource: "https://www.asus.com/support/faq/1037906/",
        dns: {
            mode: "direct",
            lan: {
                path: "LAN > DHCP Server",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "DNS Server",
                value: "address",
                save: "Apply",
                source: "https://www.asus.com/support/faq/1011703/"
            },
            ipv6: null,
            conflict: null
        },
        admin: "http://router.asus.com",
        app: null,
        signIn: "The account you created on first setup, or `admin` / `admin` on one never set up.",
        reserve: {
            kind: "form",
            path: "LAN > DHCP Server, with Enable Manual Assignment set to Yes",
            add: "the + button under Manually Assigned IP around the DHCP list",
            fields: [
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "MAC Address", value: "mac" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "IP Address", value: "ip" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "Name (optional)", value: "name" }
            ],
            save: "Apply"
        },
        forwardPath:
            "WAN > Virtual Server / Port Forwarding, with Enable Port Forwarding set to Yes",
        forwardFields: null,
        forwardSave: null,
        combinedProtocol: null,
        nameLimit: null,
        forwardEnable: null,
        remotePath: "Administration > System > Enable Web Access from WAN",
        caution: null
    },
    {
        id: "fritzbox",
        // i18n-ignore a brand's name
        label: "FRITZ!Box",
        // DNS: https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-7490/165_Configuring-different-DNS-servers-in-the-FRITZ-Box/
        topics: ["forward", "dns"],
        forwardSource: null,
        dns: {
            mode: "direct",
            lan: {
                path: "Home Network > Network > Network Settings > Additional Settings > IPv4 Settings",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Local DNS server",
                value: "address",
                save: "Apply",
                source: "https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-7490/165_Configuring-different-DNS-servers-in-the-FRITZ-Box/"
            },
            ipv6: {
                path: "Home Network > Network > Network Settings > Additional Settings > IPv6 Settings",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Local DNSv6 server",
                value: "addressV6",
                save: "Apply",
                source: "https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-7490/165_Configuring-different-DNS-servers-in-the-FRITZ-Box/"
            },
            conflict: null
        },
        admin: "http://fritz.box",
        app: null,
        signIn: "The FRITZ!Box password on the label or on the card that came with it. There is no user name.",
        reserve: {
            kind: "device",
            path: "Home Network > Network > Network Connections",
            action: 'open this server with the pencil button and tick "Always assign this network device the same IPv4 address"'
        },
        forwardPath: "Internet > Permit Access > Port Sharing > Add Device for Sharing",
        forwardFields: null,
        forwardSave: null,
        combinedProtocol: null,
        nameLimit: null,
        forwardEnable: null,
        remotePath: "Internet > Permit Access > FRITZ!Box Services",
        caution:
            "It shares ports per device: pick this server, then add one sharing for 80 and one for 443. Turn on the advanced view if the menu is not there."
    },
    {
        id: "netgear",
        // i18n-ignore a brand's name
        label: "NETGEAR",
        // DNS: https://kb.netgear.com/30510/How-do-I-set-static-DNS-servers-on-my-NETGEAR-router
        // Relay, because consumer NETGEAR firmware hands its own LAN address to devices
        // whatever is set here (NETGEAR community moderator, community.netgear.com
        // /discussions/home-wifi-routers-nighthawk/changing-dns-in-router-settings/1543576).
        topics: ["forward", "dns"],
        forwardSource:
            "https://kb.netgear.com/24290/How-do-I-add-a-custom-port-forwarding-service-on-my-NETGEAR-router",
        dns: {
            mode: "relay",
            lan: {
                path: "Internet > Domain Name Server (DNS) Address",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Use these DNS Servers",
                value: "address",
                save: "Apply",
                source: "https://kb.netgear.com/30510/How-do-I-set-static-DNS-servers-on-my-NETGEAR-router"
            },
            ipv6: null,
            conflict: null
        },
        admin: "http://routerlogin.net",
        app: null,
        signIn: "`admin` with the password you set. A router never set up uses `admin` / `password`.",
        reserve: {
            kind: "form",
            path: "ADVANCED > Setup > LAN Setup > Address Reservation",
            add: "Add",
            fields: [
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "IP Address", value: "ip" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "MAC Address", value: "mac" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "Device Name", value: "name" }
            ],
            save: "Add"
        },
        forwardPath:
            "ADVANCED > Advanced Setup > Port Forwarding / Port Triggering > Add Custom Service",
        forwardFields: null,
        forwardSave: null,
        combinedProtocol: null,
        nameLimit: null,
        forwardEnable: null,
        remotePath: "ADVANCED > Advanced Setup > Remote Management",
        caution: null
    },
    {
        id: "mikrotik",
        // i18n-ignore a brand's name
        label: "MikroTik",
        // DNS: https://help.mikrotik.com/docs/spaces/ROS/pages/24805500/DHCP (network dns-server).
        topics: ["forward", "dns"],
        forwardSource: "https://help.mikrotik.com/docs/spaces/ROS/pages/3211299/NAT",
        dns: {
            mode: "direct",
            lan: {
                path: "IP > DHCP Server > Networks",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "DNS Servers",
                value: "address",
                save: null,
                source: "https://help.mikrotik.com/docs/spaces/ROS/pages/24805500/DHCP"
            },
            ipv6: null,
            conflict: null
        },
        admin: "http://192.168.88.1",
        app: null,
        signIn: "`admin`, with no password on a router still at defaults.",
        reserve: {
            kind: "device",
            path: "IP > DHCP Server > Leases",
            action: 'select the lease showing this server and press "Make Static"'
        },
        forwardPath: "IP > Firewall > NAT > Add, chain dstnat",
        forwardFields: null,
        forwardSave: null,
        combinedProtocol: null,
        nameLimit: null,
        forwardEnable: null,
        remotePath: "IP > Services, where the www and www-ssl services hold 80 and 443",
        caution:
            "The form is not a port-forward form: set chain=dstnat, protocol=tcp, dst-port=80,443, in-interface to the WAN interface, then action=dst-nat with to-addresses set to this server."
    },
    {
        id: "unifi",
        // i18n-ignore a brand's name
        label: "UniFi",
        // DNS: https://help.ui.com/hc/en-us/articles/17484948645015 (DNS Troubleshooting Guide).
        // Ad Blocking: https://help.ui.com/hc/en-us/articles/9794438523799 - with it on,
        // clients set to another DNS server are redirected to the gateway's own. Its
        // switch lives in Content Filter: https://help.ui.com/hc/en-us/articles/12568927589143.
        // Forwarding: the help.ui.com article below names Settings > Policy Engine > Port
        // Forwarding on Network 9.4 (Policy Table > Create New Policy on 9.3); earlier
        // versions keep it under Settings > Routing (wundertech.net/how-to-port-forward-on-unifi-devices),
        // and it warns a rule does nothing behind another NAT. Fixed IP: the client's own
        // settings, which need a UniFi gateway
        // (unihosted.com/blog/how-to-reserve-an-ip-address-on-a-unifi-controller).
        topics: ["forward", "dns"],
        forwardSource: "https://help.ui.com/hc/en-us/articles/235723207",
        dns: {
            mode: "direct",
            lan: {
                path: "UniFi Network > Settings > Networks > [your network] > DHCP Service Management",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "DNS Server",
                value: "address",
                save: null,
                source: "https://help.ui.com/hc/en-us/articles/17484948645015"
            },
            ipv6: null,
            conflict: {
                path: "Settings > CyberSecure > Content Filter",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Ad Blocking",
                value: "off",
                save: null,
                source: "https://help.ui.com/hc/en-us/articles/12568927589143"
            }
        },
        ...LOOK_FOR_IT,
        reserve: {
            kind: "device",
            path: "UniFi Network > Client Devices",
            action: 'open its settings and turn on "Fixed IP Address", keeping the address it has now'
        },
        forwardPath:
            "UniFi Network > Settings > Policy Engine > Port Forwarding (Settings > Routing > Port Forwarding before Network 9.4)",
        forwardEnable: null,
        caution:
            "A rule does nothing while the gateway's own WAN address is a private one (10.x, 192.168.x or 100.64.x): another router or the provider's CGNAT sits in front of it, and that is where the ports have to be opened."
    },
    {
        id: "openwrt",
        // i18n-ignore a brand's name
        label: "OpenWrt",
        // DNS: https://openwrt.org/docs/guide-user/base-system/dhcp_configuration ("Providing custom DNS with DHCP").
        // Forwarding: Network > Firewall per the firewall page below; the Port Forwards tab
        // and its fields as LuCI's own guide words them (mirrored at
        // gogs.librecmc.org/libreCMC/libreCMC/wiki/Port_Forwards). Static leases: the
        // "Static leases" section of the DHCP page above.
        topics: ["forward", "dns"],
        forwardSource: "https://openwrt.org/docs/guide-user/firewall/firewall_configuration",
        dns: {
            mode: "direct",
            lan: {
                path: "Network > Interfaces > LAN > Edit > DHCP Server > General Setup",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "DHCP-Options",
                value: "dhcpOption6",
                save: null,
                source: "https://openwrt.org/docs/guide-user/base-system/dhcp_configuration"
            },
            ipv6: {
                path: "Network > Interfaces > LAN > Edit > DHCP Server > IPv6 Settings",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Announce IPv4/6 DNS servers",
                value: "addressV6",
                save: null,
                source: "https://openwrt.org/docs/guide-user/base-system/dhcp_configuration"
            },
            conflict: null
        },
        ...LOOK_FOR_IT,
        reserve: {
            kind: "form",
            path: "Network > DHCP and DNS > Static Leases",
            add: "Add",
            fields: [
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "Hostname", value: "name" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "MAC address", value: "mac" },
                // i18n-ignore the router's own label, quoted as its page shows it
                { label: "IPv4 address", value: "ip" }
            ],
            save: "Save & Apply"
        },
        forwardPath: "Network > Firewall > Port Forwards > Add",
        forwardFields: [
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Name", value: "name" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Protocol", value: "protocol" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "External port", value: "port" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Internal IP address", value: "ip" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Internal port", value: "port" }
        ],
        forwardSave: "Save & Apply",
        combinedProtocol: "TCP+UDP",
        forwardEnable: null,
        remotePath: null,
        caution: "Leave External zone on wan and Internal zone on lan."
    },
    {
        id: "movistar",
        // i18n-ignore the provider's name, which is what the box is known by
        label: "Movistar / O2",
        // The Askey and Mitrastar HGU that Movistar and O2 both ship. Forwarding: Movistar's
        // own knowledge base (the Puertos section of 192.168.1.1, or the Smart WiFi app);
        // that portal is Spanish only, so its labels are quoted in Spanish. Sign-in: the
        // sticker underneath, not the WiFi key (Movistar's blog,
        // comunidad.movistar.es/t5/Blog-Movisfera/.../ba-p/2297521). Fixed IP: the
        // advanced menu's Static IP Lease List (bandaancha.eu/foros
        // /como-abrir-puertos-hgu-movistar-o2-1746287). No DNS topic: the portal has no
        // DNS field, and a change made in the advanced menu reverts on restart
        // (bandaancha.eu/foros/cambiar-dns-routers-movistar-1760943).
        topics: ["forward"],
        forwardSource:
            "https://comunidad.movistar.es/kb/Router/c%C3%B3mo-abrir-los-puertos-de-tu-router-movistar/3613957",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://192.168.1.1",
        signIn: "The password on the sticker underneath the router, which is not the WiFi key.",
        reserve: {
            kind: "form",
            path: "the advanced settings (Configuración avanzada) > Advanced Setup > LAN > Static IP Lease List",
            add: "Add Entries",
            fields: [
                // i18n-ignore said in the reader's words by admin/domains/router-words.ts
                { label: "MAC address", value: "mac" },
                // i18n-ignore said in the reader's words by admin/domains/router-words.ts
                { label: "IP address", value: "ip" }
            ],
            save: "the save button at the bottom of the page"
        },
        forwardPath: "Puertos",
        forwardSave: "Añadir",
        forwardEnable: null,
        caution:
            "The portal is only in Spanish. If Puertos is missing on a newer unit, the Smart WiFi app opens ports too. A firmware update from Movistar can undo changes made in the advanced menu, so check the rules again if the ports close."
    },
    {
        id: "livebox",
        // i18n-ignore the provider's name, which is what the box is known by
        label: "Orange / Jazztel Livebox",
        // Livebox Fibra (Arcadyan) and Livebox 6 (Sagemcom), Spanish-only firmware. Path,
        // sign-in and the add button: comparaiso.es/gestiones/router/orange and
        // bandaancha.eu/foros/ayuda-abrir-puertos-livebox-fibra-me-1726507 (NAT/PAT). The
        // firewall level and one-port-per-rule limits: bandaancha.eu/foros
        // /livebox-fibra-no-abre-puertos-1731559 and /no-puedo-abrir-puertos-livebox-fibra-1741169.
        // No DNS topic: the Livebox hands out itself and its DNS cannot be changed
        // (bandaancha.eu/foros/cambiar-dns-router-livebox-1740478).
        topics: ["forward"],
        forwardSource: "https://bandaancha.eu/foros/ayuda-abrir-puertos-livebox-fibra-me-1726507",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://192.168.1.1",
        signIn: "`admin`, with the password on the sticker on the back of the Livebox.",
        forwardPath: "Configuración avanzada > Configuración de red > NAT/PAT",
        forwardSave: "Añadir",
        forwardEnable: null,
        caution:
            "The interface is only in Spanish. Forwarded ports stay closed while the Livebox firewall is on a medium or high level - set it to the lowest one. It takes one port per rule, not a range. Its DNS server cannot be changed, so the network filter has to be set on each device instead."
    },
    {
        id: "vodafone",
        // i18n-ignore the provider's name, which is what the box is known by
        label: "Vodafone (Sercomm)",
        // Sercomm H500-s and H300s, Spanish firmware. Path, address and expert mode:
        // roams.es/companias-telefonicas/vodafone/guias/internet-fibra/abrir-puertos-router/.
        // Aplicar at the bottom, and the static DHCP entry on the expert LAN page:
        // bandaancha.eu/foros/no-consigo-abrir-puertos-vodafone-h-500-1734056. No DNS
        // topic: the DNS can only be set from firmware 3.6.13, as admin, and the steps
        // are not documented (bandaancha.eu/foros/nuevo-firmware-3-6-13-h-500-s-1746695).
        topics: ["forward"],
        forwardSource:
            "https://roams.es/companias-telefonicas/vodafone/guias/internet-fibra/abrir-puertos-router/",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://192.168.0.1",
        signIn: "The user and password printed underneath the router.",
        reserve: {
            kind: "form",
            path: "Configuración > LAN, with Modo Experto selected",
            add: "the button that adds an entry",
            fields: [
                // i18n-ignore said in the reader's words by admin/domains/router-words.ts
                { label: "MAC address", value: "mac" },
                // i18n-ignore said in the reader's words by admin/domains/router-words.ts
                { label: "IP address", value: "ip" }
            ],
            save: "Aplicar"
        },
        forwardPath: "Internet > Redirección de puertos > +, with Modo Experto selected",
        forwardSave: "Aplicar",
        forwardEnable: null,
        caution:
            "Switch the menu at the top from Modo Básico to Modo Experto, or the section is not there. Aplicar is at the bottom of the page: leaving without it drops the rule."
    },
    {
        id: "sagemcom",
        // i18n-ignore a brand's name
        label: "Sagemcom",
        // Every Sagemcom here is an ISP build, and the builds differ: Access Control >
        // Port Forwarding on the F@st 3890 (source), Advanced Setup > NAT on the F@st
        // 3864 (portforward.com/sagemcom/fast-3864v3hp/). A Livebox 6 is a Sagemcom too.
        topics: ["forward"],
        forwardSource: "https://portforward.com/sagemcom/fast-3890v3/",
        dns: null,
        ...LOOK_FOR_IT,
        forwardPath:
            "Access Control > Port Forwarding (Advanced Setup > NAT on some provider builds)",
        caution:
            "Menus differ with each provider's firmware. An Orange or Jazztel Livebox 6 is a Sagemcom: pick Orange / Jazztel Livebox instead."
    },
    {
        id: "nokia",
        // i18n-ignore a brand's name
        label: "Nokia (fibre ONT)",
        // The G-240W family providers ship: Application > Port Forwarding, from a
        // provider's full manual for the G-240W-C (INEA, source), matching
        // portforward.com/nokia/g-240w-b/.
        topics: ["forward"],
        forwardSource:
            "https://www.inea.pl/sites/default/files/2025-02/ONT%20NOKIA%20G-240W-C_instrukcja%20pelna%20%282018-07-03%29.pdf",
        dns: null,
        ...LOOK_FOR_IT,
        forwardPath: "Application > Port Forwarding"
    },
    {
        id: "xiaomi",
        // i18n-ignore a brand's name
        label: "Xiaomi",
        // cfos.de/en/cfos-personal-net/port-forwarding/xiaomi-miwifi-mini.htm, the same on
        // the Mi 3C (xiaomi-mi-3c.htm): Advanced > Port forwarding > Add rule, a range
        // section for several ports, and a restart afterwards.
        topics: ["forward"],
        forwardSource:
            "https://cfos.de/en/cfos-personal-net/port-forwarding/xiaomi-miwifi-mini.htm",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://miwifi.com",
        signIn: "The admin password chosen when the router was first set up.",
        forwardPath: "Advanced > Port forwarding > Add rule",
        forwardEnable:
            "Restart the router from the menu under its name once the rules are listed - they take effect after the restart.",
        caution: "A run of ports goes in the Range forwarding section, below the single-port one."
    },
    {
        id: "linksys",
        // i18n-ignore a brand's name
        label: "Linksys",
        // Linksys Smart Wi-Fi. "Both" in the Protocol list: the same Linksys article family
        // (support.linksys.com/kb/article/3011/).
        topics: ["forward"],
        forwardSource: "https://support.linksys.com/kb/article/318",
        dns: null,
        ...LOOK_FOR_IT,
        forwardPath:
            "Router Settings > Security > Apps and Gaming > Single Port Forwarding > Add a new Single Port Forwarding",
        forwardFields: [
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Application name", value: "name" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "External Port", value: "port" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Internal Port", value: "port" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Protocol", value: "protocol" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Device IP#", value: "ip" }
        ],
        forwardSave: "Save",
        combinedProtocol: "Both",
        forwardEnable:
            'Tick "Enabled" on each rule, then press Apply - Save alone does not put it in force.'
    },
    {
        id: "dlink",
        // i18n-ignore a brand's name
        label: "D-Link",
        topics: ["forward"],
        forwardSource:
            "https://www.dlink.com/en/support/faq/routers/mydlink-routers/dir-868l/how-do-i-configure-port-forwarding-on-my-router",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://dlinkrouter.local",
        signIn: "The Admin password you set. On a router never set up, leave it blank.",
        forwardPath: "Features > Port Forwarding > Add Rule",
        forwardFields: [
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Name", value: "name" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Local IP", value: "ip" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "TCP Port", value: "tcpPort" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "UDP Port", value: "udpPort" }
        ],
        forwardSave: "Apply",
        forwardEnable: null,
        caution:
            "The form has a TCP Port and a UDP Port box: put the port in the one matching the rule and leave the other empty. Leave Schedule on Always Enable."
    },
    {
        id: "mercusys",
        // i18n-ignore a brand's name
        label: "Mercusys",
        // Address reservation: https://www.mercusys.com/faq-1030/. Admin name: the DNS FAQ,
        // https://www.mercusys.com/faq-768.
        topics: ["forward"],
        forwardSource: "https://www.mercusys.com/faq-902",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://mwlogin.net",
        signIn: "The password you created on first setup.",
        reserve: {
            kind: "form",
            path: "Advanced > Network > DHCP Server > Address Reservation",
            add: "Add",
            fields: [
                // i18n-ignore said in the reader's words by admin/domains/router-words.ts
                { label: "MAC address", value: "mac" },
                // i18n-ignore said in the reader's words by admin/domains/router-words.ts
                { label: "IP address", value: "ip" }
            ],
            save: "Save"
        },
        forwardPath: "Advanced > NAT Forwarding > Port Forwarding > Add",
        forwardFields: [
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Service Name", value: "name" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Device IP Address", value: "ip" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "External Port", value: "port" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Internal Port", value: "port" },
            // i18n-ignore the router's own label, quoted as its page shows it
            { label: "Protocol", value: "protocol" }
        ],
        forwardSave: "Save",
        forwardEnable: null
    },
    {
        id: "tenda",
        // i18n-ignore a brand's name
        label: "Tenda",
        // microcenter.com/tech_center/article/8323 (Virtual Server under Advanced Settings,
        // Both, the Enable tick); address and default password from
        // cfos.de/en/cfos-personal-net/port-forwarding/tenda-ac6-v1.htm.
        topics: ["forward"],
        forwardSource:
            "https://www.microcenter.com/tech_center/article/8323/how-to-forward-or-open-a-port-on-a-tenda-router",
        dns: null,
        ...LOOK_FOR_IT,
        admin: "http://192.168.0.1",
        signIn: "The password you set, or `admin` on a router never set up.",
        forwardPath: "Advanced Settings > Virtual Server",
        combinedProtocol: "Both",
        forwardEnable: 'Tick "Enable" on the rule, then press Apply or OK.'
    },
    {
        id: "googlewifi",
        // i18n-ignore a brand's name
        label: "Google / Nest Wifi",
        // App only. Forwarding: support.google.com/googlenest/answer/6274503 (Port
        // management, TCP/UDP; cloud services: googlenestcommunity.com/t5/Nest-Wifi
        // /Port-forwarding-issue/m-p/394872). Reservation: /answer/6274660. DNS:
        // /answer/6274141 - the Wifi point is a DNS proxy, so devices keep asking it.
        topics: ["forward", "dns"],
        forwardSource: "https://support.google.com/googlenest/answer/6274503",
        dns: {
            mode: "relay",
            lan: {
                path: "Google Home app > Wi-Fi > Network settings > Advanced Networking > DNS",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Custom",
                value: "address",
                save: "Save",
                source: "https://support.google.com/googlenest/answer/6274141"
            },
            ipv6: null,
            conflict: null
        },
        ...LOOK_FOR_IT,
        app: "Google Home",
        signIn: "The Google account that owns the network, in the app.",
        reserve: {
            kind: "device",
            path: "Google Home app > Wi-Fi > Settings > Advanced Networking > DHCP IP reservations",
            action: "add a reservation for it, keeping the address it has now"
        },
        forwardPath:
            "Google Home app > Wi-Fi > Settings > Advanced Networking > Port management > Add",
        forwardSave: "Save",
        combinedProtocol: "TCP/UDP",
        forwardEnable: null,
        remotePath: null,
        caution:
            "There is no admin page: everything is in the app. If Port management is missing, turn on cloud services in the app's privacy settings."
    },
    {
        id: "eero",
        // i18n-ignore a brand's name
        label: "eero",
        // App only. Forwarding and reservations, one page: support.eero.com/hc/en-us/articles/207908443.
        // DNS: support.eero.com/hc/articles/360059988432 - greyed out while eero Plus
        // filters are on, and saving restarts the network. Relay: eero answers devices
        // itself (Local DNS caching, support.eero.com/hc/en-us/articles/207613326).
        topics: ["forward", "dns"],
        forwardSource: "https://support.eero.com/hc/en-us/articles/207908443",
        dns: {
            mode: "relay",
            lan: {
                path: "eero app > Settings > Advanced networking > DNS",
                // i18n-ignore the router's own label, quoted as its page shows it
                field: "Custom DNS",
                value: "address",
                save: "Save",
                source: "https://support.eero.com/hc/articles/360059988432"
            },
            ipv6: null,
            conflict: null
        },
        ...LOOK_FOR_IT,
        app: "eero",
        signIn: "The eero account that owns the network, in the app.",
        reserve: {
            kind: "device",
            path: "eero app > Settings > Advanced networking > Reservations & port forwarding",
            action: "reserve the address it has now"
        },
        forwardPath:
            "eero app > Settings > Advanced networking > Reservations & port forwarding, on this server's reservation",
        forwardSave: "Save",
        forwardEnable: null,
        remotePath: null,
        caution:
            "There is no admin page: everything is in the app. A port is opened on a reservation, so reserve this server's address first."
    },
    {
        id: "other",
        // i18n-ignore said in the reader's words by admin/domains/router-words.ts
        label: "Another brand",
        topics: ["forward", "dns"],
        forwardSource: null,
        dns: null,
        ...LOOK_FOR_IT
    }
];

/** Fallback for anything not in the list, so a lookup always returns a guide. */
const GENERIC = ROUTER_BRANDS[ROUTER_BRANDS.length - 1]!;

/** The brands a picker for this topic offers, the generic entry last. */
export function routerBrandsFor(topic: RouterTopic): readonly RouterBrandGuide[] {
    return ROUTER_BRANDS.filter((entry) => entry.topics.includes(topic));
}

export function routerGuide(brand: RouterBrand): RouterBrandGuide {
    return ROUTER_BRANDS.find((entry) => entry.id === brand) ?? GENERIC;
}

/** Substrings that identify a brand in a `Server` header, most specific first. */
const SIGNATURES: readonly (readonly [RouterBrand, readonly string[]])[] = [
    ["zte", ["zte"]],
    ["huawei", ["huawei", "echolife"]],
    ["tplink", ["tp-link", "tplink"]],
    ["asus", ["asus"]],
    ["fritzbox", ["fritz"]],
    ["netgear", ["netgear"]],
    ["mikrotik", ["mikrotik", "routeros"]],
    // The provider boxes by their own names only, before the makers they are built
    // by: a Livebox that also names Sagemcom is still best walked through as a
    // Livebox. A bare Arcadyan, Sercomm or Askey says nothing about the provider -
    // those build boxes for ISPs everywhere - so it is left to the generic guide.
    ["movistar", ["movistar"]],
    ["livebox", ["livebox"]],
    ["vodafone", ["vodafone"]],
    ["sagemcom", ["sagemcom"]],
    ["nokia", ["nokia"]],
    ["xiaomi", ["xiaomi", "miwifi"]],
    ["linksys", ["linksys"]],
    ["dlink", ["d-link", "dlink"]],
    ["mercusys", ["mercusys"]],
    ["tenda", ["tenda"]],
    ["unifi", ["ubiquiti", "unifi"]],
    ["openwrt", ["openwrt"]]
];

/**
 * Which brand answered, read from the `Server` header of whatever replied instead
 * of Polaris. Router firmware names itself there far more often than not, and it
 * costs the operator nothing when it does not - the panel starts on the brand this
 * finds and stays a picker either way.
 */
export function detectRouterBrand(server: string | null): RouterBrand {
    if (!server) return "other";
    const haystack = server.toLowerCase();
    for (const [brand, needles] of SIGNATURES) {
        if (needles.some((needle) => haystack.includes(needle))) return brand;
    }
    return "other";
}

/** The two rules Polaris needs, named so they are recognizable a year later. */
export const FORWARD_RULES: readonly RouterForwardRule[] = [
    { name: "polaris-http", protocol: "TCP", port: 80 },
    { name: "polaris-https", protocol: "TCP", port: 443 }
];

/**
 * The rules a game server needs on top of those.
 *
 * 80 and 443 carry every website Polaris serves and not one game client: a game
 * server answers on its own port, on its own transport, and a Bedrock rule
 * forwarded as TCP forwards nothing at all.
 *
 * Two ways to write them, and the difference is how often the operator goes back
 * into the router. Under `per-port` there is a rule per published port, named
 * after the server so a list of rules a year from now still says which server
 * each belongs to, and deleting a server says which rule to take out. Under
 * `range` there is one rule per transport covering the whole block Polaris
 * allocates game ports from: it is written once and every server created
 * afterwards is already inside it. A server whose port falls outside its block -
 * an install from before the block existed - still gets its own rule, because a
 * range that does not contain it opens nothing for it.
 */
export function gameForwardRules(
    servers: readonly {
        name: string;
        ports: readonly { port: number; protocol: "tcp" | "udp" }[];
    }[],
    policy: PortPolicy = "per-port",
    blocks: PortBlocks = DEFAULT_PORT_BLOCKS
): RouterForwardRule[] {
    const named = (server: { name: string }, port: number, protocol: string): RouterForwardRule => {
        const slug =
            server.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "server";
        return { name: `game-${slug}-${port}`, protocol, port };
    };
    if (policy === "per-port") {
        return servers.flatMap((server) =>
            server.ports.map((port) => named(server, port.port, port.protocol.toUpperCase()))
        );
    }

    const rules: RouterForwardRule[] = [];
    // One range rule per transport actually in use: a deployment with no Bedrock
    // and no crossplay has nothing answering on UDP, and a rule for it would be an
    // opening nothing is behind.
    for (const protocol of ["tcp", "udp"] as const) {
        const block = blocks[protocol];
        if (!servers.some((server) => server.ports.some((port) => port.protocol === protocol)))
            continue;
        rules.push({
            name: `polaris-games-${protocol}`,
            protocol: protocol.toUpperCase(),
            port: block.start,
            endPort: block.end
        });
    }
    for (const server of servers) {
        for (const port of server.ports) {
            if (inBlock(port.port, blocks[port.protocol])) continue;
            rules.push(named(server, port.port, port.protocol.toUpperCase()));
        }
    }
    return rules;
}

/**
 * The same ports, as few rules as this brand's form can express.
 *
 * A router that offers "both" on its Protocol field carries rules differing only
 * by transport in one row, and a contiguous run of ports in one range. The two
 * call rules - one UDP port and the TCP port beside it - are then a single rule
 * instead of two, which matters more than it looks: every rule typed into a router
 * by hand is a rule that can be mistyped, left switched off, or pointed at the
 * wrong address.
 *
 * Only ever narrows the work, never the correctness. Rules merge when they cover a
 * contiguous run of ports AND genuinely use different transports; a set that is all
 * one transport, or that has a gap in it (80 and 443), is left exactly as it was.
 * A merged rule spans the whole run, so it can open a port and transport nothing is
 * listening on - which is a packet the host refuses, not a service reached.
 */
export function mergeProtocolRules(
    rules: readonly RouterForwardRule[],
    combined: string | null
): readonly RouterForwardRule[] {
    if (!combined || rules.length < 2) return rules;
    if (new Set(rules.map((rule) => rule.protocol)).size < 2) return rules;
    const first = Math.min(...rules.map((rule) => rule.port));
    const last = Math.max(...rules.map((rule) => rule.endPort ?? rule.port));
    const covered = new Set<number>();
    for (const rule of rules) {
        for (let port = rule.port; port <= (rule.endPort ?? rule.port); port += 1)
            covered.add(port);
    }
    if (covered.size !== last - first + 1) return rules;
    return [
        {
            name: sharedName(rules),
            protocol: combined,
            port: first,
            ...(last === first ? {} : { endPort: last })
        }
    ];
}

/** One name for a merged rule: what the originals have in common, minus the part
 *  that was only there to tell the transports apart. Falls back to the first name
 *  rather than inventing one - a name is what the operator looks for in the
 *  router's own list afterwards. */
function sharedName(rules: readonly RouterForwardRule[]): string {
    const [first, ...rest] = rules.map((rule) => rule.name);
    let shared = first ?? "";
    for (const name of rest) {
        let index = 0;
        while (index < shared.length && index < name.length && shared[index] === name[index])
            index += 1;
        shared = shared.slice(0, index);
    }
    const trimmed = shared.replace(/[-_]+$/, "");
    return trimmed.length >= 3 ? trimmed : (first ?? "");
}

/**
 * The same rules, named so this brand's form will take them.
 *
 * ZTE caps the Name field at 16 characters and refuses the entry outright, so
 * `polaris-games-tcp` is a value the page can print and the operator cannot type -
 * and a form rejecting the thing they were told to enter leaves them with nothing
 * to go on. What identifies a rule is kept: `polaris` collapses to `plr`, and a
 * name still too long loses its middle rather than its tail, which carries the
 * port or the transport. Names stay distinct within the set, since a form that
 * refuses a long name refuses a repeated one too.
 */
export function fitRuleNames(
    rules: readonly RouterForwardRule[],
    limit: number | null
): readonly RouterForwardRule[] {
    if (limit === null || rules.every((rule) => rule.name.length <= limit)) return rules;
    const taken = new Set<string>();
    return rules.map((rule) => {
        const name = distinct(shortenName(rule.name, limit), limit, taken);
        taken.add(name);
        return name === rule.name ? rule : { ...rule, name };
    });
}

/** A name within `limit`, dropping the least identifying part of it first. */
function shortenName(name: string, limit: number): string {
    if (name.length <= limit) return name;
    const short = name.startsWith("polaris-") ? `plr-${name.slice("polaris-".length)}` : name;
    if (short.length <= limit) return short;
    const cut = short.lastIndexOf("-");
    const tail = cut > 0 ? short.slice(cut) : "";
    if (tail.length >= limit) return short.slice(0, limit);
    return `${short
        .slice(0, cut)
        .slice(0, limit - tail.length)
        .replace(/-+$/, "")}${tail}`;
}

/** A name no other rule in the set has taken, numbered when trimming collided. */
function distinct(name: string, limit: number, taken: ReadonlySet<string>): string {
    if (!taken.has(name)) return name;
    for (let n = 2; n < 100; n += 1) {
        const suffix = String(n);
        const candidate = `${name.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
    return name;
}

/**
 * The router's own address, inferred from this server's. Routers sit on .1 of the
 * subnet nearly always, and "nearly" is why this is offered as a starting point
 * rather than stated - the address that is certain is the one already in the
 * browser's network settings as the gateway.
 */
/**
 * Where the brand's admin page is, for the button that opens it. Null on a brand
 * whose only way in is a phone app: the gateway address there is not a page.
 */
export function routerAdminUrl(guide: RouterBrandGuide, lanIp: string | null): string | null {
    if (guide.app) return null;
    const gateway = likelyGateway(lanIp);
    return guide.admin ?? (gateway ? `http://${gateway}` : null);
}

export function likelyGateway(lanIp: string | null): string | null {
    if (!lanIp) return null;
    const parts = lanIp.split(".");
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}
