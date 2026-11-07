# Cuando un antivirus bloquea Polaris

[Read in English](antivirus.md) - [Volver al README](../../README.es.md)

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

Cada fabricante mantiene sus propios pasos al día; los menús cambian entre versiones, así que
sigue la página del fabricante para la versión que tengas.

| Antivirus | Dónde está el ajuste | Pasos oficiales |
|---|---|---|
| Microsoft Defender (Seguridad de Windows) | Configuración de Protección antivirus y contra amenazas > Agregar o quitar exclusiones > Agregar una exclusión > Carpeta | [Microsoft](https://support.microsoft.com/es-es/windows/add-an-exclusion-to-windows-security-811816c0-4dfd-af4a-47e4-c301afe13b26) |
| Malwarebytes | Historial de detecciones > Lista de permitidos > Añadir, y luego la carpeta (o un sitio web) | [Malwarebytes](https://help.malwarebytes.com/hc/en-us/articles/31589453538075-Add-or-remove-items-from-Malwarebytes-Allow-list) |
| Avast | Menú > Configuración > General > Excepciones | [Avast](https://support.avast.com/en-us/article/Antivirus-scan-exclusions) |
| AVG | en la página del fabricante | [AVG](https://support.avg.com/SupportArticleView?l=en&urlname=AVG-Antivirus-scan-exclusions) |
| Bitdefender | en la página del fabricante | [Bitdefender](https://www.bitdefender.com/consumer/support/answer/13427/) |
| ESET | en la página del fabricante | [ESET](https://support.eset.com/en/kb2769-exclude-files-or-folders-from-scanning-in-eset-windows-home-products) |
| Kaspersky | en la página del fabricante | [Kaspersky](https://support.kaspersky.com/13971) |
| McAfee | en la página del fabricante | [McAfee](https://www.mcafee.com/support/s/article/000001661?language=en_US) |
| Norton | en la página del fabricante | [Norton](https://support.norton.com/sp/en/ca/home/current/solutions/v3672136) |

Los nombres de los menús pueden variar un poco según la versión y el idioma del antivirus. La
mayoría piden permisos de administrador para cambiar las exclusiones.

## Si sigue sin abrirse

Quita la exclusión si no ha servido, para que el antivirus siga revisando esa carpeta. Después
mira [Qué comprobar](troubleshooting.es.md) cuando una pantalla dice que no se puede acceder a
Polaris.
