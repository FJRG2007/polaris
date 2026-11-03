# Translate - plan

An installable Polaris app (`/translate`, an optional marketplace app like CRM)
that translates text, documents, web pages, images, the camera and Chat
messages, with engines that run in the browser, on the Polaris machine with no
internet, or through a provider key the owner adds.

## Engines

One interface (`translate(text[], from, to) -> text[]`, `detect(text)`), many
engines, picked per request by what is available and what the owner allows. The
screen always says which engine answered.

| Engine | Where it runs | Network | Notes |
|---|---|---|---|
| Browser built-in (Translator / LanguageDetector API) | Reader's browser | Model download once | Chrome desktop 138+; not in Firefox/Safari. Feature-detected. |
| Transformers.js with OPUS-MT / NLLB models | Reader's browser (WASM/WebGPU) | Model download once, cached | Works in every modern browser; models are tens to hundreds of MB. |
| Bergamot (Firefox Translations) | Reader's browser (WASM) | Model download once | Prebuilt worker from mozilla/bergamot-translator releases; no npm package. |
| LibreTranslate (Argos) | Polaris machine, container | None after models are pulled | Offline for the whole house; installed from the marketplace on demand. |
| Polar's model | Wherever Polar's provider is | Provider's | Best for tone and context; uses the existing BYOK and limits. |
| DeepL API | DeepL | Yes, owner's key | Text and documents (docx, pptx, pdf). |
| Google Cloud Translation | Google | Yes, owner's key | Text and documents. |

Keys are stored like the other provider keys (encrypted, per org), never sent to
the browser. Paid engines go through the paid-request gate.

## Phases

1. **Text.** The app screen: two panes, language pickers with search and
   detection, swap, copy, listen (speechSynthesis), history per user. Engines:
   browser built-in, Polar's model, DeepL, Google. Settings: which engines,
   keys, default languages. API route `/api/translate` used by every surface.
2. **Offline.** LibreTranslate as a managed container (pull, models, health),
   and Transformers.js in the browser with a model cache and a download size
   shown before it starts.
3. **Documents.** Upload docx/pptx/xlsx/pdf/txt/srt; DeepL/Google document APIs
   where configured, otherwise text extraction + segment translation + rebuild
   for the formats the office packages already read. Result saved to Drive.
4. **Chat and Polar.** "Translate" on a Chat message (and auto-translate per
   conversation), Polar's translation card calling the same engines.
5. **Web pages and the extension.** Extension: translate the page in place
   (text nodes, kept in sync with page changes), translate selection, from the
   context menu. In the app: open an address and read it translated.
6. **Images and camera.** OCR in the browser (Tesseract.js) or on the server,
   text drawn over the picture in place; camera view that translates what it
   sees, on desktop and the installed phone app.

Each phase ships on its own with tests, and none needs a terminal or a value in
`.env`.
