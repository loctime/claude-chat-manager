<!-- GENERADO desde el mapa de JARVIS (registry.yaml) con `node ~/.claude/jarvis/render.mjs`. No editar a mano: se pisa. Las listas salen del campo `catalogo:` de cada entrada; el resto sale de ~/.claude/jarvis/catalogo-plantilla.md -->
# Catálogo de Diego: qué proyectos y sistemas ya existen

Mapa de lo que hay, para saber ANTES de crear algo si ya lo tenemos. Lo leen los agentes de las cuentas de colaboradores (les llega como `~/.claude/CATALOGO-DIEGO.md`) y sirve igual para cualquiera que use Claude Chat Manager.

Ojo con esto: que algo esté en esta lista NO significa que puedas usarlo desde esta cuenta. Los colaboradores corren en un servidor aparte, sin acceso a las máquinas, cuentas ni claves de Diego. Si algo de acá sirve para lo que se está haciendo, no lo reconstruyas ni lo reemplaces con otra cosa: avisale a Diego (ver el CLAUDE.md) y él decide si lo habilita, lo conecta o lo hace por su lado.

**Cómo se mantiene:** este archivo se genera solo desde el mapa de JARVIS de Diego y el servidor lo reparte a cada cuenta de colaborador en unos minutos. No lo edites: tu copia es de solo lectura y cualquier cambio se pisa. Si falta algo o hay algo mal, avisale a Diego.

## Proyectos y productos

- **VentaMat**: Extensión de Chrome y panel para cargar remitos.
- **ControlDoc v5**: Versión anterior de ControlDoc. Se está retirando: lo vigente es la v6.
- **ControlDoc (v6)**: SaaS de gestión documental multi-empresa: documentos requeridos por operación, estado de habilitación por ficha, biblioteca, tableros y tickets de soporte.
- **ControlRedes**: Contenido para redes (reels y posts) de una cooperativa cliente, más un monitor de cortes de energía.
- **ControlApps Clientes (CRM)**: Base de clientes con unas 250 empresas, agenda y fichas.
- **ControlApp SEO**: Seguimiento del estado de SEO de cada app.
- **Lienzo**: Marketplace de arte original de varios artistas.
- **Regalapp**: App para juntar plata de regalos de cumpleaños en grupo.
- **CercaYa**: Marketplace de servicios locales (app móvil).
- **Pastas del Chiki**: Catálogo con carrito que termina el pedido por WhatsApp.
- **Habaneros Landing**: Landing de un chef privado en Tulum.
- **Herrería Delpo**: Sitio web de una herrería.
- **Festival Compass**: App móvil para ubicar amigos en festivales.
- **Alarma GPS**: App móvil con alarma por proximidad (GPS).
- **ESP32 Cambiar WiFi**: Encender una PC a distancia con un ESP32 y Telegram.
- **OpenMontage** (pausado): Sistema de video con IA.
- **Elmer Systems**: Agentes por cliente sobre paneles web y contenido (en parte pendiente de migrar a Elmer).
- **ferzep**: Sitio estático y robot mensual que lleva documentos a SharePoint (estado a confirmar).
- **ControlGames**: Portal de juegos en la web (Arrowz, Rompecoco, AFK RPG) con ranking, canjes y mercado entre jugadores.
- **ControlRRHH**: SaaS de preselección de candidatos (programa de selección de personal).
- **ControlPDF**: Escaneo de documentos con la cámara (recorte y mejora de imagen en el navegador).
- **ControlMusic**: Estudio de música en el navegador (DAW), con generador de videos que reaccionan al audio.
- **ControlAnim**: Sistema propio para hacer animaciones cortas verticales (9:16) en español, con estilos intercambiables.
- **Gastronomic**: App para negocios gastronómicos (horarios, tareas, stock, pedidos, RRHH). En construcción.
- **ControlAudit v2**: App de auditorías que funciona sin conexión, para varias empresas.
- **Control-Mu**: Servidor privado de Mu Online.
- **multimail**: Bandeja de correo propia que junta Gmail y Zoho. En desarrollo.
- **CEB**: Demo de tableros (Metabase) y propuesta de proyectos para una cooperativa eléctrica.
- **plantillada**: Proyecto en revival: alta de clientes por planillas.

## Bots y agentes (ya hechos)

- **El Orquestador**: Router único de WhatsApp de ControlApps.
- **Elmer**: Asistente de WhatsApp para varios servicios (leads, captación de pedidos).
- **Tron**: Canal de Telegram para avisos automáticos a Diego, y capacidad de redes sociales (Meta).
- **Bunn (documentos por WhatsApp)**: Documentos de ControlDoc por WhatsApp (vencimientos, partes mensuales).
- **GastoToken**: Reporte semanal de gasto de Claude Code a Telegram.
- **Claude Chat Manager (JARVIS)**: La app de chat con la que se está trabajando ahora.
- **ops-bot**: Vigila que los agentes sigan logueados (comando /health por Telegram).
- **Coreo** (pausado): Router anterior de WhatsApp; lo reemplaza Elmer.
- **controlBun (Telegram)**: Bot de Telegram de documentos de ControlDoc: subida de archivos y vencimientos.

## Capacidades: antes de armar algo de esto, consultá

- **Video**: ControlAnim (animación vertical propia), ControlRedes (reels y posts), Hyperframes (HTML a video), ControlMusic (videos con música). Si te piden un video, NO lo armes por tu cuenta con otra herramienta: primero consultá a Diego.
- **Imágenes**: fotos de stock sin atribución (Pexels, Pixabay), generación con IA (Fooocus, ComfyUI, Leonardo), diseño en Canva y Penpot.
- **Voz y sonido**: voz sintética (VoxCPM "Locutor", voces argentinas de Edge TTS, ElevenLabs), efectos de sonido (Freesound, ElevenLabs), transcripción de audio (Whisper vía Groq).
- **Mensajería**: WhatsApp (Elmer / Orquestador / API oficial de Meta), Telegram (bots), email (Zoho, multimail).
- **Hosting e infraestructura**: Vercel (webs y apps Next), un servidor propio (Contabo), Render, Supabase (bases de datos, dos cuentas), Backblaze B2 (archivos), Cloudflare (dominio y túneles), GitHub (repos privados).
- **Modelos de IA**: Claude, Codex, Antigravity/Gemini, Groq, NVIDIA NIM.
- **Documentos**: PDF, Word y Excel (generación y lectura), presentaciones HTML a PDF, escaneo (ControlPDF).
- **Automatización de navegador**: Playwright.
- **SEO**: seguimiento por app (controlapp) y auditorías.
- **Juegos**: ControlGames (motor y portal), servidor de Mu Online.

## Qué hacer según el caso

1. **Es trabajo dentro del proyecto asignado** (una pantalla, un arreglo, un minijuego): hacelo, no hace falta consultar.
2. **Necesitás algo que está en este catálogo** (un video, enviar WhatsApp, guardar archivos, etc.): no lo reconstruyas. Avisale a Diego qué necesitás y esperá su decisión.
3. **Necesitás algo que NO está en este catálogo** (un servicio nuevo, una cuenta, una dependencia que cuesta plata, un sistema nuevo): no lo inventes ni lo contrates. Avisale a Diego qué necesitás y por qué.
4. **Duda de si ya existe**: asumí que sí y consultá. Es más barato preguntar que construir de más.
