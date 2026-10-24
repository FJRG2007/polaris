# Conectar asistentes de IA (MCP)

[Read in English](connecting-ai-assistants.md) - [Volver al README](../README.es.md)

Polaris es un servidor MCP. Claude, ChatGPT, Cursor, VS Code y cualquier otro
cliente que hable MCP remoto (Streamable HTTP o SSE, o stdio a través de
mcp-remote) pueden conectarse, iniciar sesión como tú y trabajar con tus
tareas, despliegues, notas, chat, Drive y correo, y, cuando están instalados,
con tu calendario, los dispositivos de tus lugares y tus servidores de juegos.
Cada asistente solo puede hacer lo que apruebas al conectarlo, y nunca más que
tu propia cuenta.

La forma más rápida es **Cuenta > Asistentes de IA**, que muestra la
configuración de cada cliente con cada valor (nombre, URL, autenticación,
transporte) listo para copiar bajo el campo donde va, además de enlaces de
instalación. Esta página tiene la misma información, más cómo funciona.

## La URL de tu servidor

```
https://<your-polaris-address>/api/mcp
```

Usa la dirección con la que abres Polaris. Una conexión hecha en una dirección
(tu dominio) no funciona en otra (`polaris.local`); si usas las dos, conecta
también en la otra.

Un cliente que solo habla el transporte antiguo HTTP+SSE usa
`https://<your-polaris-address>/api/mcp/sse`. Lleva el mismo inicio de sesión y
los mismos permisos.

## Configurar cada cliente

Todos los clientes de abajo inician sesión en la pantalla de consentimiento de
Polaris. No se copia ninguna clave. **Cuenta > Asistentes de IA** tiene las
mismas guías con tu dirección ya puesta: elige tu cliente en la cuadrícula.

### Claude (claude.ai y Claude Desktop)

1. Abre **Customize > Connectors** y elige **Add custom connector**.
2. Llámalo Polaris, pega la URL del servidor y elige **Add**.
3. Elige **Connect** e inicia sesión en Polaris.

