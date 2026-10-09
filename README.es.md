<div align="center">
  <h1>Polaris</h1>
  <h3>Tu home lab, un solo panel de control.</h3>
  <a href="README.md">English</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#instalar">Instalar</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#todo-se-conecta">Integraciones</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="#licencia">Licencia</a>
  <hr />
</div>

Polaris es un espacio de trabajo autoalojado para todo lo que gestionas tú mismo:
tus archivos, tus servidores, las apps que despliegas en ellos, el trabajo que
planificas a su alrededor y las personas con las que lo haces. Una instalación, un
inicio de sesión y una interfaz.

Después de instalarlo no hace falta una terminal: las actualizaciones, las funciones
nuevas y las reparaciones se hacen desde la interfaz.

La guía completa (qué incluye cada app, requisitos, uso y desarrollo) está en el
[README en inglés](README.md).

## Instalar

Un comando. Levanta todo: dashboard, base de datos, proxy inverso y el daemon de
host, y genera sus secretos:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.ps1 | iex
```

Linux es el host recomendado. Para instalarlo a mano con Docker Compose, sigue los
pasos de [Install](README.md#install).

## Dónde funciona

La interfaz está en español e inglés, y cada cuenta elige la suya.

| Cliente                                                                                 | Estado                                                                             |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| App web, instalable desde el navegador                                                  | Disponible                                                                         |
| Extensión para Chrome y Firefox: rellena formularios de inicio de sesión desde tu vault | Disponible ([versiones](https://github.com/FJRG2007/polaris/releases?q=extension)) |
| Servidor MCP para Claude, ChatGPT, Cursor, VS Code y otros clientes de IA               | Disponible ([configuración](docs/connecting-ai-assistants.md))                     |
| CLI para desarrolladores (`plr`): despliegues, logs, reinicios                          | Próximamente: en el repositorio, sin versión publicada                             |
| App de escritorio para Windows, macOS y Linux                                           | Próximamente: en el repositorio, sin versión publicada                             |
| Apps para iOS y Android                                                                 | Próximamente                                                                       |

## Todo se conecta

Los servicios con los que Polaris ya habla. Cada uno se activa desde la interfaz.

|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/assets/logos/google.svg" width="28" height="28" alt="Google" title="Google">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Google**: inicio de sesión, Calendar y Tasks sincronizados en los dos sentidos, Gmail como buzón, Google Drive como almacenamiento, Docs y Sheets importados a Office |
| <img src="docs/assets/logos/microsoft.svg" width="28" height="28" alt="Microsoft" title="Microsoft">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Microsoft 365**: calendario de Outlook sincronizado, correo de Outlook, OneDrive como almacenamiento                                                                  |
| <img src="docs/assets/logos/github.svg" width="28" height="28" alt="GitHub" title="GitHub"> <img src="docs/assets/logos/github-copilot.svg" width="28" height="28" alt="GitHub Copilot" title="GitHub Copilot">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **GitHub**: inicio de sesión, desplegar repositorios, ejecutar Actions en tus propios runners, leer pull requests e issues                                              |
| <img src="docs/assets/logos/linear.svg" width="28" height="28" alt="Linear" title="Linear"> <img src="docs/assets/logos/jira.svg" width="28" height="28" alt="Jira" title="Jira">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Linear y Jira**: issues reflejadas en Tasks, con el estado devuelto                                                                                                   |
| <img src="docs/assets/logos/icloud.svg" width="28" height="28" alt="iCloud" title="iCloud"> <img src="docs/assets/logos/nextcloud.svg" width="28" height="28" alt="Nextcloud" title="Nextcloud">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **CalDAV**: iCloud, Nextcloud, Fastmail, Yahoo o cualquier servidor CalDAV, además de feeds ICS                                                                         |
| <img src="docs/assets/logos/telegram.svg" width="28" height="28" alt="Telegram" title="Telegram"> <img src="docs/assets/logos/whatsapp.svg" width="28" height="28" alt="WhatsApp" title="WhatsApp"> <img src="docs/assets/logos/discord.svg" width="28" height="28" alt="Discord" title="Discord"> <img src="docs/assets/logos/slack.svg" width="28" height="28" alt="Slack" title="Slack">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Inbox**: conversaciones de Telegram, WhatsApp, Discord y Slack en un solo sitio                                                                                       |
| <img src="docs/assets/logos/dropbox.svg" width="28" height="28" alt="Dropbox" title="Dropbox"> <img src="docs/assets/logos/ubiquiti.svg" width="28" height="28" alt="Ubiquiti UniFi" title="Ubiquiti UniFi"> <img src="docs/assets/logos/docker.svg" width="28" height="28" alt="Docker" title="Docker">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Almacenamiento y hosts**: Dropbox, UniFi UNAS, S3, SFTP, SMB y NFS en Drive; el motor Docker de cada servidor que añades                                              |
| <img src="docs/assets/logos/vercel.svg" width="28" height="28" alt="Vercel" title="Vercel"> <img src="docs/assets/logos/railway.svg" width="28" height="28" alt="Railway" title="Railway"> <img src="docs/assets/logos/aws.svg" width="28" height="28" alt="AWS" title="AWS">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Desplegar fuera**: proyectos de Vercel, Railway y AWS (ECS, Amplify) junto a los tuyos                                                                                |
| <img src="docs/assets/logos/cloudflare.svg" width="28" height="28" alt="Cloudflare" title="Cloudflare"> <img src="docs/assets/logos/ngrok.svg" width="28" height="28" alt="ngrok" title="ngrok"> <img src="docs/assets/logos/duckdns.svg" width="28" height="28" alt="DuckDNS" title="DuckDNS">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Red**: registros DNS y túneles con Cloudflare, túneles de ngrok, nombres de DuckDNS                                                                                   |
| <img src="docs/assets/logos/anthropic.svg" width="28" height="28" alt="Anthropic" title="Anthropic"> <img src="docs/assets/logos/openai.svg" width="28" height="28" alt="OpenAI" title="OpenAI"> <img src="docs/assets/logos/gemini.svg" width="28" height="28" alt="Google Gemini" title="Google Gemini"> <img src="docs/assets/logos/xai.svg" width="28" height="28" alt="xAI" title="xAI"> <img src="docs/assets/logos/deepseek.svg" width="28" height="28" alt="DeepSeek" title="DeepSeek"> <img src="docs/assets/logos/moonshot.svg" width="28" height="28" alt="Moonshot AI" title="Moonshot AI"> <img src="docs/assets/logos/groq.svg" width="28" height="28" alt="Groq" title="Groq"> <img src="docs/assets/logos/cerebras.svg" width="28" height="28" alt="Cerebras" title="Cerebras"> <img src="docs/assets/logos/openrouter.svg" width="28" height="28" alt="OpenRouter" title="OpenRouter">                                                                               | **Modelos**: tus propias claves para estos y más de 50 proveedores                                                                                                      |
| <img src="docs/assets/logos/claude.svg" width="28" height="28" alt="Claude" title="Claude"> <img src="docs/assets/logos/cursor.svg" width="28" height="28" alt="Cursor" title="Cursor"> <img src="docs/assets/logos/opencode.svg" width="28" height="28" alt="OpenCode" title="OpenCode"> <img src="docs/assets/logos/vscode.svg" width="28" height="28" alt="Visual Studio Code" title="Visual Studio Code">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Agentes de código**: Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor CLI, OpenCode y 9 más en sesiones en vivo; los clientes MCP se conectan como tú              |
| <img src="docs/assets/logos/tuya.svg" width="28" height="28" alt="Tuya" title="Tuya"> <img src="docs/assets/logos/tp-link.svg" width="28" height="28" alt="TP-Link" title="TP-Link"> <img src="docs/assets/logos/shelly.svg" width="28" height="28" alt="Shelly" title="Shelly"> <img src="docs/assets/logos/philips-hue.svg" width="28" height="28" alt="Philips Hue" title="Philips Hue"> <img src="docs/assets/logos/ikea.svg" width="28" height="28" alt="IKEA" title="IKEA"> <img src="docs/assets/logos/gree.svg" width="28" height="28" alt="Gree" title="Gree"> <img src="docs/assets/logos/philips.svg" width="28" height="28" alt="Philips" title="Philips"> <img src="docs/assets/logos/home-assistant.svg" width="28" height="28" alt="Home Assistant" title="Home Assistant"> <img src="docs/assets/logos/switchbot.svg" width="28" height="28" alt="SwitchBot" title="SwitchBot"> <img src="docs/assets/logos/nuki.svg" width="28" height="28" alt="Nuki" title="Nuki"> | **Places**: enchufes, luces, cerraduras y climatización de estas marcas; cámaras Tapo, VIGI, Reolink, Hikvision, Dahua, Amcrest o cualquier cámara ONVIF o RTSP         |
| <img src="docs/assets/logos/steam.svg" width="28" height="28" alt="Steam" title="Steam"> <img src="docs/assets/logos/epic-games.svg" width="28" height="28" alt="Epic Games" title="Epic Games"> <img src="docs/assets/logos/minecraft.svg" width="28" height="28" alt="Minecraft" title="Minecraft"> <img src="docs/assets/logos/discord.svg" width="28" height="28" alt="Discord" title="Discord">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Servidores de juegos**: los jugadores vinculan sus cuentas para que el servidor los reconozca                                                                         |
| <img src="docs/assets/logos/spotify.svg" width="28" height="28" alt="Spotify" title="Spotify"> <img src="docs/assets/logos/tenor.svg" width="28" height="28" alt="Tenor" title="Tenor"> <img src="docs/assets/logos/giphy.svg" width="28" height="28" alt="GIPHY" title="GIPHY">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Chat**: escuchar juntos en Spotify, GIFs de Tenor y GIPHY, filtro de ruido de Krisp en llamadas                                                                       |
| <img src="docs/assets/logos/virustotal.svg" width="28" height="28" alt="VirusTotal" title="VirusTotal"> <img src="docs/assets/logos/criminal-ip.svg" width="28" height="28" alt="Criminal IP" title="Criminal IP">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Seguridad**: archivos subidos analizados por VirusTotal, direcciones maliciosas bloqueadas con Criminal IP o Dymo                                                     |
| <img src="docs/assets/logos/bitwarden.svg" width="28" height="28" alt="Bitwarden" title="Bitwarden"> <img src="docs/assets/logos/keepassxc.svg" width="28" height="28" alt="KeePassXC" title="KeePassXC">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Vault**: las apps y extensiones de Bitwarden apuntan a él; importa de Bitwarden, KeePass o cualquier CSV                                                              |
| <img src="docs/assets/logos/obsidian.svg" width="28" height="28" alt="Obsidian" title="Obsidian">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Notas**: un vault de Obsidian, o cualquier carpeta de Markdown, importado con sus enlaces                                                                             |
| <img src="docs/assets/logos/postgresql.svg" width="28" height="28" alt="PostgreSQL" title="PostgreSQL"> <img src="docs/assets/logos/mysql.svg" width="28" height="28" alt="MySQL" title="MySQL"> <img src="docs/assets/logos/mariadb.svg" width="28" height="28" alt="MariaDB" title="MariaDB"> <img src="docs/assets/logos/mongodb.svg" width="28" height="28" alt="MongoDB" title="MongoDB"> <img src="docs/assets/logos/redis.svg" width="28" height="28" alt="Redis" title="Redis">                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Bases de datos**: desplegadas o externas, para explorar, consultar y respaldar                                                                                        |

Mail acepta además cualquier cuenta IMAP e importa archivos `.mbox` y `.eml`.

## Las apps se enlazan entre sí

Lo que se crea en una app se alcanza desde las demás sin copiarlo.

- **Menciónalo.** Escribe `#` en un mensaje de chat, un correo, una tarea o una nota para enlazar una tarea, un doc o una nota. Un enlace pegado a una tarea, evento, canal o mensaje se convierte en una tarjeta con su estado actual.
- **Adjunta desde Drive.** Chat, Mail, Tasks y Office toman un archivo directamente de Drive, sin descargarlo y volver a subirlo.
- **Planifícalo en Calendar.** Crea una tarea que vence en un hueco, o da a un evento un enlace de reunión de Polaris.
- **Pásaselo a un agente.** Una tarea va a un agente de código desde su panel; el agente la lee y la mueve con el servidor MCP de Polaris.
- **Entérate en Chat.** Las alertas de cámaras y dispositivos de Places llegan como mensajes.

