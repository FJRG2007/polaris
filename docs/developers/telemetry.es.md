# Telemetría: informes de errores con los SDK de Sentry

[Read in English](telemetry.md) - [Volver a la guía de desarrollo](README.md)

La telemetría de Polaris recoge los errores que informan tus aplicaciones y los
agrupa en incidencias. Habla el protocolo de ingesta de Sentry, así que los SDK
oficiales de Sentry informan a Polaris sin cambios: lo único que configuras es
el DSN.

En los ejemplos, `https://polaris.example.com` es la dirección pública de tu
Polaris, `YOUR_KEY` la clave pública del proyecto y `PROJECT_NUMBER` su número.

## Inicio rápido

1. Abre **Telemetría**, crea un proyecto y abre su sección **Cliente**.
2. Copia la dirección de **Informar a**. Ese es el DSN:

```text
https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER
```

3. Pásalo como `dsn` a cualquier SDK de Sentry (ejemplos abajo).
4. Revisa **Informadores** antes de desplegar: un proyecto nuevo solo acepta
   informes desde la red local. Una aplicación de navegador necesita **Donde
   sea**. Consulta [Quién puede informar](#quien-puede-informar).

**Sustituir la clave** genera un DSN nuevo; los clientes que sigan con el
anterior dejan de aceptarse.

## Endpoints

Todos los SDK los construyen a partir del DSN:

| Ruta | La usan |
| --- | --- |
| `POST /api/telemetry/api/PROJECT_NUMBER/envelope/` | Los SDK actuales |
| `POST /api/telemetry/api/PROJECT_NUMBER/store/` | SDK antiguos (un evento JSON) |

La clave pública se lee, por orden, del parámetro `sentry_key` de la query, de
`sentry_key=` en la cabecera `X-Sentry-Auth` o del `dsn` de la cabecera del
envelope. CORS está abierto, así que los SDK de navegador pueden enviar
directamente.

## Qué se guarda

Polaris guarda **errores y mensajes**: cualquier elemento cuyo contenido lleve
una excepción o un mensaje (`exception.values`, `message`, `logentry`). Eso
cubre `captureException`, `captureMessage` y los manejadores automáticos de
errores de los SDK.

Todo lo demás de un envelope se acepta y se ignora:

| Elemento | Resultado |
| --- | --- |
| `event` con excepción o mensaje | Se guarda y se agrupa en una incidencia |
| `transaction`, `span` (rendimiento) | Se ignora |
| `session`, `sessions` (salud de versiones) | Se ignora |
| `replay_event`, `replay_recording` | Se ignora |
| `attachment`, `profile`, `check_in`, `client_report`, logs | Se ignora |

Así que `tracesSampleRate`, Session Replay y el profiling solo añaden tráfico;
déjalos desactivados. No se pueden subir source maps ni archivos de depuración:
las trazas se muestran tal como las envió el SDK.

De cada evento Polaris lee el nivel (`fatal`, `error`, `warning`, `info`,
`debug`; `critical` se lee como `fatal` y cualquier otro como `error`),
`release`, `environment`, `server_name`, `transaction`, la petición (URL,
método, query, cabeceras, cuerpo), hasta 50 etiquetas, 60 marcos de la pila, 40
breadcrumbs y 16 grupos de contexto. Los valores de cabeceras y cuerpo cuyo
nombre parece secreto (tokens, cookies, contraseñas) se ocultan.

### Agrupación

Los eventos se agrupan por el `fingerprint` que envíe el SDK, si lo hay
(`{{ default }}` dentro añade la agrupación habitual). Si no, por el tipo de
excepción y los marcos de la propia aplicación (archivo y función, nunca número
de línea), y en eventos sin pila por el mensaje sin números, ids ni direcciones.

## Entorno, versión y usuarios

- `environment` y `release` se leen del evento y son lo que usan la sección
  **Versiones** y el filtro de entorno de las reglas de alerta.
- El contexto de usuario alimenta **Usuarios** en cada incidencia. Una persona
  se cuenta por `user.id`, si no por `user.email` (en minúsculas), si no por
  `user.ip_address`. `{{auto}}` no es una dirección y no cuenta, así que pon un
  id o un email para que se cuenten usuarios desde un navegador.
- La incidencia muestra `user.username`, `user.email` o `user.id`, en ese orden.

## Configurar el SDK

La documentación de cada SDK cubre el resto; solo cambia el DSN.

### Navegador (`@sentry/browser`)

```javascript
import * as Sentry from "@sentry/browser";

Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment: "production",
    release: "my-app@1.4.2"
});

Sentry.setUser({ id: "42" });
```

**Informadores** del proyecto debe estar en **Donde sea**: los informes del
navegador llegan desde las direcciones de tus usuarios.

### Next.js (`@sentry/nextjs`)

Inicializa el SDK en cada runtime. `instrumentation-client.ts` para el
navegador:

```javascript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment: process.env.NODE_ENV
});
```

`sentry.server.config.ts` y `sentry.edge.config.ts` llaman al mismo
`Sentry.init`, e `instrumentation.ts` los carga:

```javascript
import * as Sentry from "@sentry/nextjs";

export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
    if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = Sentry.captureRequestError;
```

La subida de source maps de `withSentryConfig` habla con sentry.io, no con
Polaris; déjala sin configurar.

### Node.js (`@sentry/node`)

```javascript
// instrument.mjs, cargado primero: node --import ./instrument.mjs app.mjs
import * as Sentry from "@sentry/node";

Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment: "production",
    release: "my-api@1.4.2"
});
```

El SDK de Node comprime con gzip los cuerpos de más de 32 KiB, y Polaris no
descomprime, así que un evento muy grande se descarta. Consulta
[Compresión](#compresion).

### Python (`sentry-sdk`)

```python
import sentry_sdk

sentry_sdk.init(
    dsn="https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment="production",
    release="my-app@1.4.2",
    # Polaris only reads uncompressed bodies.
    _experiments={"transport_compression_level": 0},
)

sentry_sdk.set_user({"id": "42"})
```

El SDK de Python comprime todas las peticiones por defecto, así que el ajuste
`transport_compression_level` es obligatorio.

### Go (`sentry-go`)

```go
import (
    "time"

    "github.com/getsentry/sentry-go"
)

func main() {
    err := sentry.Init(sentry.ClientOptions{
        Dsn:         "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
        Environment: "production",
        Release:     "my-service@1.4.2",
    })
    if err != nil {
        panic(err)
    }
    defer sentry.Flush(2 * time.Second)

    sentry.ConfigureScope(func(scope *sentry.Scope) {
        scope.SetUser(sentry.User{ID: "42"})
    })
}
```

### Sin SDK

Cualquier cosa que pueda enviar JSON puede informar al endpoint `store`:

```bash
curl -X POST "https://polaris.example.com/api/telemetry/api/PROJECT_NUMBER/store/?sentry_key=YOUR_KEY" \
    -H "Content-Type: application/json" \
    -d '{"event_id":"0123456789abcdef0123456789abcdef","level":"error","message":"Test from curl","environment":"staging"}'
```

Un evento guardado responde con su `event_id`.

## Quién puede informar

La clave pública va dentro de cada cliente, así que nombra un proyecto y no
prueba nada. **Informadores** limita quién puede usarla. Las reglas se comprueban
en este orden:

1. **Dirección.** Una de:
   - **Esta red, y lo que se liste** (por defecto) - direcciones de red privada,
     más las direcciones y rangos que listes. Desde donde informa una aplicación
     desplegada por Polaris.
   - **Solo las direcciones listadas** - para un informador en un sitio
     conocido (un servidor, un runner de builds). Lista al menos una.
   - **Donde sea** - necesario para clientes de navegador.

   Las direcciones son exactas o rangos CIDR. Con las dos primeras, una petición
   sin dirección de cliente se rechaza.
2. **Cliente.** Patrones opcionales de user agent permitidos y denegados. Un
   patrón coincide en cualquier parte del user agent, sin distinguir mayúsculas,
   con `*` para cualquier secuencia (`curl` coincide con `curl/8.4.0`). Un
   patrón denegado siempre gana; una lista de permitidos vacía admite cualquier
   cliente; con lista, una petición sin user agent se rechaza.
3. **Clave.** **Pedir también una clave** añade un segundo valor que el
   informador debe enviar.

Los informes rechazados se cuentan en el proyecto, con la última dirección,
cliente y motivo, y un botón **Permitir** para la dirección.

### Exigir una clave

Activa **Pedir también una clave** y copia la clave que aparece; se guarda como
digest y no se puede volver a mostrar (desactiva y activa el ajuste para crear
otra). Un informe debe llevarla en una de estas formas:

- una cabecera `X-Polaris-Key: YOUR_SECRET`,
- `Authorization: Bearer YOUR_SECRET`,
- `sentry_secret=YOUR_SECRET` en la cabecera `X-Sentry-Auth`.

Los SDK de JavaScript pueden añadir la cabecera con sus opciones de transporte:

```javascript
Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    transportOptions: { headers: { "X-Polaris-Key": "YOUR_SECRET" } }
});
```

Un SDK que no permita poner cabeceras no puede llevar la clave; limítalo por
dirección. Una clave en código de navegador la ve cualquiera que cargue la
página, así que ahí aporta poco.

## Límites

| Límite | Valor |
| --- | --- |
| Tamaño de la petición | 1.000.000 bytes |
| Por proyecto | 600 peticiones por minuto |
| Por dirección de cliente | 300 peticiones por minuto |
| Retención de eventos | de 1 a 365 días (30 por defecto), en **Ajustes** |

Cuántas veces ocurrió cada incidencia se guarda un año, sea cual sea la
retención. **Aceptar informes** en **Ajustes** desactiva la ingesta sin cambiar
el DSN: la dirección sigue respondiendo y no se guarda nada.

### Compresión

Polaris lee el cuerpo de la petición como texto y no descomprime
`Content-Encoding: gzip` ni `br`. Una petición comprimida se descarta. Desactiva
la compresión en los SDK que comprimen (consulta las notas de Python y Node.js).

## Alertas

En **Alertas**, un proyecto puede tener hasta 50 reglas. Cada una salta con un
disparador:

| Disparador | Salta cuando |
| --- | --- |
| Se crea una incidencia | Llega el primer evento de una incidencia nueva |
| Una incidencia se repite | Más de N eventos en una ventana (hasta 7 días) |
| Vuelve una incidencia resuelta | Un evento reabre una incidencia resuelta |

Una regla puede limitarse a ciertos niveles y a un entorno, avisa a los miembros
del proyecto y a hasta 20 personas concretas, y salta como mucho una vez por
periodo de espera (de 1 minuto a 7 días, 60 minutos por defecto). Las alertas
llegan como notificaciones de Polaris.

## Solución de problemas

Los endpoints de ingesta nunca devuelven un estado de error. Las peticiones
rechazadas, limitadas, demasiado grandes, ilegibles o de proyectos inexistentes
reciben `200` con `{"id": ""}`, así que un cliente nunca reintenta y el endpoint
no sirve para averiguar qué proyectos o claves existen. No hay respuestas `401`,
`403`, `413` ni `429` que buscar; un evento guardado responde con su propio id.

| Síntoma | Qué revisar |
| --- | --- |
| No llega nada, el proyecto muestra informes rechazados | Lee el motivo en **Informadores**: la dirección (los clientes de navegador necesitan **Donde sea**), las reglas de cliente, o una clave que falta o es incorrecta. |
| No llega nada, nada rechazado | El DSN es incorrecto o se sustituyó la clave; **Aceptar informes** está desactivado; el cuerpo va comprimido; la petición supera 1.000.000 bytes; o se alcanzó el límite. |
| Faltan transacciones o replays | No se admiten; solo se guardan errores y mensajes. |
| **Usuarios** sigue en 0 | Pon `user.id` o `user.email`; las direcciones `{{auto}}` no cuentan. |
| Todos los informes desde una dirección tras un proxy | El proxy debe pasar la dirección del cliente como primera entrada de `X-Forwarded-For` o como `X-Real-IP`. |
