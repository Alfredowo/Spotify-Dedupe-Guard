# Spotify Dedupe Guard

Aplicación local para encontrar y retirar canciones repetidas de **Tus me gusta** sin confundir grabaciones originales con lives, remixes, remasters, acústicos o covers.

## Qué hace

- Descarga la biblioteca completa mediante la API oficial de Spotify.
- Marca como **seguro** el mismo ISRC, artista, versión y duración compatible; también reconoce metadatos visibles idénticos con hasta dos segundos de diferencia aunque una reedición tenga otro ISRC.
- Separa coincidencias por nombre en **probables** y **versiones** para revisión manual.
- Detecta extensiones y sufijos de título no catalogados mediante similitud estructural, sin retirarlos automáticamente.
- Recomienda conservar la edición de álbum frente a recopilaciones como `Greatest Hits`, pero permite elegir cualquier copia del grupo.
- Ofrece crear una playlist privada de respaldo antes de retirar canciones; está activada de forma predeterminada, pero puede omitirse con advertencia explícita.
- Guarda el token, los análisis y el historial en IndexedDB del navegador, tanto en ejecución local como en Vercel. Ninguna versión solicita un Client Secret ni persiste datos de usuario en el servidor.

## Configuración inicial

Spotify exige que el propietario de una app nueva en modo de desarrollo tenga Premium.

1. Abre [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e inicia sesión con la cuenta que administrará la biblioteca.
2. Crea una aplicación.
3. En **Redirect URIs**, agrega exactamente:

   ```text
   http://127.0.0.1:8765/
   https://TU-DOMINIO-VERCEL/
   ```

   Registra ambas direcciones exactas. Spotify no admite `localhost` para la dirección local; usa `127.0.0.1`.

4. Guarda la configuración y copia el **Client ID**.
5. Ejecuta [run_spotify_dedupe.bat](run_spotify_dedupe.bat) o `python static_server.py`.
6. Pega el Client ID en la pantalla y pulsa **Conectar con Spotify**.

Los permisos solicitados son:

- `user-library-read`: leer Tus me gusta.
- `user-library-modify`: retirar y restaurar canciones.
- `playlist-modify-private`: crear respaldos privados.

## Uso seguro

1. Pulsa **Analizar biblioteca**. Esta operación es solo lectura.
2. Revisa las categorías:
   - **Seguros**: mismo ISRC, artista y duración compatible.
   - **Probables**: metadatos prácticamente iguales, pero sin ISRC compartido.
   - **Versiones**: hay diferencias de edición o duración.
3. De forma predeterminada solo quedan seleccionadas las copias seguras. Los controles **Seguros**, **Probables** y **Versiones** activan o desactivan todas las copias de cada categoría; también puedes cambiar cuál conservar en cada grupo.
4. Pulsa **Retirar duplicados** y confirma. Decide si quieres crear la playlist de respaldo antes de modificar Tus me gusta.
5. Después de cada limpieza, los resultados muestran los duplicados que siguen pendientes y quedan desmarcados.
6. Usa **Deshacer** en el historial si quieres restaurar las canciones; si la auditoría correspondiente sigue abierta, también reaparecerán en sus resultados.

## Qué significa ISRC

El **International Standard Recording Code** identifica una grabación concreta, no la composición musical. La misma grabación suele conservar su ISRC cuando aparece en otro álbum, mientras que un live, remix o nueva grabación normalmente recibe otro. Algunas reediciones de catálogo pueden tener códigos distintos aunque sus metadatos y audio sean prácticamente idénticos; por eso el detector combina ISRC con título, artistas, álbum, versión y duración.

## Ejecución desde terminal

```powershell
python static_server.py
```

El servidor local solo publica los archivos de `static/` y sirve `index.html` desde la raíz. La app queda disponible en `http://127.0.0.1:8765/`; el servidor no ofrece API ni guarda sesiones o datos de usuario.

## Pruebas

```powershell
node --test tests/browser_client.test.mjs tests/dedupe_engine.test.mjs
python -m unittest discover -s tests -v
```

## Datos del navegador

En los dos despliegues, el Client ID, el token de Spotify, los análisis y el historial se guardan en IndexedDB del navegador. La sesión y esos datos son propios de cada perfil de navegador y cada origen: `127.0.0.1` y el dominio de Vercel tienen almacenes separados. Al borrar los datos del sitio se eliminan también la sesión, los análisis y el historial. Los archivos heredados que ya existan en `data/` no se usan, migran ni eliminan automáticamente.

## Despliegue estático en Vercel

Vercel publica la misma aplicación estática que se usa en local: usa OAuth PKCE y llama a Spotify directamente desde el navegador. No requiere PostgreSQL, funciones de servidor ni variables de entorno.

1. En Vercel, usa la raíz del repositorio como **Root Directory**. `vercel.json` publica `static/` y la app abre desde `/`.
2. En **Redirect URIs** de Spotify Developer Dashboard agrega la URL HTTPS raíz asignada al proyecto; por ejemplo, `https://spotify-dedupe-guard.vercel.app/`.
3. Vuelve a desplegar, abre el dominio del proyecto, pega el Client ID y conecta Spotify.

La URL no tiene contraseña de acceso: cada persona puede abrir la interfaz y autorizar su propia cuenta de Spotify desde su perfil de navegador. Los datos no se comparten con el servidor; la playlist de respaldo se guarda en Spotify.
