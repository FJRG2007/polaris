# Agentes

[Read in English](agents.md) - [Volver al README](../../README.es.md)

Agentes de programación en tus repositorios. Una ejecución revisa pull
requests, responde issues, arregla checks fallidos y abre pull requests cuando
se lo pides. Una sesión pone un agente en su propia rama, en una máquina que ya
tienes, donde lo ves trabajar, respondes a sus preguntas y le envías lo
siguiente.

Agentes está en **Apps > Agentes**, con Repositorios, Ejecuciones, Sesiones,
Automatizaciones y Ajustes.

## Antes de la primera ejecución

La **preparación** lista las tres cosas que tienen que cumplirse:

1. **Una GitHub App.** Permite que el agente comente, revise y abra pull
   requests con su propia identidad, y que Polaris se entere de issues y pull
   requests. Un token de acceso personal no puede hacer ninguna de las dos
   cosas. Un administrador la crea con un clic en **Gestión > Integraciones e
   IA > Integraciones** (consulta
   [Configurar integraciones](../integrations-setup.es.md#github)).
2. **Un proveedor de modelos.** Tu propia clave de Anthropic, OpenAI, Google,
   xAI, DeepSeek, Moonshot, Groq, Cerebras u OpenRouter, o una pasarela
   compatible con OpenAI, añadida en **Claves de IA**. La clave se queda en
   Polaris y nunca se copia a tus repositorios.
3. **Un repositorio**, y dónde ocurren sus ejecuciones.

Después abre una issue en uno de tus repositorios y menciona la app para
probarlo.

## Repositorios y dónde ocurren las ejecuciones

Añade un repositorio y elige dónde ocurren sus ejecuciones. Polaris recomienda
la opción más barata que encaje; la elección es tuya.

| Opción | Qué significa |
| --- | --- |
| GitHub Actions | Una máquina alojada por GitHub. Gratis en repositorios públicos, se factura por minuto en los privados |
| Runners de Polaris | Uno de tus servidores inscritos, a través de un grupo de runners (Apps > Runners). Un repositorio privado sigue gastando minutos de Actions |
| Servidor Polaris | Un contenedor en la máquina de Polaris, sin GitHub Actions. No se mide nada y no hace falta archivo de workflow |

Cada repositorio decide además qué puede hacer el agente:

- **Push**: solo lectura, solo ramas de trabajo (lo predeterminado en un
  repositorio nuevo: sin push a la rama principal, sin borrar ramas, sin tags)
  o acceso total.
- **Shell**: sin shell, shell sin secretos en su entorno o shell completo.
- **Gate**: hacer push en cuanto termina, pasar comprobaciones rápidas antes del
  push o añadir pasadas de revisión, pruebas y documentación.

## Ejecuciones y automatizaciones

Un repositorio sin reglas solo responde cuando alguien menciona la app en una
issue, una pull request o un comentario. **Automatizaciones** añade reglas que
inician una ejecución por sí solas: una issue abierta o etiquetada, una pull
request abierta, una revisión pedida o enviada, o un check fallido. Una regla
puede limitarse a etiquetas y ramas, y lleva tus propias instrucciones para el
agente.

**Ejecutar** desde Polaris con un prompt que escribes tú. **Ejecuciones** lista
cada ejecución, qué la inició, dónde se ejecutó y cómo terminó, con un enlace al
job y un botón para detenerla. Una tarea se puede pasar a un agente desde su
panel.

## Sesiones

**Iniciar una sesión** y elegir:

- en qué trabaja, y un repositorio, o ninguno para un espacio de trabajo vacío
  y tuyo;
- el agente: Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot CLI,
  Cursor CLI, Amp, Goose, Aider, Droid, Qwen Code, Crush, Cline, OpenHands,
  OpenClaw, o uno propio ya instalado en la máquina;
- **dónde se ejecuta**: esta máquina de Polaris o uno de tus servidores
  inscritos;
- la rama de partida y, si quieres, un primer prompt;
- **Dejar que trabaje sin preguntar**, para que no espere a sus propias
  peticiones de permiso.

La página de la sesión muestra la conversación y la actividad del agente.
**Ver su pantalla** muestra su terminal, **Tomar el terminal** te deja escribir
en él e **Interrumpir** detiene lo que está haciendo. **Cambios** muestra el
diff frente al punto de partida de la rama. **Abrir una pull request** sube la
rama y abre una, haciendo commit de lo que falte. Si un push falla, el trabajo
se conserva para reintentarlo o descartarlo. Cuando una sesión termina, su rama
sigue ahí. Las sesiones se pueden compartir con otras personas.

Un agente inicia sesión con una cuenta de **Claves de IA > Tus cuentas de
agente**: una suscripción no cuesta nada extra, una clave API se mide. Una
máquina conserva su carpeta personal entre sesiones, así que las instalaciones
y los inicios de sesión ocurren una sola vez.

## Ajustes

**Ajustes** guarda lo que heredan tus repositorios: defínelo una vez, acótalo
por cuenta y sobrescríbelo en los repositorios que necesiten algo distinto.
Incluye si se permiten repositorios públicos y privados y a qué modelos recurre
una ejecución, en orden, cuando un proveedor la rechaza.

Un asistente que conectes puede listar sesiones, iniciarlas y enviarles prompts
si apruebas esos permisos. Consulta
[Conectar asistentes de IA](../connecting-ai-assistants.es.md).