```mermaid
flowchart LR
    Drive -- adjuntar --> Chat
    Drive -- adjuntar --> Mail
    Drive -- adjuntar --> Tasks
    Drive -- abrir como documento --> Office
    Chat -- "mención con #" --> Tasks
    Mail -- "mención con #" --> Tasks
    Notes -- "mención con #" --> Tasks
    Calendar -- nueva tarea con fecha --> Tasks
    Calendar -- enlace de reunión --> Chat
    Tasks -- pasar a un agente --> Agents
```

## Incluido en cada app que despliegas

Funciona con cualquier servicio que Polaris despliegue, sin SDK, agente ni cambios en el código de la app: se ejecuta en el edge o en el host.

|                                                                                                                                                                                                                                                    | En lugar de                                         | Polaris                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <img src="docs/assets/logos/google-analytics.svg" width="28" height="28" alt="Google Analytics" title="Google Analytics"> <img src="docs/assets/logos/plausible.svg" width="28" height="28" alt="Plausible Analytics" title="Plausible Analytics"> | Google Analytics, Plausible                         | **Analytics** leída del log de accesos del edge, sin etiqueta script                                                                                   |
| <img src="docs/assets/logos/cloudflare.svg" width="28" height="28" alt="Cloudflare" title="Cloudflare">                                                                                                                                            | Cloudflare WAF y Access                             | **Firewall** delante de cada ruta: reglas por país y red, defensa contra bots, detección de inyecciones, baneos y un muro de inicio de sesión opcional |
| <img src="docs/assets/logos/beekeeper-studio.svg" width="28" height="28" alt="Beekeeper Studio" title="Beekeeper Studio">                                                                                                                          | Beekeeper Studio y otros clientes de bases de datos | **Bases de datos**: explorar y consultar Postgres, MySQL, MariaDB, MongoDB y Redis                                                                     |
| <img src="docs/assets/logos/uptime-kuma.svg" width="28" height="28" alt="Uptime Kuma" title="Uptime Kuma">                                                                                                                                         | Uptime Kuma y otros monitores de disponibilidad     | **Watch**: cada dominio comprobado, y aviso si una caída se mantiene                                                                                   |
| <img src="docs/assets/logos/datadog.svg" width="28" height="28" alt="Datadog" title="Datadog">                                                                                                                                                     | Datadog y otros agentes de métricas                 | **Métricas** de cada contenedor y servidor, leídas por SSH y Docker                                                                                    |
| <img src="docs/assets/logos/lets-encrypt.svg" width="28" height="28" alt="Let's Encrypt" title="Let's Encrypt">                                                                                                                                    | Certbot                                             | **HTTPS**: certificados de Let's Encrypt emitidos y renovados para cada dominio público                                                                |

