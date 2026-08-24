/**
 * The public documents an outside service asks for before it will trust this
 * deployment: what Polaris does with somebody's data, and the terms it is
 * offered under.
 *
 * They exist because of the review desks. Google will not lift the "hasn't
 * verified this app" warning without a home page that is reachable without
 * signing in, says what the app is for, and carries a privacy policy on the same
 * domain; Epic asks for a privacy policy URL before brand review. A dashboard
 * that is entirely behind a login has none of that, and should not be opened up
 * to get it - so these three pages are the only thing outside the door.
 *
 * Written as facts about how Polaris actually behaves, checked against the code
 * that does it, because a policy that describes some other program is worse than
 * none: it is the document a reviewer holds this deployment to.
 *
 * Deliberately not editable from a screen. The operator adds a contact address
 * and nothing else - the rest describes what this software does, and an instance
 * that has quietly rewritten "Polaris does not send your data anywhere" is not
 * something Polaris should help anybody publish.
 */

/** When the wording last changed. Bumped by hand, with the change. */
export const LEGAL_UPDATED = "2026-08-11";

export interface LegalSection {
    heading: string;
    /** Paragraphs, in order. */
    body: readonly string[];
}

export interface LegalDocument {
    title: string;
    /** One line under the title, and the page's meta description. */
    summary: string;
    sections: readonly LegalSection[];
}

/** The line about how to reach somebody, when the operator has given an address. */
function contactSection(contact: string | null): LegalSection[] {
    if (!contact) return [];
    return [
        {
            heading: "Getting in touch",
            body: [
                `This Polaris is run by the person or organization reachable at ${contact}. Questions about the data it holds, and requests to see or delete it, go there.`
            ]
        }
    ];
}

/**
 * What this deployment does with somebody's data.
 *
 * Every claim here is one the code keeps: the read-only calendar scope, the
 * account id and display name taken from a game service, the folder a backup
 * destination is confined to, and the fact that nothing is sent anywhere except
 * the services somebody connected themselves.
 */
export function privacyDocument(contact: string | null): LegalDocument {
    return {
        title: "Privacy",
        summary:
            "What Polaris stores, where it stays, and what happens to it when you unlink or leave.",
        sections: [
            {
                heading: "Who holds this data",
                body: [
                    "Polaris is self-hosted software. This copy of it runs on hardware belonging to whoever set it up, and they are the ones responsible for the data in it. Polaris is not a service anybody signs up to, and the people who write it never see this deployment or anything in it.",
                    "Nothing here is sold, rented, or handed to an advertiser, because there is no company on the other end of it to do that."
                ]
            },
            {
                heading: "What is stored",
                body: [
                    "An account: the name and address it was created with, an avatar if one was set, and the second factor if one was armed. Passwords are never stored, only a hash they cannot be recovered from.",
                    "What you put in it: the files uploaded to Drive, the tasks and pages written, and anything else created through the app.",
                    "How it is used: sessions and the devices they were opened from, and an activity log of the actions taken, which is what lets an account's owner see a sign-in they did not make."
                ]
            },
            {
                heading: "Accounts you connect",
                body: [
                    "Connecting an outside account is always started by its owner and can be undone by them at any time. What is kept differs by service, and never exceeds what the feature needs.",
                    "Google: read-only access to the calendar, so events appear beside the tasks. Polaris cannot change or delete anything in a Google account.",
                    "Microsoft and Dropbox: access to the folder Polaris creates for backups. Nothing else in the account is reachable from here.",
                    "GitHub: the repositories the account allows, so they can be built and deployed.",
                    "Steam, Epic Games and Minecraft: the account id and the display name, and no credential at all. Proving which player an account belongs to is the whole errand, and Polaris never acts as one afterwards.",
                    "Discord: the account id, the display name, the address on the account, and the list of servers it is in - their names, and nothing inside them. Unlike the other game identities the authorization is kept, encrypted, because the server list is read when it is wanted rather than copied once at linking. Polaris cannot post as the account or read its messages.",
                    "The credentials behind these are encrypted before they are written down. Unlinking an account destroys the credential immediately, and what it reached stops being reachable."
                ]
            },
            {
                heading: "Where it goes",
                body: [
                    "It stays on the server this Polaris runs on. It is sent outside only to a service somebody deliberately connected, and only for what that service is connected to do - fetching your calendar, writing a backup to your own storage, deploying your own repository.",
                    "Some of those are optional integrations an operator switches on, such as scanning uploads for malware. Where one is in use, the file or address it checks is sent to that service and to no other."
                ]
            },
            {
                heading: "Deleting it",
                body: [
                    "Unlinking a connected account removes its credential and the access it granted. Deleting an account removes it along with what it created; backups already written to your own storage are yours, and Polaris does not reach into them afterwards.",
                    "An operator can also delete anything on the deployment directly, because it is their server."
                ]
            },
            ...contactSection(contact)
        ]
    };
}

/** The terms this deployment is offered under. Short, because it is one person's
 *  own server and not a product with customers. */
export function termsDocument(contact: string | null): LegalDocument {
    return {
        title: "Terms",
        summary: "The terms this Polaris deployment is offered under.",
        sections: [
            {
                heading: "What this is",
                body: [
                    "Polaris is a self-hosted control plane: files, tasks, deployments, game servers and the accounts that reach them, running on hardware its operator owns. This deployment is offered by that operator, to the people they have given an account to. It is not a public service and there is nothing to sign up for.",
                    "Access is granted by the operator and can be withdrawn by them."
                ]
            },
            {
                heading: "Using it",
                body: [
                    "Use the account you were given, and do not try to reach data that was not shared with you. Do not use this deployment to store or distribute anything unlawful, or to attack anything from it.",
                    "An account may be suspended if it is used that way, or if it appears to have been taken over."
                ]
            },
            {
                heading: "What is not promised",
                body: [
                    "This is somebody's own server. It can be offline, it can lose data, and the software is provided as it is, without a warranty of any kind - the same terms the Polaris source is published under.",
                    "Keep your own copy of anything you cannot afford to lose."
                ]
            },
            ...contactSection(contact)
        ]
    };
}