En los planes Team y Enterprise, un propietario añade antes el conector en
**Organization settings > Connectors**. Claude se conecta desde los servidores
de Anthropic, así que en este caso tu Polaris tiene que ser accesible desde
internet.
[Guía de Claude](https://claude.com/docs/connectors/custom/remote-mcp)

### Claude Code

```sh
claude mcp add --transport http polaris https://<your-polaris-address>/api/mcp
```

Después ejecuta `/mcp` dentro de Claude Code y elige `polaris` para iniciar
sesión. Añade `--scope user` para tenerlo en todos los proyectos, o
`--scope project` para compartirlo mediante `.mcp.json`.
[Guía de Claude Code](https://code.claude.com/docs/en/mcp)

### ChatGPT

Requiere un plan Plus, Pro, Business, Enterprise o Education, en la web. En un
espacio de trabajo Business, Enterprise o Education, puede que un administrador
tenga que permitir antes el modo desarrollador.

1. Abre **Settings > Security and login** y activa **Developer mode**.
2. Abre **Plugins**, selecciona **Add** y después **Create MCP App**.
3. Llámala Polaris. En **Connection**, deja **Server URL** y pega la URL del
   servidor.
4. Pon **Authentication** en **OAuth**. No hace falta client ID ni secreto:
   Polaris registra a ChatGPT por sí mismo.
5. Marca **I understand and want to continue** y selecciona **Create**.
6. Inicia sesión en Polaris cuando ChatGPT lo pida.

Si **Add** solo ofrece **Create plugin** y **Upload plugin**, el modo
desarrollador está desactivado. Esas dos opciones son para plugins empaquetados
y no aceptan una URL de servidor.

Igual que Claude en la web, ChatGPT se conecta desde sus propios servidores y
necesita que Polaris sea accesible desde internet.
[Guía de OpenAI](https://developers.openai.com/api/docs/guides/developer-mode)

### Cursor

Usa **Añadir a Cursor** en la página de asistentes de IA (el enlace documentado
de Cursor `cursor://anysphere.cursor-deeplink/mcp/install`), o añade esto a
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "polaris": { "url": "https://<your-polaris-address>/api/mcp" }
  }
}
```

Cursor te pide iniciar sesión la primera vez que usa Polaris.
[Guía de Cursor](https://cursor.com/docs/context/mcp)

### Visual Studio Code

Usa **Añadir a VS Code** en la página de asistentes de IA, ejecuta
`code --add-mcp '{"name":"polaris","type":"http","url":"https://<your-polaris-address>/api/mcp"}'`,
o ejecuta **MCP: Open User Configuration** y añade:

```json
{
  "servers": {
    "polaris": {
      "type": "http",
      "url": "https://<your-polaris-address>/api/mcp"
    }
  }
}
```

[Guía de VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)

### GitHub Copilot

Copilot en VS Code usa la configuración de Visual Studio Code de arriba. Para
Copilot CLI:

```sh
copilot mcp add --transport http polaris https://<your-polaris-address>/api/mcp
```

e inicia sesión cuando Copilot lo pida. El agente en la nube de Copilot no
puede iniciar sesión en servidores, así que necesita una clave API (ver más
abajo).
[Guía de GitHub](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)

### Codex CLI

```sh
codex mcp add polaris --url https://<your-polaris-address>/api/mcp
codex mcp login polaris
```

### Devin

1. Abre **Customize > MCPs**, elige **Add MCP** y después **Add custom MCP**.
2. Llámalo Polaris, elige el transporte **HTTP**, pega la URL del servidor y
   pulsa **Save**.
3. Elige **Connect** e inicia sesión en Polaris.

[Guía de Devin](https://docs.devin.ai/work-with-devin/mcp)

### Figma Make

1. En un chat de Figma Make, pulsa **Add context**, pasa el ratón por
   **Connectors** y selecciona **Manage**.
2. En **Created by you**, pulsa **Create**, llámalo Polaris y pega la URL del
   servidor.
3. Pulsa **Create**, después **Connect**, e inicia sesión en Polaris.

Requiere un plan de pago de Figma; un administrador puede desactivar los
conectores personalizados.
[Guía de Figma](https://help.figma.com/hc/en-us/articles/38147204302743-Create-and-use-custom-MCP-connectors-in-Figma-Make)

### Grok

1. Abre [grok.com/connectors](https://grok.com/connectors).
2. Pulsa **New Connector** y selecciona **Custom**.
3. Pega la URL del servidor e inicia sesión en Polaris cuando Grok lo pida.

En Grok Business y Enterprise, un administrador añade antes el conector.
[Guía de xAI](https://docs.x.ai/grok/connectors)

### Mistral Le Chat

1. Abre **Connectors**, pulsa **+ Add Connector** y cambia a **Custom MCP
   Connector**.
2. Llámalo `polaris` y pega la URL del servidor.
3. Pulsa **Connect** e inicia sesión en Polaris.

Solo un administrador puede añadir un conector personalizado.
[Guía de Mistral](https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors)

### Zapier

1. Abre **Apps**, pulsa **+ Add connection** y elige **MCP Client**.
2. Pega la URL del servidor, pon **Transport** en **Streamable HTTP** y
   **OAuth** en **Yes**.
3. Pulsa **Yes, Continue to MCP Client** e inicia sesión en Polaris.

[Guía de Zapier](https://help.zapier.com/hc/en-us/articles/38777069364109-Connect-remote-MCP-servers-to-Zapier-using-MCP-Client)

### Make

1. Añade un módulo **MCP Client** a un escenario y pulsa **Create a
   connection**.
2. En **MCP Server**, elige **+ New MCP Server** y pega la URL del servidor.
3. Pulsa **Save**, e inicia sesión en Polaris si Make lo pide.

[Guía de Make](https://apps.make.com/mcp-client)

### OpenCode

Añade esto a `opencode.json`:

```json
{
  "mcp": {
    "polaris": {
      "type": "remote",
      "url": "https://<your-polaris-address>/api/mcp",
      "enabled": true
    }
  }
}
```

Después inicia sesión con `opencode mcp auth polaris`.
[Guía de OpenCode](https://opencode.ai/docs/mcp-servers/)

### Kimi Code

```sh
kimi mcp add --transport http --auth oauth polaris https://<your-polaris-address>/api/mcp
kimi mcp auth polaris
```

[Guía de Kimi Code](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html)

### Cualquier otro cliente

1. Abre los ajustes de MCP o de conectores de tu cliente.
2. Elige un tipo de conexión.
3. Copia su configuración.
4. Inicia sesión en Polaris cuando tu cliente lo pida.

Streamable HTTP, para clientes que admiten servidores remotos (recomendado):

```json
{
  "mcpServers": {
    "polaris": { "url": "https://<your-polaris-address>/api/mcp" }
  }
}
```

SSE, para clientes que admiten servidores remotos pero no Streamable HTTP:

```json
{
  "mcpServers": {
    "polaris": {
      "type": "sse",
      "url": "https://<your-polaris-address>/api/mcp/sse"
    }
  }
}
```

stdio, para clientes que solo ejecutan comandos locales. Necesita Node.js;
[mcp-remote](https://www.npmjs.com/package/mcp-remote) hace de puente con
Polaris y abre el inicio de sesión en tu navegador:

```json
{
  "mcpServers": {
    "polaris": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-polaris-address>/api/mcp"]
    }
  }
}
```

### Con una clave API

Un cliente que no puede iniciar sesión (un script, un job de CI, el agente en
la nube de Copilot) puede enviar una clave API de Polaris de **Cuenta > Claves
API** como `Authorization: Bearer plk_...`. Para Claude Code:

```sh
claude mcp add --transport http polaris https://<your-polaris-address>/api/mcp \
    --header "Authorization: Bearer plk_..."
