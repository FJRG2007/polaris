# Analítica: integrar el script

[Read in English](analytics.md) - [Volver a la guía de desarrollo](README.md)

La analítica de Polaris cuenta las visitas a tus sitios sin cookies y sin enviar
nada a terceros. Los servicios desplegados en Polaris se cuentan desde el
registro del borde sin código; un script pequeño (`/analytics.js`) añade lo que
un registro del servidor no ve, y es la única fuente para los sitios alojados en
otro sitio.

En los ejemplos, `https://polaris.example.com` es la dirección pública de tu
Polaris y `YOUR_KEY` la clave del sitio.

## Inicio rápido

1. En Polaris, abre **Analítica > Sitios web** y añade un sitio:
   - **Desplegado en Polaris** - elige el servicio. Ya se cuenta desde el
     registro del borde; la etiqueta es opcional.
   - **En otro host** - dale un nombre y el dominio en el que se sirve. Solo lo
     cuenta la etiqueta.
2. Copia la etiqueta que muestra el asistente para tu tipo de proyecto. Más
   tarde, la misma etiqueta está en **Ajustes > Rastreador** del sitio, junto a
   **Aceptar latidos del rastreador** y **Nueva clave**.
3. Pégala en el `<head>` de cada página:

```html
<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>
```

4. Abre tu sitio en un navegador. El paso **Comprobar la instalación** se pone
   en verde con la primera visita registrada.

La etiqueta apunta siempre a la dirección pública de Polaris, porque se ejecuta
en el equipo de otra persona. Una dirección solo de la red local no carga nada
fuera de ella.

## Qué se cuenta, con y sin script

| | Registro del borde (sin script) | Script |
| --- | --- | --- |
| Disponible para | Servicios desplegados en Polaris | Cualquier sitio |
| Páginas vistas, referentes, campañas UTM | Sí | Sí |
| Navegador, sistema, dispositivo | Sí (del user agent) | Sí |
| Idioma | No | Sí |
| País | Sí | Sí |
| Duración de la visita | No | Sí |
| Tamaño de pantalla, zona horaria | No | Sí |
| Cambios de ruta en una SPA | No | Sí |
| Eventos propios, ingresos, identify | No | Sí |

El registro del borde descarta los recursos estáticos (`.css`, `.js`, imágenes,
fuentes, `.json`, `.xml` y similares) y las rutas internas (`/_next/`,
`/__nextjs`, `/api/`, `/.well-known/`, `/cdn-cgi/`). Se controla para toda la
instancia con **Contar visitas del registro del borde**.

Las dos fuentes pasan por el mismo registro, así que nunca cuentan distinto. Los
bots reconocidos no se registran salvo que **Contar los bots reconocidos como
visitantes** esté activado.

## Opciones de la etiqueta

Todas son atributos de la etiqueta `<script>`.

| Atributo | Efecto |
| --- | --- |
| `data-key="YOUR_KEY"` | Obligatorio. La clave del sitio. Sin ella el script no hace nada. |
| `data-host="https://..."` | Envía los latidos aquí en vez de al origen del script. |
| `data-auto="false"` | Sin seguimiento automático: ni primera vista, ni cambios de ruta, ni duración. Llama tú a `polaris.view()`. Los eventos por clic siguen funcionando. |
| `data-domains="example.com,www.example.com"` | Solo cuenta visitas cuyo hostname sea exactamente uno de estos (sin distinguir mayúsculas, sin comodines). |
| `data-do-not-track="true"` | Ignora los navegadores que envían Do Not Track. |
| `data-exclude-search="true"` | Quita la query string de cada página. Los parámetros UTM tampoco se leen. |
| `data-outbound="true"` | Registra los clics en enlaces a otros hosts como `outbound-link-click`, con el enlace en `url`. |
| `data-before-send="beforeSend"` | Nombre de una función global que ve cada latido antes de enviarse. |

### `data-before-send`

La función se busca en `window` en cada envío, así que puede definirse después
de la etiqueta. Recibe el latido y lo devuelve (cambiado o no), o un valor falso
para descartarlo. Si lanza un error, el latido se descarta.

```html
<script>
    function beforeSend(beat) {
        if (beat.url.startsWith("/admin")) return null;
        beat.url = beat.url.replace(/\/users\/\d+/, "/users/:id");
        return beat;
    }
</script>
<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY" data-before-send="beforeSend"></script>
```

