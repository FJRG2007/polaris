# Cuando un antivirus bloquea Polaris

[Read in English](antivirus.md) - [Volver al README](../README.es.md)

Algunos antivirus detienen la app de escritorio de Polaris, sus actualizaciones o la página
de tu Polaris en el navegador. Lo habitual es que pase con versiones de la app de escritorio
sin firma de código: el antivirus aún no conoce el archivo y lo trata como sospechoso. Añade
una exclusión solo para lo que aparece aquí, y solo para una copia de Polaris descargada de tu
propio Polaris o de sus versiones oficiales.

## Señales de que es el antivirus

- La app de escritorio no se abre, o se cierra nada más abrirse.
- Una actualización se descarga y la app sigue en la versión anterior.
- El antivirus muestra un aviso o tiene un archivo de Polaris en cuarentena.

## Qué excluir

| Qué | Dónde (Windows) | Por qué |
|---|---|---|
| La carpeta de la app de escritorio | `%LOCALAPPDATA%\polaris` | Contiene `polaris.exe`, el actualizador y una carpeta `app-<versión>` por versión, así que excluir la carpeta cubre también las actualizaciones. |
| La dirección de tu Polaris | la dirección con la que abres Polaris, por ejemplo `polaris.example.com` | Solo si la protección web del antivirus bloquea la página en el navegador. |

Para copiar la carpeta, escribe `%LOCALAPPDATA%\polaris` en la barra de direcciones del
Explorador de archivos, pulsa Intro y copia la ruta completa que se abre.

Si el antivirus ya puso en cuarentena un archivo de Polaris, restáuralo primero desde la
cuarentena y marca la opción de no volver a detectarlo, si el antivirus la ofrece.

## Cómo hacerlo en cada antivirus

Los menús cambian entre versiones y su nombre puede variar un poco con el idioma. Si un paso
no coincide con tu pantalla, sigue la página del fabricante que aparece bajo cada uno. La
mayoría piden permisos de administrador para cambiar las exclusiones.

### Microsoft Defender (Seguridad de Windows)

1. Abre **Seguridad de Windows** y elige **Protección antivirus y contra amenazas**.
2. En **Configuración de antivirus y protección contra amenazas**, elige **Administrar la configuración**.
3. En **Exclusiones**, elige **Agregar o quitar exclusiones**.
4. Elige **Agregar una exclusión** > **Carpeta**.
5. Selecciona `%LOCALAPPDATA%\polaris`.

[Pasos de Microsoft](https://support.microsoft.com/es-es/windows/add-an-exclusion-to-windows-security-811816c0-4dfd-af4a-47e4-c301afe13b26)

### Malwarebytes

1. Abre Malwarebytes y elige **Historial de detecciones** (Detection History).
2. Abre la pestaña **Lista de permitidos** (Allow List) y elige **Añadir** (Add).
3. Elige **Permitir un archivo o carpeta** (Allow a file or folder).
4. Selecciona `%LOCALAPPDATA%\polaris`.

Para permitir la dirección de tu Polaris, elige **Permitir un sitio web** (Allow a website) en
el paso 3.

[Pasos de Malwarebytes](https://help.malwarebytes.com/hc/en-us/articles/31589453538075-Add-or-remove-items-from-Malwarebytes-Allow-list)

### Avast y AVG

1. Abre el antivirus y ve a **Menú** > **Configuración**.
2. Elige **General** > **Excepciones** y luego **Añadir excepción**.
3. Elige **Siguiente** y luego **Entiendo los riesgos**.
4. Abre la pestaña **Archivo/Carpeta**.
5. Elige el icono de carpeta, selecciona `%LOCALAPPDATA%\polaris` y pulsa **Aceptar**.
6. Elige **Añadir**.

[Pasos de Avast](https://support.avast.com/en-us/article/antivirus-scan-exclusions) - [Pasos de AVG](https://support.avg.com/SupportArticleView?l=en&urlname=AVG-Antivirus-scan-exclusions)

### Norton

1. Abre Norton y elige **Seguridad** a la izquierda.
2. En el recuadro **Análisis**, elige **Abrir**.
3. Abre la pestaña **Exclusiones** y elige **Añadir exclusión**.
4. Elige el icono de examinar, selecciona `%LOCALAPPDATA%\polaris` y pulsa **Aceptar**.
5. Elige **Añadir**.

[Pasos de Norton](https://support.norton.com/sp/en/ca/home/current/solutions/v3672136)

### Kaspersky

1. Abre Kaspersky y elige el botón de ajustes (engranaje) en la parte inferior de la ventana principal.
2. Ve a **Configuración de seguridad** > **Amenazas y exclusiones**.
3. Elige **Administrar exclusiones** y luego **Añadir**.
4. Elige **Examinar**, selecciona `%LOCALAPPDATA%\polaris` y pulsa **Seleccionar**.
5. Deja el estado en **Activa** y elige **Añadir**.

[Pasos de Kaspersky](https://support.kaspersky.com/help/Kaspersky/Win21.5/en-US/227390.htm)

### Bitdefender

1. Abre Bitdefender y elige **Protección**.
2. En el panel **Antivirus**, elige **Abrir**.
3. Abre la pestaña **Ajustes** y elige **Administrar excepciones**.
4. Elige **Añadir una excepción**.
5. Escribe `%LOCALAPPDATA%\polaris`, o elige la lupa para seleccionarla.
6. Activa el interruptor junto a **Antivirus** y elige **Guardar**.

[Pasos de Bitdefender](https://www.bitdefender.com/consumer/support/answer/13427/)

### ESET

1. Abre ESET y pulsa **F5** para abrir la **Configuración avanzada**.
2. Ve a **Análisis** y elige **Editar** junto a **Exclusiones de rendimiento**.
3. Elige **Agregar** y luego los tres puntos junto a **Ruta**.
4. Selecciona `%LOCALAPPDATA%\polaris` y pulsa **Seleccionar carpeta**.
5. Pulsa **Aceptar** hasta cerrar todas las ventanas.

[Pasos de ESET](https://support.eset.com/en/kb2769-exclude-files-or-folders-from-scanning-in-eset-windows-home-products)

### Otros

Para McAfee, mira los [pasos de McAfee](https://www.mcafee.com/support/s/article/000001661?language=en_US).
En cualquier otro antivirus, busca **Exclusiones**, **Excepciones** o **Lista de permitidos**
en sus ajustes y añade `%LOCALAPPDATA%\polaris` como carpeta.

## Si sigue sin abrirse

Quita la exclusión si no ha servido, para que el antivirus siga revisando esa carpeta. Después
mira [Qué comprobar](troubleshooting.es.md) cuando una pantalla dice que no se puede acceder a
Polaris.
