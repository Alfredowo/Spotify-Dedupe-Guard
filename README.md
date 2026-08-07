# Spotify Dedupe Guard

Aplicación local para encontrar y retirar canciones repetidas de **Tus me gusta** sin confundir grabaciones originales con lives, remixes, remasters, acústicos o covers.

## Qué hace

- Descarga la biblioteca completa mediante la API oficial de Spotify.
- Marca como **seguro** únicamente el mismo ISRC, artista principal y una diferencia máxima de cinco segundos.
- Separa coincidencias por nombre en **probables** y **versiones** para revisión manual.
- Recomienda conservar la edición de álbum frente a recopilaciones como `Greatest Hits`.
- Crea una playlist privada de respaldo antes de retirar cualquier canción.
- Guarda un historial local y permite deshacer una limpieza.
- Cifra el token de Spotify con Windows DPAPI; no solicita un Client Secret.

## Configuración inicial

Spotify exige que el propietario de una app nueva en modo de desarrollo tenga Premium.

1. Abre [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e inicia sesión con la cuenta que administrará la biblioteca.
2. Crea una aplicación.
3. En **Redirect URIs**, agrega exactamente:

   ```text
   http://127.0.0.1:8765/callback
   ```

   Spotify no admite `localhost`; debe ser `127.0.0.1`.

4. Guarda la configuración y copia el **Client ID**.
5. Ejecuta [run_spotify_dedupe.bat](run_spotify_dedupe.bat).
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
3. De forma predeterminada solo quedan seleccionados los duplicados seguros.
4. Pulsa **Retirar duplicados** y confirma. La playlist de respaldo se crea antes de modificar Tus me gusta.
5. Usa **Deshacer** en el historial si quieres restaurarlos.

## Ejecución desde terminal

```powershell
python app.py
```

La aplicación queda disponible únicamente en `http://127.0.0.1:8765`.

## Pruebas

```powershell
python -m unittest discover -s tests -v
```

## Datos locales

La carpeta `data/` se crea automáticamente:

- `config.json`: Client ID público.
- `spotify_token.bin`: token cifrado para el usuario actual de Windows.
- `dedupe.sqlite3`: auditorías e historial.

Estos archivos están excluidos de Git.
