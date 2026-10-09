/** Two mailboxes in one inbox: work, and a personal one connected over IMAP. */

import { VIEWER, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import type { MailFolderView, MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import type { MailIdentityView, MailLabelView } from "@/lib/mailbox/labels";

export const WORK_ID = id("mail-account", 1);
export const HOME_ID = id("mail-account", 2);
/** The conversation the picture has open. */
export const OPEN_THREAD_ID = id("mail-thread", 1);

function account(
    n: number,
    address: string,
    label: string,
    color: string,
    service: string,
    serviceName: string
): MailAccountView {
    return {
        id: n === 1 ? WORK_ID : HOME_ID,
        address,
        displayName: VIEWER.name,
        label,
        color,
        service,
        serviceName,
        auth: "password",
        connectionId: null,
        username: address,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecurity: "tls",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        state: "ok",
        stateDetail: "",
        lastSyncAt: null,
        notify: true,
        unified: true,
        appendToSent: true,
        signature: "",
        signatureAboveQuote: false,
        remoteContent: "ask",
        nameTrackers: true,
        answerReceipts: false,
        cleanLinks: true,
        signatureAuto: "",
        securityKeepMinutes: 0,
        spamFilter: true,
        trashKeepDays: 30,
        vacationEnabled: false,
        pollSeconds: 60,
        position: n
    };
}

export function mailAccounts(ctx: SceneContext): MailAccountView[] {
    return [
        account(1, VIEWER.email, ctx.say("Work", "Trabajo"), "#6366f1", "custom", ""),
        account(
            2,
            "alex.rivera@example.net",
            ctx.say("Personal", "Personal"),
            "#f59e0b",
            "fastmail",
            "Fastmail"
        )
    ];
}

/** Unread mail, before the open conversation is read and after. */
export function mailUnread(read: boolean) {
    const work = read ? 3 : 4;
    return { total: work + 2, byAccount: { [WORK_ID]: work, [HOME_ID]: 2 } };
}

export function mailFolders(read = false): MailFolderView[] {
    const folder = (
        n: number,
        accountId: string,
        name: string,
        role: string,
        unread: number,
        total: number
    ) =>
        ({
            id: id("mail-folder", n),
            accountId,
            path: name,
            name,
            role,
            unread,
            total,
            color: "",
            depth: 0
        }) as MailFolderView;
    return [
        folder(1, WORK_ID, "INBOX", "inbox", read ? 3 : 4, 212),
        folder(2, WORK_ID, "Sent", "sent", 0, 96),
        folder(3, WORK_ID, "Drafts", "drafts", 0, 2),
        folder(4, WORK_ID, "Archive", "archive", 0, 1840),
        folder(5, WORK_ID, "Junk", "junk", 0, 7),
        folder(6, WORK_ID, "Trash", "trash", 0, 31),
        folder(7, HOME_ID, "INBOX", "inbox", 2, 88),
        folder(8, HOME_ID, "Sent", "sent", 0, 40)
    ];
}

export function mailLabels(ctx: SceneContext): MailLabelView[] {
    return [
        {
            id: id("mail-label", 1),
            name: ctx.say("Clients", "Clientes"),
            color: "#22c55e",
            position: 0,
            count: 14
        },
        {
            id: id("mail-label", 2),
            name: ctx.say("Receipts", "Recibos"),
            color: "#0ea5e9",
            position: 1,
            count: 37
        }
    ];
}

export function mailIdentities(): Record<string, MailIdentityView[]> {
    return { [WORK_ID]: [], [HOME_ID]: [] };
}

interface ThreadDraft {
    readonly from: [string, string];
    readonly subject: [string, string];
    readonly snippet: [string, string];
    readonly minutes: number;
    readonly home?: boolean;
    readonly unread?: number;
    readonly count?: number;
    readonly starred?: boolean;
    readonly attachments?: boolean;
    readonly label?: number;
}

const THREADS: readonly ThreadDraft[] = [
    {
        from: ["Ana Torres", "ana@example.com"],
        subject: ["Launch checklist for Thursday", "Lista para el lanzamiento del jueves"],
        snippet: [
            "Here is what is left before we ship: the release notes, the status page and one last pass on checkout.",
            "Esto es lo que falta antes de publicar: las notas, la página de estado y un último repaso al pago."
        ],
        minutes: 8,
        unread: 1,
        count: 3,
        starred: true
    },
    {
        from: ["Kenji Mori", "kenji@example.com"],
        subject: ["Invoice 2026-031 from Northwind Studio", "Factura 2026-031 de Northwind Studio"],
        snippet: [
            "Attached is the invoice for March. Payment terms as usual.",
            "Adjunto la factura de marzo. Condiciones de pago como siempre."
        ],
        minutes: 41,
        unread: 1,
        attachments: true,
        label: 1
    },
    {
        from: ["Priya Nair", "priya@example.org"],
        subject: ["Dinner on Saturday?", "¿Cena el sábado?"],
        snippet: [
            "We found a place near the river. Eight o'clock works for everyone so far.",
            "Hemos encontrado un sitio junto al río. A las ocho le va bien a todos por ahora."
        ],
        minutes: 75,
        home: true,
        unread: 1
    },
    {
        from: ["Lena Fischer", "lena@example.com"],
        subject: ["Re: Onboarding illustrations", "Re: Ilustraciones de bienvenida"],
        snippet: [
            "Exported the dark versions too, they are in the design folder in Drive.",
            "También he exportado las versiones oscuras, están en la carpeta de diseño de Drive."
        ],
        minutes: 130,
        count: 5,
        attachments: true
    },
    {
        from: ["Sam Okafor", "sam@example.com"],
        subject: ["Staging is green", "Staging en verde"],
        snippet: [
            "All smoke tests passed twice. Ready when you are.",
            "Todas las pruebas de humo han pasado dos veces. Listo cuando quieras."
        ],
        minutes: 190,
        unread: 1
    },
    {
        from: ["Example Bank", "statements@bank.example"],
        subject: ["Your March statement is ready", "Tu extracto de marzo está disponible"],
        snippet: [
            "Your statement for the period ending 15 March can now be viewed online.",
            "Ya puedes consultar el extracto del periodo que termina el 15 de marzo."
        ],
        minutes: 60 * 9,
        home: true,
        unread: 1,
        label: 2
    },
    {
        from: ["Ana Torres", "ana@example.com"],
        subject: ["Customer interviews: notes", "Entrevistas con clientes: notas"],
        snippet: [
            "Five calls this week. The pattern is clear: people want the export earlier.",
            "Cinco llamadas esta semana. El patrón es claro: quieren la exportación antes."
        ],
        minutes: 60 * 22,
        count: 2,
        starred: true
    },
    {
        from: ["Kenji Mori", "kenji@example.com"],
        subject: ["Changelog draft", "Borrador del changelog"],
        snippet: [
            "Draft attached. Shout if I missed anything from the last two weeks.",
            "Borrador adjunto. Avisad si me he dejado algo de las dos últimas semanas."
        ],
        minutes: 60 * 27,
        attachments: true
    },
    {
        from: ["Travel Desk", "trips@travel.example"],
        subject: ["Your booking is confirmed", "Tu reserva está confirmada"],
        snippet: [
            "Lisbon, 24-26 April. Your boarding passes will arrive 24 hours before departure.",
            "Lisboa, 24-26 de abril. Las tarjetas de embarque llegarán 24 horas antes de salir."
        ],
        minutes: 60 * 30,
        home: true,
        label: 2
    }
];

export function mailThreads(ctx: SceneContext): MailThreadView[] {
    const labels = mailLabels(ctx);
    return THREADS.map((draft, index) => ({
        id: id("mail-thread", index + 1),
        accountId: draft.home ? HOME_ID : WORK_ID,
        subject: ctx.say(...draft.subject),
        snippet: ctx.say(...draft.snippet),
        participants: [{ name: draft.from[0], address: draft.from[1] }],
        messageCount: draft.count ?? 1,
        unreadCount: draft.unread ?? 0,
        starred: draft.starred ?? false,
        important: false,
        pinned: false,
        muted: false,
        hasAttachments: draft.attachments ?? false,
        size: 48_000,
        lastMessageAt: new Date(ctx.now - draft.minutes * 60_000).toISOString(),
        unsubscribe: "",
        unsubscribeKind: "",
        unsubscribeSource: "",
        labels: draft.label ? [labels[draft.label - 1]!] : [],
        leadMessageId: id("mail-message", index + 1)
    }));
}

/** The open conversation: three messages about the launch, the newest unread. */
export function openThread(ctx: SceneContext): {
    thread: MailThreadView;
    messages: MailMessageView[];
} {
    const say = ctx.say;
    const thread = mailThreads(ctx)[0]!;
    const ana = { name: "Ana Torres", address: "ana@example.com" };
    const me = { name: VIEWER.name, address: VIEWER.email };
    const message = (
        n: number,
        from: typeof ana,
        to: typeof ana,
        minutes: number,
        snippet: string,
        seen: boolean
    ): MailMessageView => ({
        id: n === 3 ? thread.leadMessageId : id("mail-message", 100 + n),
        accountId: WORK_ID,
        folderId: id("mail-folder", 1),
        folderRole: "inbox",
        subject: n === 1 ? thread.subject : `Re: ${thread.subject}`,
        from: [from],
        to: [to],
        cc: [],
        replyTo: [],
        snippet,
        sentAt: new Date(ctx.now - minutes * 60_000).toISOString(),
        seen,
        flagged: n === 1,
        important: false,
        answered: n === 1,
        wantsReceipt: false,
        listId: "",
        spamScore: null,
        spamReason: "",
        spamReasons: [],
        delivery: null,
        attachments: []
    });
    return {
        thread,
        messages: [
            message(
                1,
                ana,
                me,
                60 * 3,
                say(
                    "Draft of what is left before Thursday.",
                    "Borrador de lo que falta antes del jueves."
                ),
                true
            ),
            message(
                2,
                me,
                ana,
                60 * 2,
                say(
                    "Looks complete. I'll take the status page.",
                    "Lo veo completo. Me quedo con la página de estado."
                ),
                true
            ),
            message(3, ana, me, 8, thread.snippet, false)
        ]
    };
}

/** What opening the newest message reads: its text, nothing remote in it. */
export function openedMessage(ctx: SceneContext) {
    const { messages } = openThread(ctx);
    const newest = messages[messages.length - 1]!;
    const text = ctx.say(
        "Hi Alex,\n\nHere is what is left before we ship on Thursday:\n\n- Release notes (Kenji)\n- Status page update (you)\n- One last pass on checkout with the new address step (Sam)\n\nStaging is green, so if these land by Wednesday evening we can tag the release after the standup.\n\nAna",
        "Hola Alex:\n\nEsto es lo que falta antes de publicar el jueves:\n\n- Notas de la versión (Kenji)\n- Actualizar la página de estado (tú)\n- Un último repaso al pago con el nuevo paso de dirección (Sam)\n\nStaging está en verde, así que si esto está listo el miércoles por la tarde etiquetamos la versión después de la daily.\n\nAna"
    );
    return {
        readable: {
            html: "",
            text,
            remoteAllowed: true,
            remoteCount: 0,
            trackers: [],
            trackerVendors: [],
            wantsReceipt: false,
            unsubscribe: "",
            unsubscribeKind: "",
            unsubscribeSource: ""
        },
        envelope: {
            id: newest.id,
            accountId: WORK_ID,
            subject: newest.subject,
            from: newest.from,
            to: newest.to,
            cc: [],
            replyTo: [],
            listId: "",
            sentAt: newest.sentAt
        }
    };
}
