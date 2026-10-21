# Publishing the Stream Deck plugin on Elgato Marketplace

Every change to the plugin already reaches people without the Marketplace: each
push to `main` that changes what the plugin ships cuts a `streamdeck-v*` GitHub
release by itself (`.github/workflows/streamdeck.yml`), and the Downloads screen
of every Polaris offers that file. An installed copy learns about a newer release
from its own Polaris and says so in its settings screen.

The Marketplace is a second channel on top of that, and it is manual.

## There is no upload API

Checked against Elgato's documentation on 2026-10-21
([distribution](https://docs.elgato.com/streamdeck/sdk/introduction/distribution),
[submitting products](https://docs.elgato.com/maker-console/submitting-products),
[managing products](https://docs.elgato.com/maker-console/managing-products)):
products and their versions are submitted only through the Maker Console web
interface at [maker.elgato.com](https://maker.elgato.com). Elgato documents no
API, token or CLI command for uploading a version; the CLI's `validate` and
`pack` only prepare the file. So the release workflow does not publish to the
Marketplace and needs no secret. If Elgato ever documents an upload API, that is
where it would be wired in.

Every submission, the first one and every version after it, is reviewed by
Elgato. Allow 4 to 10 working days, and up to 3 hours after approval before it
shows on the Marketplace. Only the newest approved version is offered there.

## What the repository already satisfies

Checked against the [plugin guidelines](https://docs.elgato.com/guidelines/stream-deck/plugins)
and the [product guidelines](https://docs.elgato.com/guidelines/products):

| Requirement                                                                                                  | Where                                                                            |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| UUID holds the organisation and plugin name, actions prefixed by it, never changed after publishing          | `io.github.fjrg2007.polaris`, `.key`, `.dial`, `.timer`                          |
| Name without "Plugin", "Stream Deck" or the maker's name, 30 characters or fewer                             | `Polaris` (the brand name, which the maker-name rule exempts)                    |
| Category set, same as the name                                                                               | `Polaris`                                                                        |
| Action names without the author's name                                                                       | `Action`, `Device dial`, `Timer` (renamed from "Polaris key" and "Polaris dial") |
| Plugin icon, PNG 256x256 and 512x512                                                                         | `imgs/plugin/marketplace.png`, `marketplace@2x.png`                              |
| Category icon 28x28, action icons 20x20, monochrome white SVG on transparent                                 | `imgs/plugin/category-icon.svg`, `imgs/actions/*/icon.svg`                       |
| Key images 72x72 SVG, drawn at 144 when updated from code                                                    | `imgs/actions/*/key.svg`, `src/render.ts`                                        |
| 2 to 30 actions, each with a settings screen and tooltip                                                     | 3 actions                                                                        |
| DRM: `@elgato/streamdeck` 2 or later, `SDKVersion` 3, minimum app 6.9 or later, manifest not read at runtime | 3.0.1, 3, `7.1`; the version comes from the app, never from the file             |

## Listing media

The listing needs files that do not ship inside the plugin. They are in
[`docs/assets/streamdeck`](assets/streamdeck), drawn from the Polaris icon and
the plugin's own key renderer (`src/render.ts`), so every key in them is a key
the plugin really draws:

| File                                                              | Marketplace field       | Size         |
| ----------------------------------------------------------------- | ----------------------- | ------------ |
| `app-icon.png`                                                    | App icon                | 288x288 PNG  |
| `thumbnail.png`                                                   | Thumbnail               | 1920x960 PNG |
| `gallery-1-keys.png`, `gallery-2-dial.png`, `gallery-3-timer.png` | Gallery (3 to 10 items) | 1920x960 PNG |

A capture of the plugin running in the Stream Deck app can be added to the
gallery later, as a 1920x960 PNG or a 1920x1080 MP4 under 250 MB.

## One-time setup

1. Sign in at [maker.elgato.com](https://maker.elgato.com) with an Elgato
   account (create one there if needed). The first sign-in asks you to create
   your organisation: name it `Polaris` so it matches `Author` in the manifest.
   If you choose another name, the manifest's `Author` has to change to it
   before you submit.
2. In the organisation's settings, set a support link or email (the repository's
   issues page works). Stripe is only needed for paid products; this one is free.
3. Search the Marketplace for "Polaris". If another product already uses that
   name, pick another name now: it cannot be changed in Maker Console after the
   product is created, only by writing to maker@elgato.com.
4. From the newest `streamdeck-v*` release on GitHub, download the
   `.streamDeckPlugin` file.
5. In Maker Console go to **Home**, choose **Create product**, and pick
   **Stream Deck plugin**. Then fill in each step:
   - **Files**: upload the `.streamDeckPlugin` file.
   - **Details**: the name `Polaris`, the description below, price **Free**,
     and the repository as an additional link.
   - **Media**: `app-icon.png` as the icon, `thumbnail.png` as the thumbnail,
     and the three `gallery-*.png` files in order (the gallery cannot be
     reordered later, only removed and added again).
   - **Release notes**: the notes of that GitHub release.
6. Leave **Automatically publish after being approved** ticked, and submit.
   Elgato answers by email from maker@elgato.com.
7. Once the listing is approved, open it on the Marketplace and copy its
   address into `STREAMDECK_MARKETPLACE_URL` in
   `dashboard/apps/web/src/lib/deck/marketplace.ts` (it is `null` until then).
   The Downloads screen then shows **Open in Marketplace** where it says "Not
   there yet" today.

### Listing text

Elgato reviews the listing in English; the Spanish text is for the "Language"
field and anywhere a translation is accepted.

**Description (en)**

> Control your Polaris from your Stream Deck. Put a key on unread messages,
> alarms or the state of your last deployment and it updates as soon as Polaris
> does. Other keys send a message, set your status or do not disturb, redeploy a
> service, or open any Polaris page. On a Stream Deck +, a dial sets a device in
> your places, such as a light's brightness, and the timer works as a countdown
> or stopwatch on a key or a dial. Requires your own Polaris server: connect by
> typing its address and approving a short code in your browser, with no token
> to copy. Each deck gets its own key, which you can revoke from Polaris at any
> time.

**Descripción (es)**

> Controla tu Polaris desde tu Stream Deck. Pon una tecla con los mensajes sin
> leer, las alarmas o el estado de tu último despliegue y se actualiza en cuanto
> lo hace Polaris. Otras teclas envían un mensaje, cambian tu estado o activan
> no molestar, vuelven a desplegar un servicio o abren cualquier página de
> Polaris. En un Stream Deck +, un dial ajusta un dispositivo de tus lugares,
> como el brillo de una luz, y el temporizador funciona como cuenta atrás o
> cronómetro en una tecla o un dial. Necesita tu propio servidor Polaris: te
> conectas escribiendo su dirección y aprobando un código corto en el
> navegador, sin copiar ningún token. Cada deck recibe su propia clave, que
> puedes revocar desde Polaris cuando quieras.

## Every new version

GitHub already has the release; the Marketplace needs it uploaded by hand.

1. Open the newest `streamdeck-v*` release on GitHub and download its
   `.streamDeckPlugin` file. Its notes list the plugin changes since the
   release before.
2. In Maker Console, open **Products**, then Polaris, then the **Versions** tab,
   and choose **Create version**.
3. Upload the file, paste the release notes, keep **Automatically publish after
   being approved** ticked, and submit.

There is no need to upload every release: the Marketplace only ever offers the
newest approved one, so uploading the latest when it is worth a review is
enough. People who installed from the Downloads screen are told about each new
release by the plugin itself either way.

If a version is rejected, fix what the email asks and either submit a new
version or open the rejected one in the **Versions** tab and upload a revised
file.
