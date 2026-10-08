# Asistente virtual · Serna-Rincón Abogados

Chat informativo que usa la API de Gemini de Google. La clave nunca llega al navegador: el widget habla con `/api/chat`, una función serverless de Vercel, y solo esa función llama a Gemini.

```
serna-rincon-web/
├── public/                    ← lo que Vercel publica como sitio
│   ├── index.html             (landing; al final carga el widget de forma diferida)
│   └── chatbot/
│       ├── chatbot.css        (estilos con los tokens del brandbook)
│       └── chatbot.js         (widget)
├── chatbot/
│   └── system-prompt.md       ← instrucción de sistema (NO es pública)
├── api/chat.js                ← endpoint serverless (validación, límites, streaming)
├── dev-server.mjs             (servidor local para pruebas; Vercel no lo usa)
├── scripts/probar-chat.mjs    (pruebas automáticas)
├── vercel.json  package.json  .env.example  .gitignore
```

---

## 1. Obtener la clave en Google AI Studio

1. Entre a https://aistudio.google.com con una cuenta de Google de la firma.
2. En el menú, abra **Get API key** y luego **Create API key**. Elija o cree un proyecto de Google Cloud.
3. Copie la clave. Trátela como una contraseña: no la envíe por chat ni por correo y no la pegue en ningún archivo distinto de `.env`.

> **Importante para una firma de abogados.** En el nivel gratuito de la API, Google puede usar los mensajes para mejorar sus productos. En el nivel de pago (con facturación activa en el proyecto) no los usa con ese fin. Se recomienda **activar la facturación** antes de publicar el asistente y revisar los términos vigentes en https://ai.google.dev/gemini-api/terms.

Para controlar costos, conviene fijar un presupuesto con alertas en Google Cloud (Facturación → Presupuestos y alertas).

## 2. Variables de entorno

| Variable | Obligatoria | Valor |
|---|---|---|
| `GEMINI_API_KEY` | Sí | La clave de AI Studio. |
| `GEMINI_MODEL` | No | Modelo de Gemini. Por defecto `gemini-3.8-flash`, el Flash estable vigente a octubre de 2026. Para reducir costos puede usar `gemini-3.5-flash-lite`. Consulte https://ai.google.dev/gemini-api/docs/models antes de cambiarlo. |
| `ALLOWED_ORIGINS` | En producción | Dominios autorizados a usar el chat, separados por comas, con protocolo y sin barra final. Ejemplo: `https://www.[COMPLETAR].com,https://[COMPLETAR].com`. **Si se deja vacía, solo funciona en `localhost`**, que es la configuración actual. |

Límites fijos en `api/chat.js` (se pueden ajustar al inicio del archivo):

| Límite | Valor |
|---|---|
| Caracteres por mensaje | 1.000 |
| Turnos enviados al modelo por petición | 10 |
| Mensajes por conversación | 20 en el widget (24 en el servidor, para cubrir reintentos) |
| Peticiones por IP | 8 por minuto y 60 por hora |
| Tokens de salida | 700 como máximo |
| Tiempo de espera | 20 s |

El rate limiting se guarda en la memoria de cada instancia serverless. Es un freno básico, no una barrera absoluta. Si algún día hay abuso, la mejora natural es moverlo a Upstash Redis (`@upstash/ratelimit`).

## 3. Probar en local

Requisito: Node.js 20 o superior (este equipo tiene la versión 24).

```bash
npm install
```

Copie `.env.example` como `.env` y pegue la clave en `GEMINI_API_KEY=` con un editor de texto. Luego ejecute:

```bash
npm run dev
```

Abra http://localhost:3000. El botón del asistente aparece en la esquina inferior derecha unos segundos después de cargar la página, y el de WhatsApp sube para dejarle espacio.

**Sin terminal:** haga doble clic en `Abrir sitio con chat.bat`. Enciende el servidor en segundo plano y abre http://localhost:3000 con el asistente funcionando. Para apagarlo, use `Detener sitio con chat.bat`.

