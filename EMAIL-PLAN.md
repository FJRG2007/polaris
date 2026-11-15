# Email senders move - remaining steps

Done in the wip commit:
- /admin/email/channels removed (page, connect page, dialogs, Discord panel, catalog, logos, polls, actions,
  data, `/api/admin/channels/state`), `lib/messaging/discord-invite.ts` + its test, dead functions in
  `lib/messaging-service.ts` (reconcile + normalizePeerId kept: 2FA and notices still use stored channels).
  No schema change (Channel table is shared with email senders).
- Senders moved to `apps/web/src/app/(app)/admin/integrations/email/` (page, loader, data, actions,
  sender/sms actions, dialog, sms card, account-mail card, channel-card, new `email-mark.tsx`).
  WhatsApp mark moved to `src/app/oauth/2fa/whatsapp-logo.tsx`.
- Links updated: apps.ts (guest door + Integrations & AI section, Communication base now /admin/announcements),
  admin overview tiles, destinations-card, mail-server sending tab, notice-delivery-fields (channels link dropped),
  compliance evidence, paint-reads, mail-server setup log line, tests (app-access, rail-group-sizes,
  poll-routes, setup/app-polls).
- Permission kept `inbox.read`/`inbox.manage`: member/viewer roles hold it and senders are per-account
  (test/access/app-access.test.ts documents it); switching to requireAdmin would remove access.

Remaining:
1. i18n cleanup (en-US + es-ES): remove admin.json `inbox.*`/`inboxChannels.*` keys no longer referenced
   (keep: inbox.connect.close/connect/name, inboxChannels.email.*, errors.*, manage.button/remove/removeTitle/title,
   readyToSend, sms.*, status), `overview.sections.channels`, automations `delivery.messagingAdd`, nav.json "Channels"
   if unused. Update `compliance.json where.email` and admin.json `noMail` text ("Management > Integrations > Email & SMS").
   Remove deleted paths from `apps/web/scripts/i18n-migrated.json` and rename moved ones to integrations/email.
2. Picker: replace the provider `Select` in `integrations/email/email-channel-dialog.tsx` with
   `ProviderSelect` (`src/components/model-keys/provider-select.tsx`; options {slug,name,aliases,freeTier}).
   Add marks to `src/components/logos.tsx` SERVICE_MARKS: resend (currentColor, Simple Icons 13.21.0),
   brevo (#0B996E, Simple Icons), ses (#DD344C, Simple Icons "amazonsimpleemailservice"),
   mailjet (#9585f4, Iconify logos:mailjet-icon), smtp (lucide Server), polaris-mail (mail-server app icon).
   SVGs downloaded to scratchpad/logos-dl/. Translate provider summaries (core strings are English).
3. "Polaris mail server" option: status from `mailServerAppInstalled()` + `listServers()` (+ channelId existence);
   not installed -> admin calls `installMailServerAppAction`, then link /mail-server; no server -> link /mail-server;
   ready server without channel -> `resumeSetupAction({serverId, from: "sender"})`; with channel -> "already sending".
   Needs `mailserver.manage`.
4. Tests: page/picker tests under test/admin/email; run tsc (tsconfig.typecheck.json), affected tests, test/i18n.