<img src="docs/assets/logos/sentry.svg" width="20" height="20" alt="Sentry" title="Sentry"> El seguimiento de errores es la excepción: **Telemetry** recibe eventos del SDK de Sentry que tu app ya usa, así que el único cambio es el DSN.

## Cómo funciona

### Actualizar

El botón Actualizar de Ajustes es como se actualiza un Polaris instalado. La edición limitada no tiene daemon de host, así que allí el botón indica que las actualizaciones no están disponibles.

```mermaid
flowchart LR
    A[Botón Actualizar] --> B[dashboard]
    B -- edición completa: POST /v1/update --> C[polaris-hostd]
    B -- edición limitada: sin hostd --> Y[actualizaciones no disponibles]
    C -- comando de actualización definido --> D[polaris-updater]
    D --> E[scripts/update.sh]
    E --> F[descargar la versión]
    F --> G[añadir ajustes nuevos a .env]
    G --> H[arrancar el nuevo dashboard, retirar el anterior]
    C -- sin comando de actualización --> X[501: no disponible]
```

### Una petición a través del edge

Cada router tiene una prioridad explícita, de mayor a menor. Las rutas con reglas de firewall pasan por el guard antes de llegar a la app.

```mermaid
flowchart LR
    R[petición] --> T[Traefik]
    T -- "110: ruta de llamadas, protegida" --> L[LiveKit]
    T -- "100: /livekit, /api/deploy/ws" --> P[LiveKit, terminal]
    T -- "50: dominios del dashboard" --> D[dashboard]
    T -- "40: dominios de apps desplegadas" --> G{guard del firewall}
    G -- permitida --> S[contenedor de la app]
    G -- denegada --> B[página de bloqueo]
    T -- "10: resto" --> D
    T -- "1: nombre sin ruta" --> V[página vacía]
```