Para correr las pruebas automáticas con el servidor encendido, ejecute este comando en otra terminal:

```bash
npm run probar
```

El `.bat` del Escritorio («Abrir sitio web.bat») usa un servidor Python que no ejecuta la función de chat. Para probar el asistente use `npm run dev`.

### Versión en un solo archivo HTML

```bash
npm run archivo-unico
```

Genera dos archivos en la carpeta del proyecto, que se abren con doble clic:

- `Serna-Rincon-Abogados.html`: la landing sin asistente.
- `Serna-Rincon-Abogados-con-chat.html`: la landing con el asistente. El chat responde **solo mientras `npm run dev` esté encendido en el mismo equipo**, porque la clave nunca va dentro del HTML. Si el servidor está apagado, el chat muestra un error genérico y el botón «Reintentar».

Vuelva a ejecutar `npm run archivo-unico` cada vez que cambie algo en `public/`. Estos archivos sirven para revisar la página en local; para publicar, use Vercel (punto 4).

## 4. Configurar la clave en Vercel y publicar

1. Cree una cuenta en https://vercel.com. **El plan gratuito (Hobby) es solo para uso no comercial**; el sitio de una firma requiere el plan Pro.
2. Publique la carpeta `serna-rincon-web` de una de estas dos formas:
   - **Con GitHub (recomendado):** suba la carpeta a un repositorio privado. `.gitignore` ya excluye `.env` y `node_modules`. En Vercel elija **Add New → Project** e importe el repositorio. Framework Preset: **Other**. No cambie Build ni Output: `vercel.json` ya indica que el sitio está en `public/`.
   - **Sin GitHub:** ejecute `npx vercel` dentro de la carpeta y siga las preguntas.
3. En el proyecto de Vercel abra **Settings → Environment Variables** y cree `GEMINI_API_KEY`, `GEMINI_MODEL` y `ALLOWED_ORIGINS` (esta última con el dominio definitivo). Márquelas al menos para **Production**.
4. Vuelva a desplegar (**Deployments → … → Redeploy**). Las variables solo se aplican a los despliegues nuevos.
5. Si conecta un dominio propio, añádalo a `ALLOWED_ORIGINS` y vuelva a desplegar. Mientras el dominio no esté en esa lista, el chat responderá con un error genérico, por diseño.

`chatbot/system-prompt.md` queda fuera de `public/`, así que no se publica; `vercel.json` lo incluye solo dentro de la función.

## 5. Editar la instrucción de sistema

Abra `chatbot/system-prompt.md` con cualquier editor de texto.

- **Sección «INFORMACIÓN DE LA FIRMA»:** son los únicos datos que el asistente conoce. Reemplace cada `[COMPLETAR]` por el dato real. Si lo deja, el asistente dirá que no tiene ese dato y remitirá a los canales de contacto.
- **Secciones de rol, límites y urgencias:** se pueden ajustar, pero conviene no eliminar las prohibiciones (asesoría sobre casos, datos sensibles, invención de datos, cambio de rol).
- El comentario inicial `<!-- … -->` no se envía al modelo.

Después de editar, reinicie `npm run dev` en local o vuelva a desplegar en Vercel.

Otros textos del widget (bienvenida, preguntas sugeridas, enlace a la política de datos) están al inicio de `public/chatbot/chatbot.js`, en la sección «Configuración».

## 6. Privacidad

- El historial vive solo en la memoria del navegador y se borra al recargar o al pulsar «Borrar conversación». No hay base de datos.
- El servidor no registra el contenido de los mensajes. Los logs solo muestran el tipo de error y su código HTTP.
- Los mensajes sí viajan a Google para generar la respuesta (ver la nota del punto 1).
- La Política de tratamiento de datos personales está en `public/politica-de-tratamiento-de-datos.html` (borrador con campos [COMPLETAR]). El widget la enlaza mediante la constante `PRIVACY_URL` de `chatbot.js`.
