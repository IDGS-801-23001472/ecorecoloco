# EcoReco

Aplicación Flutter con API Express y MySQL para gestionar la recolección de residuos.

## Perfiles de operación

- **Vendedor** registra clientes y contratos, programa visitas individuales o recurrentes y organiza las paradas por ruta, chofer y turno. Un borrador solo aparece al chofer después de publicar sus paradas.
- **Cliente** consulta sus visitas, confirma, cancela o cambia la fecha conservando la hora del contrato. Puede consultar contratos, saldos, manifiestos y avisos.
- **Administración** gestiona usuarios, roles y catálogos, consulta la agenda, supervisa ventas e incidencias, revisa cortes y consulta la bitácora del día.

## Módulo de chofer y cobrador

El perfil `cobrador` (rol 3) consulta sus rutas por jornada, abre la ubicación de las paradas, registra llegada y captura residuos, pesos y observaciones. Una visita fallida requiere fotografía y motivo. Una visita completada requiere firma y genera una venta y un manifiesto digital. Se puede buscar el manifiesto por folio o fecha y registrar su entrega como un evento separado. El chofer y el cliente autorizado pueden compartir una copia en PDF desde la app.

Los pagos pueden cubrir todo el saldo, una parte o dejar el adeudo abierto. Un adeudo se abona sobre su venta original desde una parada del mismo cliente asignada al chofer para la jornada actual. El corte por turno consolida pagos y viáticos. Administración (rol 1) puede consultar y revisar los cortes.

## Puesta en marcha

1. En una base **nueva de desarrollo**, importa `eco_reco.sql`. Ese archivo elimina y vuelve a crear `eco_reco`. Para una base existente, empieza en el siguiente paso.
2. Selecciona la base correspondiente y ejecuta una vez cada migración en orden, `backend/migrations/001_chofer.sql` y `backend/migrations/002_operacion.sql`. Si ya probaste el perfil de chofer, aplica únicamente la segunda. Configura `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` y, si aplica, `PORT` en `backend/.env`.
3. Desde `backend`, ejecuta `npm ci` y `npm start`.
4. Desde la raíz, ejecuta `flutter pub get` y `flutter devices`. Para un teléfono Android conectado por USB, usa el identificador del dispositivo en ambos comandos. Si CMD no reconoce `adb`, usa la ruta completa de `platform-tools\adb.exe` dentro de tu Android SDK.

   ```cmd
   adb -s ID_ANDROID reverse tcp:3000 tcp:3000
   flutter run -d ID_ANDROID --dart-define=API_BASE_URL=http://127.0.0.1:3000/api
   ```

Para probar con datos iniciales, importa también `backend/demo/chofer.sql` en la base de desarrollo. Inicia sesión como `cobrador1` con contraseña `12345`. El script añade tres paradas para la jornada actual. La cuenta `admin_chofer_demo` usa la misma contraseña y permite revisar el corte desde Flutter.

Para probar la operación completa, entra como `vendedor1` y crea un contrato con el cliente de ejemplo, una fecha de inicio vigente y una hora dentro del turno. En **Calendario y rutas**, genera las visitas o programa una manualmente. Selecciona las paradas en el orden de visita, elige ruta, chofer y turno, y activa **Publicar para el chofer**. Puedes confirmar una visita desde `cliente1` y luego abrirla desde `cobrador1`. Las cuentas iniciales usan `12345`.

Para generar visitas desde un contrato previo, completa su horario y selecciona una frecuencia semanal, quincenal o mensual. Si ya cargaste las paradas de demostración para el mismo chofer, día y turno, utiliza su ruta o programa la prueba en otra fecha.

## Integración con programación y contratos

- La API lee `recolecciones.fk_chofer` como referencia a `choferes.pk_chofer`. La parada requiere cliente, ruta, turno, fecha y estado activo (`1`). `orden_parada` es opcional y ordena las paradas de cada ruta. El estado operativo del chofer se guarda en `servicios_chofer`.
- La API interpreta `contratos.monto` como cuota **por visita**, suma el excedente nuevo del mes de servicio si hay cuota de kilos y aplica el `iva_porcentaje` configurado. Configura ese campo explícitamente, incluso si corresponde cero. Con cuota de kilos, configura `tarifa_excedente` antes de cerrar visitas que excedan la cuota. Se usa el peso en kg de visitas completadas por este módulo. Una visita fallida solo genera una venta cuando el contrato especifica `cargo_visita_fallida`.
- La jornada se interpreta en `America/Mexico_City`. El corte descuenta los viáticos del efectivo y considera efectivo el método de pago de catálogo llamado `Efectivo`.
- El módulo usa `/api/v1/chofer` y el token de `POST /api/auth/login`. El cierre de sesión usa `POST /api/auth/logout`. Los tokens vencen tras ocho horas y se guardan en memoria del proceso. Al iniciar sesión por primera vez con una contraseña legada en Base64, se migra su almacenamiento a scrypt.
- Fotos y firmas se almacenan en MySQL y se sirven mediante rutas autenticadas. La firma confirma el servicio y su importe. La recepción de dinero queda registrada en los pagos.

## Operación del servidor

La generación automática es opcional. Configura `GENERACION_USUARIO_ID` con el ID de una cuenta administrativa o de logística activa y `GENERACION_HORIZONTE_DIAS` entre 1 y 91. El backend genera las visitas al arrancar y repite la tarea cada hora. Las visitas se registran una sola vez por contrato y fecha original.

Usa `GET /api/health` para verificar el proceso y `GET /api/ready` para verificar MySQL y la migración de operación. En producción, publica la API detrás de HTTPS, configura monitoreo de ambas rutas y programa respaldos de MySQL con un usuario de mínimo privilegio. Comprueba la restauración en una base separada. La cámara, galería y firma deben validarse en el dispositivo físico usado por el equipo.

El panel de reportes muestra solicitudes, errores del servidor, latencia media y última generación desde el arranque. Para respaldos en Windows, guarda la conexión de respaldo con `mysql_config_editor` bajo el nombre `ecoreco-backup` y ejecuta `backend/scripts/backup.ps1 -Directory RUTA_PRIVADA`. Puedes agendar ese mismo comando en el Programador de tareas. Restringe el acceso a esa carpeta porque el respaldo contiene los datos y evidencias de la operación.

## Pruebas

Ejecuta `node --test backend/test/chofer-domain.test.js` para verificar los cálculos y `flutter test` para comprobar el arranque de la app.