Un latido tiene `key`, `type` (`view`, `event`, `leave` o `identify`), `url`
(ruta y query), `screen`, `language`, `timezone` y, según el tipo, `referrer`,
`title`, `name`, `props`, `distinctId`, `data` y `durationMs`. Si deja de cumplir
los [límites](#limites-y-validacion), el servidor lo descarta.

## Aplicaciones de una sola página

Con el seguimiento automático, el script envuelve `history.pushState` y
`history.replaceState` y escucha `popstate`, así que React Router, Vue Router, el
router de Next.js y cualquier otro basado en la History API se cuentan sin
código extra. Un cambio que deja la misma URL no cuenta dos veces.

La página anterior se cierra con su duración al cambiar de ruta, al ocultarse la
pestaña o al salir (`pagehide`, enviado con `sendBeacon`). Las vistas de menos
de un segundo no llevan duración.

Para contar páginas a mano, desactiva el seguimiento automático y llama a
`polaris.view()`:

```js
polaris.view();              // la ruta y query actuales
polaris.view("/checkout/2"); // una ruta a tu elección
```

## Eventos propios

```js
polaris.event("signup", { plan: "pro", seats: 3, trial: true });
```

- Nombre: de 1 a 120 caracteres (el script corta los más largos).
- Propiedades: un objeto plano de hasta 20 claves. Las claves tienen de 1 a 60
  caracteres; los valores son textos de hasta 240 caracteres, números finitos o
  booleanos. No se aceptan objetos anidados ni arrays.
- Un latido que incumple estas reglas se descarta entero, no se recorta.

`polaris` existe cuando el script se ha ejecutado. Con `defer`, protege las
llamadas tempranas:

```js
window.polaris?.event("signup");
```

### Eventos desde el HTML

Cualquier elemento con `data-polaris-event` envía un evento al hacer clic en él o
en algo de su interior. Cada atributo `data-polaris-event-<nombre>` se convierte
en una propiedad (texto, hasta 240 caracteres):

```html
<button data-polaris-event="signup" data-polaris-event-plan="pro">Empezar</button>
```

El listener está en la fase de captura, así que un manejador que detiene la
propagación no oculta el clic.

### Ingresos

Un evento con una propiedad numérica `revenue` cuenta como ingreso, agrupado por
su propiedad `currency` (en mayúsculas). Se suma por moneda, nunca se convierte,
así que envía siempre el mismo código de moneda para el mismo dinero.

```js
polaris.event("purchase", { revenue: 19.9, currency: "EUR" });
```

## Identificar al visitante

```js
polaris.identify("user-42", { plan: "pro" });
polaris.identify({ plan: "pro" }); // solo datos, sin id
```

- El id (hasta 100 caracteres) es tu propio nombre para el visitante. Se guarda
  en memoria y viaja con cada latido posterior de esa carga de página, así que
  llama a `identify` en cada carga cuando sepas quién ha iniciado sesión.
- `data` sigue las mismas reglas que las propiedades de un evento y se guarda en
  la visita.
- Identify no inicia una visita. Si llega antes de que se registre la primera
  vista, su `data` se pierde; el id sigue viajando con los latidos siguientes.
- El id es lo que reconoce a un visitante que vuelve más allá del cambio diario
  de sesión, y lo que cuenta el informe **Retorno**.

Envía solo ids que puedas tratar. Mejor un id opaco que un email.

## Excluirte a ti mismo

En un navegador cuyas visitas no deben contar, ejecuta esto en la consola de tu
sitio:

```js
localStorage.setItem("polaris.disabled", "1");
```

`localStorage.removeItem("polaris.disabled")` lo deshace. El script solo lee esta
clave; nunca escribe en el equipo del visitante. Para ignorar una oficina o las
direcciones de tu equipo, usa **Tráfico ignorado**.

## Frameworks

Todas las variantes cargan el mismo script con la misma clave. El asistente las
escribe por ti.

### HTML, React (Vite) y Vue

Pega la etiqueta en el `<head>` de `index.html` (o de cada página en un sitio
estático):

```html
<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>
```

### Next.js

Añádela una vez al layout raíz (`app/layout.tsx`), dentro de `<body>`:

```jsx
import Script from "next/script";

<Script src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY" strategy="afterInteractive" />
```

### Astro

En el layout que usan todas las páginas (`src/layouts/Layout.astro`), dentro de
`<head>`:

```html
<script is:inline defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>
```

### WordPress y otros sitios renderizados en servidor

Imprime la etiqueta en el head. En WordPress, en el `functions.php` del tema o
con un plugin de fragmentos de código:

```php
add_action("wp_head", function () {
    echo '<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>';
});
```

### Google Tag Manager

**Etiquetas > Nueva > HTML personalizado**, con el activador **Todas las
páginas**:

```html
<script>
    (function () {
        var s = document.createElement("script");
        s.defer = true;
        s.src = "https://polaris.example.com/analytics.js";
        s.setAttribute("data-key", "YOUR_KEY");
        document.head.appendChild(s);
    })();
</script>
```

## Content-Security-Policy

Si tu sitio envía una CSP, permite el script y el endpoint al que envía:

```text
script-src 'self' https://polaris.example.com;
connect-src 'self' https://polaris.example.com;
```

Con `data-host`, pon ese origen en `connect-src`. Los latidos se envían con
`fetch` (o `navigator.sendBeacon` al cerrar la página) a
`/api/analytics/collect`, sin credenciales.

## Privacidad

- **Sin cookies ni almacenamiento.** No se escribe nada en el equipo del
  visitante, así que no hay banner de consentimiento que mostrar por esto.
- **Las sesiones son un hash diario.** El id de una visita es un hash SHA-256 de
  una sal, el sitio, la dirección y el user agent. La sal es aleatoria y cambia
  cada día, así que no se puede seguir a un visitante de un día a otro salvo que
  el sitio llame a `identify`. Una visita termina tras 30 minutos sin latidos.
- **El país se resuelve en tu servidor.** Se lee de la cabecera `CF-IPCountry`
  si un proxy la pone; si no, de una copia local de la base "IP to Country Lite"
  de DB-IP (Polaris la descarga y la renueva cada mes; nunca se envía la
  dirección de un visitante para consultarla); y si no, de la zona horaria del
  navegador.
- **Nada va a terceros.** El script y el endpoint son tu Polaris.
- **Retención.** La dirección, las visitas individuales y sus páginas se guardan
  los días de **Guardar detalle de visitas** (180 por defecto, de 1 a 3650) y
  después se borran. Se conservan los totales diarios de los gráficos.

## Tráfico ignorado, exportación y borrado

Por sitio, en **Ajustes**:

- **Tráfico ignorado** - hasta 50 páginas y 50 direcciones cuyas visitas nunca se
  registran, tanto del registro del borde como del script. Una página empieza
  por `/` y coincide exacta, o como prefijo si acaba en `*` (`/admin*`). Una
  dirección es exacta o un rango IPv4 en forma CIDR (`203.0.113.0/24`).
- **Exportar** - cada página y evento del periodo y filtros elegidos, con su
  visita, en CSV: `at, visit, kind, event, path, url, properties, visitor,
  browser, os, device, country, language, screen, channel, referrer, campaign,
  medium`. Hasta 500.000 filas por exportación. Requiere una cuenta con sesión
  iniciada y acceso al sitio; no es una API pública.
- **Borrar datos** - elimina todas las visitas, eventos y totales diarios. Los
  ajustes y los informes guardados se mantienen.

## Límites y validación

El endpoint (`POST /api/analytics/collect`) acepta un latido JSON por petición y
lo comprueba contra un esquema fijo:

| Campo | Regla |
| --- | --- |
| `key` | de 8 a 64 caracteres |
| `type` | `view`, `event`, `leave` o `identify` |
| `url` | hasta 2048 caracteres |
| `referrer` | hasta 2048 caracteres |
| `title` | hasta 120 caracteres |
| `name` | de 1 a 120 caracteres |
| `props`, `data` | planos, hasta 20 claves de 1 a 60 caracteres; valores texto (hasta 240), número finito o booleano |
| `distinctId` | de 1 a 100 caracteres |
| `screen` | `ANCHOxALTO`, de 2 a 5 cifras cada uno |
| `language` | hasta 35 caracteres |
| `timezone` | hasta 64 caracteres |
| `durationMs` | entero, de 0 a 86.400.000 (un día) |

- 120 latidos por minuto y dirección de cliente. Los que pasan se descartan.
- El origen de la página se lee de la cabecera `Origin` o `Referer` de la
  petición, no del contenido.
- La respuesta es siempre un `204` vacío, pase lo que pase: un latido no válido,
  una clave desconocida, una clave con el script desactivado y un latido aceptado
  se ven igual. Un `204` en la pestaña de red solo prueba que la petición llegó a
  Polaris.

## Solución de problemas

| Síntoma | Qué revisar |
| --- | --- |
| Ninguna visita | **Aceptar latidos del rastreador** debe estar activado en el sitio. Mientras está desactivado, el endpoint ignora la clave. |
| Dejó de contar tras **Nueva clave** | La clave anterior deja de funcionar. Pega la etiqueta nueva en todas partes. |
| Nada en algunos dominios | `data-domains` debe listar cada hostname exacto, incluidas las variantes con `www.`. |
| Nada desde tu navegador | `polaris.disabled` está puesto en ese navegador, Do Not Track está activo con `data-do-not-track`, o tu dirección está en **Tráfico ignorado**. |
| Una página nunca aparece | Coincide con una página excluida, o `data-before-send` no devuelve nada para ella. |
| Script bloqueado en la consola | Añade las entradas de CSP de arriba. Los bloqueadores de contenido también pueden bloquear un archivo llamado `analytics.js`; esos visitantes solo se cuentan desde el registro del borde, y solo en servicios desplegados en Polaris. |
| Faltan eventos | El latido incumplió un [límite](#limites-y-validacion) (propiedades anidadas, más de 20 claves, un valor de más de 240 caracteres) y se descartó. |
| Faltan duraciones | `data-auto="false"` no envía latidos de salida; la duración necesita el seguimiento automático. |
| Pocas o ninguna visita tras un proxy | Un proxy delante de Polaris debe pasar la dirección del visitante como primera entrada de `X-Forwarded-For` o como `X-Real-IP`. Sin ninguna, el latido se descarta; con la dirección del proxy, todos los visitantes comparten una sesión y un límite. |
