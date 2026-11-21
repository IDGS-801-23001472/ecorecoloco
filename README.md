# EcoReco

Aplicación Flutter con API Express y MongoDB Atlas para gestionar la recolección de residuos.

## Perfiles de operación

- **Operaciones (rol 2)** registra clientes y contratos, programa visitas individuales o recurrentes y organiza las paradas por ruta, chofer y turno. Un borrador solo aparece al chofer después de publicar sus paradas.
- **Cliente** consulta sus visitas, confirma, cancela o cambia la fecha conservando la hora del contrato. Puede consultar contratos, saldos, manifiestos y avisos.
- **Administración** gestiona usuarios, roles y catálogos, consulta la agenda, supervisa ventas e incidencias, revisa cortes y consulta la bitácora del día.

## Módulo de chofer y cobrador

El perfil `cobrador` (rol 3) consulta sus rutas por jornada, abre la ubicación de las paradas, registra llegada y captura residuos, pesos y observaciones. Una visita fallida requiere fotografía y motivo. Una visita completada requiere firma y genera una venta y un manifiesto digital. Se puede buscar el manifiesto por folio o fecha y registrar su entrega como un evento separado. El chofer y el cliente autorizado pueden compartir una copia en PDF desde la app.

Los pagos pueden cubrir todo el saldo, una parte o dejar el adeudo abierto. Un adeudo se abona sobre su venta original desde una parada del mismo cliente asignada al chofer para la jornada actual. El corte por turno consolida pagos y viáticos. Administración (rol 1) puede consultar y revisar los cortes.

## Puesta en marcha

1. Copia `backend/.env.example` a `backend/.env`. Configura `MONGODB_URI` con la conexión de Atlas, `MONGODB_DB` (por defecto `ecoreco`) y las variables `ADMIN_*` de la cuenta inicial. Conserva las credenciales en ese archivo local.
2. Desde `backend`, ejecuta `npm ci`, `npm run db:init` y `npm start`. La inicialización crea las colecciones, índices, roles, turnos, métodos de pago y la cuenta administradora.
3. Comprueba `GET /api/health` y `GET /api/ready` en el puerto configurado (3000 por defecto).
4. Desde la raíz, ejecuta `flutter pub get` y `flutter devices`. Para un teléfono Android conectado por USB, usa el identificador del dispositivo en ambos comandos. Si CMD no reconoce `adb`, usa la ruta completa de `platform-tools\adb.exe` dentro de tu Android SDK.

   ```cmd
   adb -s ID_ANDROID reverse tcp:3000 tcp:3000
   flutter run -d ID_ANDROID --dart-define=API_BASE_URL=http://127.0.0.1:3000/api
   ```

Para probar la operación completa, inicia sesión con la cuenta administradora inicial y crea las cuentas de operación, chofer y cliente, junto con sus datos y catálogos asociados. Registra un contrato vigente con una hora dentro del turno. En **Calendario y rutas**, genera las visitas o programa una manualmente. Selecciona las paradas en orden, asígnalas a ruta, chofer y turno, y activa **Publicar para el chofer**. Puedes confirmar la visita desde la cuenta cliente y luego abrirla desde la cuenta chofer.

## Integración con programación y contratos

- Las recolecciones guardan sus referencias a clientes, rutas, choferes y turnos como ObjectId. La API serializa esos identificadores como cadenas.
- La API interpreta `contratos.monto` como cuota **por visita**, suma el excedente nuevo del mes de servicio si hay cuota de kilos y aplica el `iva_porcentaje` configurado. Configura ese campo explícitamente, incluso si corresponde cero. Con cuota de kilos, configura `tarifa_excedente` antes de cerrar visitas que excedan la cuota. Se usa el peso en kg de visitas completadas por este módulo. Una visita fallida solo genera una venta cuando el contrato especifica `cargo_visita_fallida`.
- La jornada se interpreta en `America/Mexico_City`. El corte descuenta los viáticos del efectivo y considera efectivo el método de pago de catálogo llamado `Efectivo`.
- El módulo usa `/api/v1/chofer` y el token de `POST /api/auth/login`. El cierre de sesión usa `POST /api/auth/logout`. Los tokens vencen tras ocho horas y se guardan como hashes en la colección de sesiones. Las contraseñas se verifican con scrypt.
- Fotos y firmas se almacenan en MongoDB y se sirven mediante rutas autenticadas. La firma confirma el servicio y su importe. La recepción de dinero queda registrada en los pagos.

## Operación del servidor

La generación automática es opcional. Configura `GENERACION_USUARIO_ID` con el ID de una cuenta administrativa o de logística activa y `GENERACION_HORIZONTE_DIAS` entre 1 y 91. El backend genera las visitas al arrancar y repite la tarea cada hora. Las visitas se registran una sola vez por contrato y fecha original.

Usa `GET /api/health` para verificar el proceso y `GET /api/ready` para verificar la conectividad con MongoDB. En producción, publica la API detrás de HTTPS, configura monitoreo de ambas rutas y configura los respaldos del clúster de Atlas. Comprueba la restauración en una base separada. La cámara, galería y firma deben validarse en el dispositivo físico usado por el equipo.

El panel de reportes muestra solicitudes, errores del servidor, latencia media y última generación desde el arranque.

## Pruebas

Ejecuta `node --test backend/test/chofer-domain.test.js` para verificar los cálculos y `flutter test` para comprobar el arranque de la app.