```

Los scopes de la clave funcionan exactamente igual que los de un asistente. Una
clave solo lleva permisos, así que los scopes más finos de abajo (correo,
calendario, Lugares, servidores de juegos) son para asistentes que inician
sesión.

## Qué apruebas

Cuando un asistente se conecta ves su nombre, **la dirección a la que te
devuelve** y una casilla por permiso. El nombre es lo que la app dice de sí
misma; la dirección de vuelta es lo que Polaris comprueba, así que mira esa. Una
app que vuelve a `localhost` o `127.0.0.1` se ejecuta en tu propio ordenador:
continúa solo si iniciaste tú la conexión.

Desmarca lo que no deba hacer. Marcar un permiso que necesita otro (por
ejemplo, cambiar tareas necesita leerlas) marca también ese. Lo que llega fuera
de Polaris o a tu casa (enviar correo, cambiar tu calendario, manejar un
dispositivo, ejecutar una rutina, arrancar o parar un servidor de juegos)
empieza desmarcado: márcalo solo si quieres que el asistente lo haga.

| Permiso         | Qué puede hacer el asistente                                                   |
| --------------- | ------------------------------------------------------------------------------ |
| `tasks.read`    | Leer espacios, listas y tareas                                                 |
| `tasks.manage`  | Crear tareas, cambiarlas y comentar                                            |
| `agents.read`   | Ver sesiones de agentes                                                        |
| `agents.manage` | Iniciar sesiones de agentes y enviarles prompts                                |
| `deploy.read`   | Ver apps, despliegues, logs, nombres de variables (nunca valores) y dominios   |
| `deploy.manage` | Desplegar, reiniciar, revertir, definir variables y añadir dominios            |
| `notes.use`     | Listar, leer, escribir y cambiar tus notas                                     |
| `chat.use`      | Listar tus conversaciones, leerlas y enviar mensajes                           |
| `drive.read`    | Listar tus almacenamientos y carpetas, y ver los detalles de un archivo        |
| `shares.create` | Crear un enlace público a un archivo que puedes descargar                      |
| `mail.read`     | Listar, buscar y leer el correo de los buzones que vinculaste                  |
| `mail.send`     | Enviar correo desde tus buzones, en tu nombre                                  |

Con la app Calendario, Lugares o Servidores de juegos instalada:

| Permiso              | Qué puede hacer el asistente                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `calendar.read`      | Ver tus calendarios y sus eventos                                         |
| `calendar.manage`    | Crear, cambiar y borrar eventos (incluye `calendar.read`)                 |
| `places.read`        | Ver los dispositivos de tus lugares y su estado                           |
| `places.control`     | Cerrar, abrir, encender, apagar y ajustar dispositivos (incluye `places.read`) |
| `places.routines`    | Ver y ejecutar las rutinas de tus lugares                                 |
| `gameservers.read`   | Ver tus servidores de juegos y quién está jugando                         |
| `gameservers.manage` | Arrancarlos, pararlos y reiniciarlos, y usar sus consolas                 |

Cada uno se apoya en un permiso de tu cuenta (el correo en usar Correo, el
calendario en usar el Calendario, los dispositivos en ver o controlar lugares,
las rutinas en gestionarlos, los servidores de juegos en verlos o gestionarlos)
y deja de hacer nada en cuanto ya no lo tienes. Solo se ofrecen los permisos que
tiene tu cuenta, y de las apps instaladas aquí.

Un asistente conectado antes de que leer y cambiar el calendario se separaran
puede tener `calendar.use`: sigue leyendo tus próximos eventos, y se le puede
dar `calendar.read` o `calendar.manage` desde **Cambiar permisos**.

## Gestionar los asistentes conectados

**Cuenta > Asistentes de IA** lista cada asistente que has conectado, qué puede
hacer y cuándo y desde dónde se usó por última vez.

- **Cambiar permisos** abre las mismas casillas que la pantalla de
  consentimiento. Un permiso que quitas se rechaza en la siguiente llamada del
  asistente; uno que añades también funciona en su siguiente llamada. Se puede
  añadir cualquier cosa que ofrezca Polaris (un permiso que el asistente no pidió
  al conectarse, o uno añadido a Polaris después, aparece marcado como tal y
  sigue desactivado hasta que lo marcas), pero nunca más de lo que tiene tu
  cuenta. Un permiso de una app que ya no está instalada no se muestra y se
  conserva como estaba.
- **Desde dónde puede conectarse** fija una regla de direcciones para esa
  conexión, además de las reglas de acceso de tu cuenta: desde cualquier sitio
  (lo predeterminado), solo desde la dirección desde la que la aprobaste, una
  lista de direcciones IP y rangos permitidos y denegados (IPv4 e IPv6; una
  entrada denegada gana), o solo desde donde tienes sesión iniciada en Polaris
  ahora mismo (una dirección IPv6 cuenta por su /64 entera). Se comprueba en cada
  llamada y en cada renovación de token. Una llamada rechazada recibe un 403 que
  dice que la dirección no está permitida, y el rechazo aparece en la conexión y
  en tu actividad.
- **Desconectar** lo detiene al momento: se terminan todos sus tokens, y hay que
  volver a conectarlo pasando por la pantalla de consentimiento.

### Asistentes que llaman desde sus propios servidores

ChatGPT, Claude en la web y otros asistentes alojados llaman a Polaris desde los
servidores de su proveedor, no desde tu dispositivo. ChatGPT, por ejemplo, llama
desde los servidores de OpenAI en Estados Unidos. Si un administrador limitó tu
cuenta a ciertos países, continentes o direcciones, esas llamadas se rechazan
con un 403 que lo dice, y **Cuenta > Asistentes de IA** muestra una nota que lo
explica.

Un administrador puede dejar pasar una conexión sin abrir la cuenta: abre
**Desde dónde puede conectarse** en esa conexión y rellena **También desde**:

- países y continentes, elegidos de la misma lista que **Cuenta > Acceso**;
- direcciones IP y rangos;
- **Direcciones publicadas por OpenAI (ChatGPT)**, la lista que OpenAI publica
  para los conectores de ChatGPT en <https://openai.com/chatgpt-connectors.json>
  ([documentación de OpenAI](https://developers.openai.com/api/docs/guides/ip-addresses)).
  Polaris la vuelve a leer cada pocas horas, así que la conexión sigue los
  cambios de OpenAI. Hasta que se ha leído una vez no coincide con nada.

La excepción solo se aplica a las llamadas hechas con los tokens de esa
conexión. Tú, tus sesiones, tus claves API y cualquier otra conexión siguen
sujetos a las reglas de la cuenta. La regla de direcciones de la propia conexión
sigue aplicándose encima, así que una excepción nunca deja pasar una dirección
que esa regla rechaza. Un país solo coincide cuando la dirección se resuelve a
él.

Las reglas son de un administrador, así que solo un administrador puede ampliar
una excepción; cualquiera puede quitar entradas. Una excepción fijada mientras
la cuenta era de un administrador deja de contar si ya no lo es. Cada cambio se
escribe en la actividad y lanza la alerta de seguridad, y la conexión muestra
desde dónde se le permite además.

Conectar un asistente lanza la misma alerta de seguridad que crear una clave
API, igual que cambiar lo que puede hacer y que una conexión que Polaris termina
por su cuenta porque uno de sus tokens se presentó dos veces, lo que significa
que otra persona lo tenía. Todas abren **Cuenta > Asistentes de IA**.

Si vuelves a pasar por la pantalla de consentimiento para una app que ya
conectaste y desmarcas un permiso, todos sus tokens, incluidos los ya emitidos,
se recortan a lo que marcaste la próxima vez que se usen o se renueven, no solo
en su siguiente token nuevo.

Si te quitan un rol, tus asistentes pierden lo que les daba ese rol en su
siguiente llamada.

## Herramientas

Primero las de lectura, después las que cambian algo. Los clientes usan las
anotaciones para preguntarte antes de un cambio; las marcadas como "cambia"
preguntan por defecto.

A un asistente solo se le muestran las herramientas que sus permisos le dejan
usar, así que uno aprobado para el calendario no recibe también las de
despliegue. Pídele `polaris_tools` para ver el resto y el permiso que necesita
cada una. `polaris_search` encuentra una cosa por el nombre que le diste (una
tarea, una alarma, un servidor) y dice qué herramienta actúa sobre ella.

Cuando una herramienta recibe una tarea, una alarma, un temporizador o una app
por su nombre, solo actúa sobre un nombre exacto, sin tener en cuenta
mayúsculas ni acentos. Cuando dos comparten nombre, al asistente se le dicen
ambos y se le pide el que quiere decir; nunca elige.

| Herramienta                                                                                                                                     | Permiso                    | Tipo                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------- |
| `polaris_whoami`                                                                                                                                | ninguno                    | lee                                     |
| `tasks_list`, `tasks_get`, `tasks_spaces`                                                                                                       | `tasks.read`               | lee                                     |
| `tasks_create`, `tasks_comment`                                                                                                                 | `tasks.manage`             | añade                                   |
| `tasks_update`                                                                                                                                  | `tasks.manage`             | cambia                                  |
| `tasks_reminders`                                                                                                                               | `tasks.read`               | lee                                     |
| `tasks_remind`                                                                                                                                  | `tasks.manage`             | añade                                   |
| `tasks_reminder_cancel`                                                                                                                         | `tasks.manage`             | cambia                                  |
| `agent_sessions_list`, `agent_session_get`                                                                                                      | `agents.read`              | lee                                     |
| `agent_session_start`, `agent_session_prompt`                                                                                                   | `agents.manage`            | añade                                   |
| `deploy_projects`, `deploy_service`, `deploy_deployments`, `deploy_deployment`, `deploy_logs`, `deploy_variables`, `env_list`, `deploy_domains` | `deploy.read`              | lee                                     |
| `deploy_add_domain`                                                                                                                             | `deploy.manage`            | añade                                   |
| `deploy_start`, `deploy_set_variable`, `env_set`, `env_delete`, `deploy_restart`, `deploy_rollback`                                             | `deploy.manage`            | cambia                                  |
| `watch_alarms`                                                                                                                                  | `deploy.read`              | lee                                     |
| `watch_alarm_create`                                                                                                                            | `deploy.manage`            | añade                                   |
| `watch_alarm_change`                                                                                                                            | `deploy.manage`            | cambia                                  |
| `notes_list`, `notes_get`                                                                                                                       | `notes.use`                | lee                                     |
| `notes_create`                                                                                                                                  | `notes.use`                | añade                                   |
| `notes_update`                                                                                                                                  | `notes.use`                | cambia                                  |
| `chat_conversations`, `chat_messages`                                                                                                           | `chat.use`                 | lee                                     |
| `chat_send`                                                                                                                                     | `chat.use`                 | añade                                   |
| `drive_sources`, `drive_list`, `drive_stat`                                                                                                     | `drive.read`               | lee                                     |
| `drive_share_create`                                                                                                                            | `shares.create`            | cambia (publica un archivo)             |
| `mail_mailboxes`                                                                                                                                | `mail.read` o `mail.send`  | lee                                     |
| `mail_list`, `mail_read`                                                                                                                        | `mail.read`                | lee                                     |
| `mail_send`                                                                                                                                     | `mail.send`                | añade (tras tu plazo para deshacer)     |

Se ofrecen solo mientras su app está instalada:

| Herramienta                                                   | Permiso                           | Tipo                       |
| ------------------------------------------------------------- | --------------------------------- | -------------------------- |
| `calendar_upcoming`                                           | `calendar.read` o `calendar.use`  | lee                        |
| `calendar_calendars`, `calendar_events`                       | `calendar.read`                   | lee                        |
| `calendar_create`                                             | `calendar.manage`                 | añade                      |
| `calendar_update`                                             | `calendar.manage`                 | cambia                     |
| `calendar_delete`                                             | `calendar.manage`                 | cambia (a la papelera)     |
| `clock_list`                                                  | `calendar.read`                   | lee                        |
| `clock_timer_start`                                           | `calendar.manage`                 | añade                      |
| `clock_alarm_set`, `clock_alarm_change`, `clock_timer_change` | `calendar.manage`                 | cambia                     |
| `places_devices`                                              | `places.read`                     | lee                        |
| `places_device_control`                                       | `places.control`                  | cambia                     |
| `places_routines`                                             | `places.routines`                 | lee                        |
| `places_routine_run`                                          | `places.routines`                 | añade (una ejecución)      |
| `games_servers`, `games_server_status`                        | `gameservers.read`                | lee                        |
| `games_server_power`, `games_console`                         | `gameservers.manage`              | cambia                     |

Cada herramienta aplica las mismas reglas que las pantallas de la app: un
calendario compartido contigo de solo lectura sigue siendo de solo lectura, un
dispositivo que alguien te prestó es el único que puedes abrir, y la consola
necesita el permiso de consola en ese servidor.

No se ofrecen a propósito: valores de variables, contenido de archivos,
elementos del almacén, adjuntos de correo, cámaras y grabaciones.
Un valor definido con `env_set` se guarda y nunca se devuelve.
Cada cambio hecho con una herramienta se escribe en tu registro de actividad
con el asistente que lo hizo. Cada conexión puede hacer 120 llamadas a
herramientas por minuto, 30 de ellas cambios.

## Cómo funciona

Polaris sigue la especificación de autorización de MCP
([modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)):
OAuth 2.1 con Polaris como su propio servidor de autorización.

| Endpoint                                              | Qué es                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/mcp`                                       | El servidor MCP (Streamable HTTP, respuestas JSON)     |
| `GET`/`POST /api/mcp/sse`                             | El mismo servidor con el transporte antiguo HTTP+SSE   |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | Protected Resource Metadata (RFC 9728)                 |
| `GET /.well-known/oauth-authorization-server`         | Authorization Server Metadata (RFC 8414)               |
| `POST /api/oauth/register`                            | Dynamic Client Registration (RFC 7591)                 |
| `GET /oauth/authorize`                                | La pantalla de consentimiento                          |
| `POST /api/oauth/token`                               | Endpoint de tokens: código de autorización y renovación |
| `POST /api/oauth/revoke`                              | Revocación de tokens (RFC 7009)                        |

