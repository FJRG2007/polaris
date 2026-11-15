# Messaging channels under Integrations - remaining steps

Done on this branch (backend, committed): official WhatsApp providers (Meta Cloud
API with authentication template, Twilio Content Template, 360dialog), code
senders as settings (`lib/messaging/code-senders.ts`), resolution admin sender ->
own channel -> blocker naming Integrations > Messaging (`lib/messaging/code-route.ts`),
Telegram as a 2FA method with a one-time `t.me/<bot>?start=<token>` link
(`lib/messaging/telegram-link*.ts`, `UserTelegram` + migration 20271120000170),
admin channel service (`lib/messaging/channel-admin.ts`), server actions for the
Telegram link in `account/security/two-factor-actions.ts`, tests in `test/messaging/`.

## Remaining

1. Admin page `src/app/(app)/admin/integrations/messaging/` (admin only, `requireAdmin`):
   - `page.tsx` + `loader.tsx` (AfterPaint + `paintRead("messaging")`) + `data.ts`
     (`listMessagingChannels()`, `getCodeSenders()`), add `messaging` to `admin/paint-reads.ts`.
   - `messaging-providers.ts`: catalogue rows `whatsapp-cloud`, `whatsapp-twilio`,
     `whatsapp-360dialog`, `whatsapp-web` (label "unofficial, may be banned", never
     the default), `telegram`, `discord`, `discord-webhook`, `slack`, `slack-webhook`,
     each with `platform`, `provider`, aliases and fields. Fields:
     cloud: token + phoneNumberId + codeTemplate + codeTemplateLanguage;
     twilio: accountSid + token (auth token) + from + contentSid;
     360dialog: token (API key) + from + codeTemplate + codeTemplateLanguage.
     Export a pure `searchMessagingProviders(rows, query)` and test it.
     Template hint, one line: "WhatsApp only lets a business start a chat with an
     approved template, so codes need an authentication template's name and language."
   - Picker: reuse `components/model-keys/provider-select.tsx`; register logos for the
     provider slugs in `components/logos.tsx` SERVICE_MARKS (WhatsApp/Telegram/Slack
     Simple Icons paths are in history: `git show e6ea92eaab^:./dashboard/apps/web/src/app/(app)/admin/email/channels/channel-logos.tsx`;
     Discord is `brand.DiscordMark`).
   - `actions.ts`: Zod-validated connect/update/delete/reconnect/state and
     `setCodeSenderAction(platform, channelId|null)`, all `requireAdmin` + `recordAudit`.
   - WhatsApp Web QR flow: reuse old `connect-channel-dialog.tsx` polling of
     `messagingChannelState`.
2. Nav: add "Messaging" after "Email & SMS" in `lib/apps.ts` (adminOnly), in
   `admin/page.tsx` integrations sections, `nav.json` ("Messaging"/"Mensajería"),
   `admin.overview.sections.messaging`, and `test/navigation/rail-group-sizes.test.ts`.
3. Account security: a Telegram card (link button opening the deep link, polling
   `checkTelegramLinkAction` every 3 s for up to 10 min, unlink) beside the phone card.
4. `components/automations/notice-delivery-fields.tsx`: the "no channels" hint links to
   `/admin/integrations/messaging`.
5. i18n en-US + es-ES for all of the above (length rule), then
   `npx vitest run test/messaging test/i18n --maxWorkers=2` and the web typecheck.
