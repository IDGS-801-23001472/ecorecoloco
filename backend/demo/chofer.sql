-- Solo para una base de desarrollo inicializada con eco_reco.sql y 001_chofer.sql.
SET @jornada = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '-06:00'));
SET @cliente = (SELECT pk_cliente FROM clientes WHERE correo = 'erickcl@gmail.com' ORDER BY pk_cliente LIMIT 1);
SET @chofer = (SELECT ch.pk_chofer FROM choferes ch JOIN usuarios u ON u.pk_usuario = ch.fk_usuario
  WHERE u.usuario = 'cobrador1' AND ch.estado = 1 ORDER BY ch.pk_chofer LIMIT 1);
SET @turno = (SELECT pk_turno FROM turnos WHERE nombre = 'Matutino' ORDER BY pk_turno LIMIT 1);

START TRANSACTION;

INSERT INTO rutas (nombre, descripcion, fecha_creacion)
SELECT 'Ruta demo chofer', 'Prueba del módulo de chofer', NOW()
WHERE @cliente IS NOT NULL AND @chofer IS NOT NULL AND @turno IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM rutas WHERE nombre = 'Ruta demo chofer');

INSERT INTO contratos (fk_cliente, folio, fecha_inicio, fecha_fin, monto, kilos_mensuales, tarifa_excedente, iva_porcentaje)
SELECT @cliente, 'CHOFER-DEMO', @jornada, DATE_ADD(@jornada, INTERVAL 1 YEAR), 100.00, 10.00, 20.00, 16.00
WHERE @cliente IS NOT NULL AND @chofer IS NOT NULL AND @turno IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM contratos WHERE folio = 'CHOFER-DEMO');

SET @ruta = (SELECT pk_ruta FROM rutas WHERE nombre = 'Ruta demo chofer' ORDER BY pk_ruta LIMIT 1);
SET @contrato = (SELECT pk_contrato FROM contratos WHERE folio = 'CHOFER-DEMO' AND fk_cliente = @cliente
  ORDER BY pk_contrato LIMIT 1);

INSERT INTO recolecciones
  (fk_cliente, fk_contrato, fk_ruta, fk_chofer, fk_turno, folio, fecha_recoleccion, orden_parada)
SELECT @cliente, @contrato, @ruta, @chofer, @turno,
  CONCAT('CHOFER-DEMO-', DATE_FORMAT(@jornada, '%Y%m%d'), '-', visita.orden),
  TIMESTAMP(@jornada, visita.hora), visita.orden
FROM (
  SELECT 1 orden, '09:00:00' hora UNION ALL
  SELECT 2, '10:00:00' UNION ALL SELECT 3, '11:00:00'
) visita
WHERE @contrato IS NOT NULL AND @ruta IS NOT NULL AND @chofer IS NOT NULL AND @turno IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM recolecciones r WHERE r.folio = CONCAT('CHOFER-DEMO-', DATE_FORMAT(@jornada, '%Y%m%d'), '-', visita.orden)
  );

-- Usuario de prueba para revisar el corte. Usa una cuenta real en otros entornos.
INSERT INTO usuarios (fk_rol, usuario, nombre, pass, fecha_creacion)
SELECT 1, 'admin_chofer_demo', 'Administración demo', 'MTIzNDU=', NOW()
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE usuario = 'admin_chofer_demo');

COMMIT;
