# Spotify Dedupe Guard

Aplicación local para encontrar y retirar canciones repetidas de **Tus me gusta** sin confundir grabaciones originales con lives, remixes, remasters, acústicos o covers.

## Qué hace

- Descarga la biblioteca completa mediante la API oficial de Spotify.
- Marca como **seguro** el mismo ISRC, artista, versión y duración compatible; también reconoce metadatos visibles idénticos con hasta dos segundos de diferencia aunque una reedición tenga otro ISRC.
- Separa coincidencias por nombre en **probables** y **versiones** para revisión manual.
- Recomienda conservar la edición de álbum frente a recopilaciones como `Greatest Hits`, pero permite elegir cualquier copia del grupo.
- Ofrece crear una playlist privada de respaldo antes de retirar canciones; está activada de forma predeterminada, pero puede omitirse con advertencia explícita.
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
3. De forma predeterminada solo quedan seleccionadas las copias seguras. Los controles **Seguros**, **Probables** y **Versiones** activan o desactivan todas las copias de cada categoría; también puedes cambiar cuál conservar en cada grupo.
4. Pulsa **Retirar duplicados** y confirma. Decide si quieres crear la playlist de respaldo antes de modificar Tus me gusta.
5. Usa **Deshacer** en el historial si quieres restaurarlos.

## Qué significa ISRC

El **International Standard Recording Code** identifica una grabación concreta, no la composición musical. La misma grabación suele conservar su ISRC cuando aparece en otro álbum, mientras que un live, remix o nueva grabación normalmente recibe otro. Algunas reediciones de catálogo pueden tener códigos distintos aunque sus metadatos y audio sean prácticamente idénticos; por eso el detector combina ISRC con título, artistas, álbum, versión y duración.

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