- Una llamada sin credencial recibe un `401` con un desafío `WWW-Authenticate`
  que apunta a los metadatos del recurso, que es como un cliente encuentra el
  resto.
- Las apps se registran solas (RFC 7591) o se identifican con la dirección https
  de su Client ID Metadata Document, que Polaris descarga. Las direcciones de
  redirección tienen que ser https, o http a `localhost`, `127.0.0.1` o `[::1]`;
  se comparan exactamente, salvo que una dirección loopback puede usar cualquier
  puerto (RFC 8252).
- Solo se aceptan clientes públicos: se rechaza un registro o documento de
  metadatos que solo puede autenticarse con un par de claves. Uno que lista
  varios métodos de token (como el de ChatGPT) se acepta cuando `none` está
  entre ellos, prefiera el método que prefiera.
- Un registro, documento de metadatos o autorización que Polaris rechaza se
  registra en el servidor con su motivo, para que una conexión que falla en
  pantalla pueda diagnosticarse sin adivinar.
- PKCE con S256 es obligatorio. Los códigos duran cinco minutos y funcionan una
  vez. Las respuestas llevan `iss` (RFC 9207).
- El endpoint SSE es el mismo recurso que `/api/mcp`: cada petición la responde
  el manejador de `/api/mcp`, así que el token, los permisos, las reglas de
  direcciones y los límites son los mismos, y nombrar `/api/mcp/sse` como
  recurso también da tokens para `/api/mcp`. El GET abre un stream que indica
  adónde hacer POST; un POST solo se acepta de la credencial que abrió su stream
  (cuenta un token renovado de la misma conexión), y su respuesta llega por ese
  stream. Una conexión puede tener cuatro streams abiertos a la vez, 500 en toda
  la instancia; un stream sigue abierto como mucho 12 horas, y una credencial
  puede abrir como mucho 30 por minuto.
