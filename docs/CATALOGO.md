# Catálogo de Diego: qué proyectos y sistemas ya existen

Mapa de lo que hay, para saber ANTES de crear algo si ya lo tenemos. Lo leen los agentes de las cuentas de colaboradores (les llega como `~/.claude/CATALOGO-DIEGO.md`) y sirve igual para cualquiera que use Claude Chat Manager.

Ojo con esto: que algo esté en esta lista NO significa que puedas usarlo desde esta cuenta. Los colaboradores corren en un servidor aparte, sin acceso a las máquinas, cuentas ni claves de Diego. Si algo de acá sirve para lo que se está haciendo, no lo reconstruyas ni lo reemplaces con otra cosa: avisale a Diego (ver el CLAUDE.md) y él decide si lo habilita, lo conecta o lo hace por su lado.

**Cómo se mantiene:** este archivo vive en el repo (`docs/CATALOGO.md`). Se edita ahí, se commitea y se pushea; el servidor lo reparte solo a cada cuenta de colaborador en unos minutos. Los agentes de colaboradores no lo editan: su copia es de solo lectura. Nunca poner acá cuentas, claves, IPs, PINs ni datos personales.

## Proyectos y productos

- **ControlDoc (v6)**: SaaS de gestión documental multi-empresa (documentos requeridos por operación, estado de habilitación por ficha, biblioteca, tableros, tickets de soporte). La v5 anterior se está retirando.
- **ControlRRHH**: SaaS de preselección de candidatos (programa de selección de personal).
- **ControlGames**: portal de juegos en la web (Arrowz, Rompecoco, AFK RPG) con ranking, canjes y mercado entre jugadores.
- **ControlPDF**: escaneo de documentos con la cámara (recorte y mejora de imagen en el navegador).
- **ControlMusic**: estudio de música en el navegador (DAW), con generador de videos que reaccionan al audio.
- **ControlAnim**: sistema propio para hacer animaciones cortas verticales (9:16) en español, con estilos intercambiables.
- **ControlRedes**: contenido para redes (reels y posts) de una cooperativa cliente, más un monitor de cortes de energía.
- **Gastronomic**: app para negocios gastronómicos (horarios, tareas, stock, pedidos, RRHH). En construcción.
- **controlauditv2**: app de auditorías que funciona sin conexión, para varias empresas.
- **VentaMat**: extensión de Chrome y panel para cargar remitos.
- **ControlApps Clientes (CRM)**: base de clientes con unas 250 empresas, agenda y fichas.
- **controlapp**: seguimiento del estado de SEO de cada app.
- **Lienzo**: marketplace de arte original de varios artistas.
- **Regalapp**: app para juntar plata de regalos de cumpleaños en grupo.
- **CercaYa**: marketplace de servicios locales (app móvil).
- **Pastas del Chiki**: catálogo con carrito que termina el pedido por WhatsApp.
- **Landings**: Habaneros (chef privado en Tulum), Herrería Delpo.
- **Apps móviles chicas**: Festival Compass (ubicar amigos en festivales), Alarma GPS (alarma por proximidad).
- **ESP32 Cambiar WiFi**: encender una PC a distancia con un ESP32 y Telegram.
- **Control-Mu**: servidor privado de Mu Online.
- **multimail**: bandeja de correo propia que junta Gmail y Zoho. En desarrollo.
- **CEB**: demo de tableros (Metabase) y propuesta de proyectos para una cooperativa eléctrica.
- **ferzep**: robot mensual que lleva documentos a SharePoint, más soporte por WhatsApp y mail.
- **plantillada**: proyecto en revival, alta de clientes por planillas.
- **OpenMontage**: sistema de video con IA. Pausado.
- **Claude Chat Manager (JARVIS)**: la app de chat con la que se está trabajando ahora.

## Bots y agentes (ya hechos)

- **Elmer**: asistente de WhatsApp para varios servicios (leads, captación de pedidos).
- **Elmer Systems**: agentes por cliente sobre paneles web y contenido (en parte pendiente de migrar a Elmer).
- **El Orquestador**: router único de WhatsApp de ControlApps.
- **Coreo**: router anterior de WhatsApp. Congelado: lo reemplaza Elmer.
- **Tron**: canal de Telegram para avisos automáticos a Diego.
- **Bunn / controlBun**: documentos de ControlDoc por WhatsApp y Telegram (vencimientos, partes mensuales).
- **ops-bot**: vigila que los agentes sigan logueados (comando /health por Telegram).
- **GastoToken**: reporte semanal de gasto de Claude Code a Telegram.

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
3. **Necesitás algo que NO está en este catálogo** (un servicio nuevo, una cuenta, una dependencia que cuesta plata, un sistema nuevo): no lo inventes ni lo contrates. Avisale a Diego qué necesitás y por qué. Si lo aprueba, él lo suma acá.
4. **Duda de si ya existe**: asumí que sí y consultá. Es más barato preguntar que construir de más.
