# TorBox para TizenBrew

Módulo tipo *app* para ver tu biblioteca de TorBox (torrents, usenet y descargas web) en una Samsung con Tizen, a través de TizenBrew. Navegación pensada para el mando.

## Qué hace la v1
- Pide tu **API key** de TorBox la primera vez (se guarda en la TV, en `localStorage`).
- Lista tus descargas **terminadas** de la fuente activa.
- `◄ ►` cambia de fuente (Torrents / Usenet / Web), `▲ ▼` navega, **OK** reproduce, **Atrás** vuelve.
- Si una descarga tiene varios archivos, entras a elegir archivo.
- Reproduce con el `<video>` HTML5 del navegador de la TV.

## Instalar

**Opción A — servidor local (para probar y editar):**
1. En la carpeta del módulo: `npx http-server . --cors -c-1 -p 8080`
2. En TizenBrew → Module Manager → añade la fuente `http://IP-DE-TU-PC:8080/`
3. Instala "TorBox" desde la lista.

**Opción B — publicar en npm (permanente):**
1. `npm publish` (con tu cuenta).
2. En TizenBrew → Module Manager → instalar por NPM con el nombre del paquete.

Recuerda tener **modo desarrollador** activo en la TV y la IP del Host PC apuntando a tu máquina (o `127.0.0.1` según el método de instalación de TizenBrew).

## Tu API key
torbox.app → Ajustes → sección API → copia la key. Es tu credencial personal; el módulo solo la usa para hablar con `api.torbox.app`.

## Límites conocidos de la v1 (lo que podemos mejorar)
- **Formatos:** el `<video>` HTML5 reproduce bien MP4/WebM/M4V. Los **MKV** pueden fallar según el modelo. La vía robusta es usar el reproductor nativo de Tizen (**AVPlay**), que sí traga MKV/HEVC — es el siguiente paso natural.
- **CORS:** el navegador de TizenBrew suele permitir el `fetch` directo a la API. Si tu TV lo bloquea, la solución es añadir un `serviceFile` (servicio Node en la propia TV) que haga de proxy. Lo tengo previsto como plan B.
- **Sin buscador:** la v1 solo muestra lo que ya tienes en tu cuenta. Se puede añadir la Search API de TorBox para buscar y añadir desde la tele.
- **Sin carátulas ni episodios:** lista plana por nombre. Se puede enriquecer con metadatos (pósters, orden de temporadas).

## Estructura
```
torbox-tizen/
├── package.json      # tipo "app", appPath y teclas de medios
├── app/
│   └── index.html    # UI + lógica + reproductor (autocontenido)
└── README.md
```