- Los tokens de acceso duran una hora y solo funcionan en `/api/mcp` (y, como el
  mismo recurso, `/api/mcp/sse`) en la dirección para la que se emitieron
  (indicadores de recurso, RFC 8707). Los tokens de renovación duran 30 días y
  cambian en cada uso; presentar uno antiguo termina toda la conexión, igual que
  canjear un código dos veces.
- Polaris solo guarda hashes SHA-256 de códigos, tokens y secretos de cliente.
- La página de consentimiento no se puede mostrar dentro de un frame.

## Solución de problemas

- **El cliente dice que no llega al servidor.** Claude en la web y ChatGPT se
  conectan desde sus propios servidores, así que Polaris tiene que ser accesible
  desde internet en la dirección que les diste. Claude Code, Cursor y VS Code
  solo necesitan llegar desde tu ordenador.
- **"Esta conexión no puede continuar".** Polaris no reconoce la app, no pudo
  leer los datos que publica sobre sí misma, no acepta esos datos, o el enlace
  te enviaría a una dirección que la app nunca registró. Vuelve a iniciar la
  conexión desde la app; si sigue pasando, quita Polaris de la app y añádelo de
  nuevo.
- **Una herramienta dice que la conexión necesita un scope.** Vuelve a conectar
  la app y marca ese permiso, o pídeselo a un administrador si no se ofrece.
- **Ha dejado de funcionar.** Mira **Cuenta > Asistentes de IA**: si no aparece,
  se desconectó (tú, o porque uno de sus tokens se usó dos veces). Vuelve a
  conectarlo desde la app.
