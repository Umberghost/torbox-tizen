# TorBox para Android TV (APK)

App mínima (Java, WebView, minSdk 21 / targetSdk 34) que aparece en el launcher de Android TV y abre a
pantalla completa la web de TorBox servida por tu Cloudflare Worker (`https://<worker>.workers.dev/app/`).
El user agent incluye `TorBoxAndroidTV`.

## 1. Descargar el APK
1. En GitHub: pestaña **Actions** → workflow **Android TV APK** (se ejecuta solo al cambiar `android-tv/**`
   en `master`, o con **Run workflow**).
2. Abre la última ejecución correcta → sección **Artifacts** → descarga `torbox-tv-debug-apk` (zip con el
   `.apk`; el de *release* sale sin firmar y no se puede instalar tal cual).

## 2. Instalar en Android TV
- **Downloader** (app de la Play Store de la tele): sube el `.apk` a un enlace de descarga directa
  (Drive/Dropbox/tu servidor) y ábrelo en Downloader; permite "orígenes desconocidos" para Downloader cuando lo pida.
- **adb**: Ajustes → Preferencias del dispositivo → Acerca de → pulsa 7 veces en "Compilación"; activa
  *Depuración USB/de red*. Luego:
  ```
  adb connect IP-DE-LA-TELE:5555
  adb install -r app-debug.apk
  ```
- Aparecerá "TorBox" en el launcher (banner 320x180).

## 3. Configurar la URL del Worker
- Primera ejecución: escribe la URL (`https://torbox.tu-subdominio.workers.dev/`; si pones solo el dominio se
  añade `/app/`) y pulsa Guardar. Se guarda en SharedPreferences.
- Para cambiarla: **mantén pulsado MENU** en el mando (si no tiene, borra los datos de la app en Ajustes).

## Mando
- Flechas/OK llegan tal cual (keyCodes 37-40/13). **Atrás** envía Escape (27) a la web; si la web no lo gestiona
  (ni `preventDefault` ni cambio de URL), pulsa Atrás dos veces en 2 s para salir.
- Play/Pausa → 10252, Stop → 413, Rebobinar → 412, Avance rápido → 417, Siguiente/Anterior → 10233/10232,
  botones de color → 403-406.

## Compilar en local
No incluye `gradlew`; con Android SDK y Gradle 8.7 + JDK 17: `gradle assembleDebug` dentro de `android-tv/`
(o abrir la carpeta en Android Studio, que genera el wrapper).
