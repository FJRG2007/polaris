# Mail: what is here, and what is coming from Mailflare

Written after reading [Mailflare](https://github.com/hieunc229/mailflare)
(`references/repos/mailflare`) end to end and comparing it with Polaris Mail
feature by feature. This file is the inventory that comparison produced, so the
work does not have to be re-derived and so the things that were deliberately
**not** taken are written down rather than looking like oversights.

## The architectural difference, first

Mailflare **is** a mail server. It runs in a Cloudflare account: Email Routing
accepts the message, a Worker stores it in D1, attachments go to R2, outbound
goes through Cloudflare's send API, and a Durable Object pushes live updates.

Polaris Mail is a **client**. It talks IMAP and SMTP to a mailbox somebody else
runs, and it never holds the only copy of anything.

That difference decides most of the list. A feature of Mailflare's that belongs
to *being the server* cannot be ported, because by the time Polaris sees a
message it has already been accepted and delivered:

| Not portable | Why |
| --- | --- |
| Connecting domains, Cloudflare Email Routing, DNS status | Polaris does not accept mail |
| Domain-scope routing rules: catch-all, **reject** | Rejecting happens at the SMTP conversation, which has ended |
| Outbound jobs, the send API, per-domain sending intent | SMTP is the mailbox's own, not ours |
| D1 backups, licences, branding, the Worker realtime hub | Polaris has its own equivalents already |
| Shared mailboxes with delegated access | Done differently and already shipped - see below |

## Already in Polaris, and at least as good

Thread grouping and per-thread counts, snooze, star, pin, mute, archive, labels,
send-as identities, signatures with an insert policy, out-of-office replies,
scheduled send with an undo window, per-mailbox privacy (remote content,
trackers, link cleaning, read receipts), blocked senders, API keys, audit logs,
keyboard shortcuts, live updates over SSE, unified views across mailboxes,
message categories (Mailflare has none), and per-message attachment handling.

**Shared mailboxes** landed as *the organization hands one out*: an ordinary
mailbox row belonging to one person with `orgId` naming whose work it is part
of, listed on that organization's shelf. Deliberately not Mailflare's shape -
its delegated access lets a second account read a mailbox, and the rule at the
top of `lib/mailbox/access.ts` does not bend for that.

## To do, in the order it is worth doing

1. **IMAP migration.** The other half of importing, and the one people actually
   have: connect the mailbox they are leaving and copy it across, rather than
   asking them to produce an `.mbox` first. Polaris already has an IMAP client
   and a connect dialog that collects a server's details, so what is missing is
   the walk over the source folders and the same batching the file import
   already uses. Mailflare had to write an IMAP client against Cloudflare's
   socket API to do this; here it is mostly wiring.

2. **Message templates.** A named subject and body somebody inserts while
   writing. Polaris has signatures, which are the same machinery with exactly
   one instance.

3. **Webhooks**, with retries and a delivery log. Wanted by anybody wiring a
   support address into something else.

4. **A contacts screen.** Polaris collects contacts by observing and uses them
   for completion, the sender face and now the junk filter, but there is no
   screen that lists them, and no way to correct a name or hide an address.

5. **A standing forwarding address**, as a mailbox setting rather than a filter
   somebody writes. The filter action below already does the work; this is the
   one-switch version of it.

## Done

- **Junk filter.** Local scoring with per-mailbox learning: the sending server's
  own authentication results, where the links actually go, the shape of the
  message, whether this mailbox has written to the sender, a per-mailbox
  reputation for the sender, their domain and the shape of the mailing, and a
  bounded word classifier trained only on explicit Junk / Not junk. Nothing
  leaves the machine. Scoring is pure and in `@polaris/core`; `lib/mailbox/spam`
  is the half that reads and writes.

  Two things done differently from Mailflare on purpose: a DKIM or SPF pass
  counts in a message's favour only while DMARC is not failing (anybody can sign
  their own domain, so a pass says nothing good about a message claiming to be
  from a bank), and the word classifier is bounded and confidence-weighted rather
  than a plain naive-Bayes probability, which is confidently wrong over exactly
  the first hundred messages where a new filter has to earn trust.

- **Import**, from an `.mbox` or an `.eml`. The messages are appended to the real
  IMAP folder rather than written into Polaris' cache, so the archive is there on
  the phone too and survives Polaris being reinstalled. Run a batch at a time
  from the screen, because four thousand appends over one connection is minutes -
  far longer than a request should live, and exactly the shape of thing that
  fails near the end with nothing to show for it.

- **Export**, as `.mbox` for a mailbox or a folder and as the real `.eml` for one
  message. The mailbox export streams, so a large one starts saving rather than
  appearing to hang. The whole-mailbox file is built from what Polaris has synced
  and says so; the single message is fetched from the server as it was sent.

- **Forward, as a filter action.** With the three refusals that make it safe:
  never to an address on this account, never a message that has already been
  forwarded once, and never an automatic message. Two mailboxes forwarding to
  each other otherwise fill both servers overnight.

- **Folder colours**, set from a right-click in the rail. Polaris' own column -
  IMAP has no notion of it, so a resync leaves it alone.
