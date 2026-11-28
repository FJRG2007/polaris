# Requisitos de hardware

Lo que necesita una máquina para ejecutar Polaris, y cuánto más dejar libre
para lo que ejecutes en ella.

Las cifras de Polaris se midieron en una instalación en marcha (16 núcleos, 32
GB de RAM, Ubuntu Server) el 2026-11-28, en reposo y con pocas personas
conectadas. Los tamaños mínimo y recomendado salen de esas cifras: no se ha
probado ninguna instalación por debajo del mínimo.

## Polaris por sí solo

| Parte                                   | Memoria en uso | Imagen  |
| --------------------------------------- | -------------- | ------- |
| Panel (web, API, tareas en segundo plano) | 1,3-2,6 GB   | 425 MB  |
| Base de datos (PostgreSQL)              | ~360 MB        | 110 MB  |
| Llamadas (LiveKit)                      | ~70 MB         | 39 MB   |
| Proxy inverso (Traefik)                 | ~50 MB         | 52 MB   |
| Guardia del borde (cortafuegos)         | ~45 MB         | 61 MB   |
| Demonio del host                        | ~17 MB         | 80 MB   |
| Nombre en la red local (mDNS)           | ~13 MB         | 61 MB   |
| **Total**                               | **~2-3,2 GB**  | **~0,8 GB** |

- El panel es casi todo, y la mayor parte de su cifra es margen que reserva el
  motor de JavaScript, no memoria que necesite: se estabiliza en 1,3-1,6 GB a los
  veinte minutos de arrancar y se ha visto en hasta 2,8 GB en diez horas. Ese
  margen depende de la memoria de la máquina, así que en una más pequeña usa
  menos.
- La base de datos y los archivos del panel crecen con el uso. En la instalación
  medida ocupaban 1,4 GB y 1,3 GB tras varios meses.

## Lo que ejecutes encima

Todo esto se suma a la cifra de Polaris.

| Qué                                   | Memoria                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| Sesión de Polar Code / agente         | Hasta 4 GB y 2 núcleos cada una por defecto (ajustable en Ajustes), hasta 12 a la vez |
| Servidor de Minecraft u otro juego    | 2-16 GB cada uno, según sus mods y jugadores (la tarjeta Memoria de sus ajustes) |
| Apps desplegadas y del marketplace    | Lo que use cada una; la mayoría de apps web pequeñas necesitan decenas de MB |
| Compilaciones de apps desplegadas     | Varios GB de disco de caché, y un pico de CPU y memoria mientras compila |

## Ejemplo: un servidor de casa con servidores de juego

Suma lo que funciona a la vez, no lo que está instalado. Un servidor de juego en
Java usa su heap más algo propio: medido, un servidor Paper con 1,5 GB de heap
ocupaba 1,8 GB, y uno con mods y 4 GB ocupaba 3,6 GB con su mundo cargado.
Cuenta unas 1,2 veces el heap para ir sobrado.

| Funcionando a la vez                                  | Memoria  |
| ----------------------------------------------------- | -------- |
| Polaris                                               | ~3 GB    |
| Cuatro servidores de Minecraft con 1,5, 2,5, 4 y 8 GB de heap | ~19 GB |
| Una docena de apps pequeñas desplegadas y del marketplace | ~0,5 GB |
| Una sesión de agente                                  | hasta 4 GB |
| **Total**                                             | **~27 GB** |

Cabe en 32 GB, con poco margen para la caché de archivos del sistema. Los
servidores que duermen hasta que alguien entra solo cuentan mientras están
despiertos; una segunda sesión de agente, o todos los servidores despiertos a
la vez con una compilación en marcha, es donde una máquina de 32 GB se queda
corta.

## Tamaños

| Máquina     | Memoria  | CPU         | Disco              | Para |
| ----------- | -------- | ----------- | ------------------ | ---- |
| Mínimo      | 4 GB     | 2 núcleos   | 20 GB libres       | Polaris y sus apps para una casa o un equipo pequeño, pocos despliegues ligeros |
| Recomendado | 8 GB     | 4 núcleos   | 50 GB libres       | Lo anterior más despliegues y compilaciones habituales, llamadas, una sesión de agente a la vez |
| Holgado     | 16-32 GB | 8+ núcleos  | 100 GB+ libres, SSD | Varias sesiones de agente o servidores de juego a la vez, muchas apps desplegadas |

- Un SSD importa más que el número de núcleos: la base de datos y la descarga de
  imágenes dependen del disco.
- Deja al menos una cuarta parte de la memoria libre para la caché de archivos
  del sistema; las imágenes de Docker, las compilaciones y la base de datos se
  apoyan en ella.
- Lo primero que se llena con el tiempo es el disco: imágenes, caché de
  compilación y volúmenes de las apps desplegadas. La pantalla de almacenamiento
  de Polaris muestra lo que ocupa cada uno y qué se puede borrar sin riesgo.

## Sistema operativo

Linux, con Ubuntu Server como objetivo probado, y Docker Engine con el plugin
Compose v2. En el [README](../README.md#requirements) se explica por qué no se
recomienda Windows como host.
