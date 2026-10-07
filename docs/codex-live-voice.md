# Voz en vivo en Codex

## Arquitectura revisada

La aplicación es Node/Express, con autenticación existente antes de las rutas privadas y archivos estáticos. `src/server.js` conecta los routers de conversaciones, archivos, proyectos, notas, agenda, sala, equipo y los ejecutores de Claude, Codex y Gemini. El frontend usa scripts clásicos y un compositor compartido. `public/codex.js` selecciona conversaciones Codex y recibe eventos SSE. `src/routes/codex.js` conserva metadatos y usa `codex-scanner` para reconstruir el historial desde los rollouts. `CodexRunner` ejecuta o retoma sesiones del CLI; el chat escrito conserva su configuración anterior.

## Integración

El botón Voz en vivo aparece al lado del clip solamente en conversaciones Codex. El audio usa WebRTC directamente con OpenAI; el backend intercambia SDP mediante `/v1/realtime/calls`, sin entregar claves permanentes ni temporales al navegador. Un WebSocket de control del backend ejecuta herramientas y guarda transcripciones. La sesión usa VAD con interrupciones automáticas. Terminar voz apaga primero las pistas del micrófono y el audio local, luego solicita hangup al backend. Cambiar de conversación, salir del panel o cerrar la página también termina la sesión. Un heartbeat cada 20 segundos permite cerrar sesiones abandonadas tras 60 segundos.

La herramienta consultar_codex usa un ejecutor separado con sandbox de solo lectura y aprobación never, sin el bypass del chat escrito. No retoma ni modifica el thread principal. Recibe el contexto reciente de la conversación y lee las instrucciones y memoria del proyecto mediante las herramientas configuradas del CLI. Las consultas pueden tardar más que las respuestas de voz normales. Las modificaciones se solicitan por el chat escrito. Las restricciones del sandbox dependen de que el CLI y la plataforma las soporten: un fallo debe devolver error, nunca reintentar con bypass. Las herramientas MCP configuradas externamente conservan sus propias políticas de autorización; el sandbox local no sustituye dichas políticas.

Las transcripciones se almacenan como voiceMessages en los metadatos existentes de Codex y se muestran junto al historial escrito. El contexto de voz reciente se incorpora al siguiente mensaje escrito. El contexto que se envía a Realtime tiene un límite de 80 mensajes y 48000 caracteres; no representa una copia ilimitada del historial. Las transcripciones del asistente pueden contener texto generado que el usuario haya interrumpido antes de escucharlo completo.

## Activación

1. Configurar OPENAI_API_KEY exclusivamente en el entorno del proceso Node. No usar el token OAuth del CLI como clave API.
2. Opcional: OPENAI_REALTIME_MODEL cambia el modelo. Predeterminado: gpt-realtime-2.1, según la documentación consultada.
3. Reiniciar la aplicación desde otra terminal o el administrador de procesos. El agente que trabaja dentro del chat no debe detener su propio host.
4. Recargar la ventana, abrir una conversación Codex, pulsar Voz en vivo y permitir el micrófono. HTTPS o localhost son necesarios.

La sesión usa la API de OpenAI y su facturación propia. Es una voz de Realtime asociada al contexto Codex, no el mismo proceso/modelo que responde al chat escrito.

## Verificación

Pruebas locales con OpenAI simulado verifican clave solo en backend, contexto, persistencia sin duplicados, rechazo de orígenes ajenos, validación SDP, herramientas en solo lectura, exclusión mutua, heartbeat y hangup. Los tests existentes del ejecutor y scanner y la revisión de sintaxis pasan: 30 pruebas en total. Chromium verificó la visibilidad exclusiva en Codex, el cambio de conversación y la ocultación al abrir Sala, sin errores JavaScript. La validación real de calidad de audio, interrupciones y permisos de micrófono requiere una sesión API y un navegador con micrófono.

Documentación oficial: https://developers.openai.com/api/docs/guides/voice-webrtc y https://developers.openai.com/api/docs/guides/voice-server-controls.