### Desplegar una app

```mermaid
flowchart LR
    A[Repositorio Git] --> B[build en el servidor o en una máquina de build elegida]
    U[subida] --> B
    I[imagen] --> C
    B --> C
    C[contenedor en el host de Polaris o un servidor añadido] --> E[Traefik de ese servidor: ruta y firewall]
    E --> F[tu dominio, un túnel de Cloudflare o ngrok, o DuckDNS]
```

### Estructura del repositorio

```mermaid
flowchart TB
    subgraph dashboard
        web[apps/web: dashboard Next.js]
        apps[apps/calendar, places, game-servers, crm]
        ext[apps/extension: extensión del navegador]
        pkgs[packages: core, db, ui, storage, deploy, ...]
        svc[services: edge-guard, messaging-bridge, camera-relay, vision, face, hytale]
        cli[packages/cli: CLI para desarrolladores]
    end
    hostd[crates/polaris-hostd: daemon de host en Rust]
    desk[desktop: app Electron]
    plug[plugins/unifi-unas]
    web --> pkgs
    apps --> pkgs
    cli --> web
    desk --> web
    ext --> web
    web -- socket unix --> hostd
```

## Licencia

Polaris se distribuye bajo la [GNU AGPL-3.0](LICENSE) con los términos adicionales
de [NOTICE.md](NOTICE.md). Para usarlo fuera de esos términos, por ejemplo en un
producto de código cerrado, pide una licencia comercial (ver
[NOTICE.md](NOTICE.md)).
