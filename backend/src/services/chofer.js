const db = require('../config/db');
const { RequestError, amount, decimal, id, text, image, key, calculate } = require('./chofer-domain');

const zone = 'America/Mexico_City';
const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: zone });
const localClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: zone, dateStyle: 'short', timeStyle: 'medium'
});

const today = () => localDate.format(new Date());
const now = () => localClock.format(new Date());

async function audit(conn, user, resource, resourceId, action) {
  await conn.execute(
    'INSERT INTO bitacora_operacion (fk_usuario, recurso, recurso_id, accion, fecha) VALUES (?, ?, ?, ?, ?)',
    [user, resource, resourceId, action, now()]
  );
}

async function transaction(userId, work) {
  const conn = await db.getConnection();
  try {
    for (let attempt = 1; ; attempt++) {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      try {
        await conn.execute('SELECT pk_usuario FROM usuarios WHERE pk_usuario = ? FOR UPDATE', [userId]);
        const result = await work(conn);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        if (error.code !== 'ER_LOCK_DEADLOCK' || attempt >= 3) throw error;
      }
    }
  } finally {
    conn.release();
  }
}

const stopFields = `r.pk_recoleccion, r.folio, r.fk_cliente, r.fk_contrato, r.fk_turno, r.fk_ruta,
  DATE_FORMAT(r.fecha_recoleccion, '%Y-%m-%dT%H:%i:%s') fecha,
  r.observaciones, r.orden_parada, c.nombre cliente, c.direccion, c.telefono,
  ru.nombre ruta, t.nombre turno, COALESCE(s.estado, 'pendiente') estado,
  s.fk_venta, s.fk_manifiesto, s.motivo, s.insumos,
  DATE_FORMAT(s.llegada, '%Y-%m-%dT%H:%i:%s') llegada,
  DATE_FORMAT(s.cierre, '%Y-%m-%dT%H:%i:%s') cierre, (s.foto IS NOT NULL) tiene_foto,
  (s.firma IS NOT NULL) tiene_firma`;
const stopJoins = `FROM recolecciones r
  JOIN choferes ch ON ch.pk_chofer = r.fk_chofer AND ch.estado = 1
  JOIN clientes c ON c.pk_cliente = r.fk_cliente
  JOIN rutas ru ON ru.pk_ruta = r.fk_ruta
  JOIN turnos t ON t.pk_turno = r.fk_turno
  LEFT JOIN servicios_chofer s ON s.fk_recoleccion = r.pk_recoleccion`;

async function getStop(conn, user, stopId, lock = false) {
  const [[stop]] = await conn.execute(
    `SELECT ${stopFields} ${stopJoins}
     WHERE r.pk_recoleccion = ? AND ch.fk_usuario = ? AND (r.estado = 1 OR s.estado IS NOT NULL)
       AND (r.publicada = 1 OR s.estado IS NOT NULL)
     ${lock ? 'FOR UPDATE OF r' : ''}`, [stopId, user]
  );
  if (!stop) throw new RequestError('Parada no encontrada.', 404);
  return stop;
}

async function list(user, day) {
  const [stops] = await db.execute(
    `SELECT ${stopFields} ${stopJoins}
     WHERE ch.fk_usuario = ? AND (r.estado = 1 OR s.estado IS NOT NULL)
       AND (r.publicada = 1 OR s.estado IS NOT NULL)
       AND r.fecha_recoleccion >= ? AND r.fecha_recoleccion < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY t.hora_inicio, r.fk_ruta, r.orden_parada IS NULL, r.orden_parada,
       r.fecha_recoleccion, r.pk_recoleccion`, [user, day, day]
  );
  return { fecha: day, paradas: stops };
}

async function detail(user, stopId) {
  const stop = await getStop(db, user, stopId);
  const [[policy]] = await db.execute(
    'SELECT cargo_visita_fallida, iva_porcentaje FROM contratos WHERE pk_contrato = ? AND fk_cliente = ?',
    [stop.fk_contrato, stop.fk_cliente]
  );
  const [residuos] = await db.execute(
    `SELECT d.nombre, rd.cantidad, rd.peso, rd.observaciones FROM recolecciones_detalle rd
     JOIN desechos d ON d.pk_desecho = rd.fk_desecho
     WHERE rd.fk_recoleccion = ? AND rd.estado = 1 ORDER BY rd.pk_recoleccion_detalle`, [stopId]);
  const [ventas] = await db.execute(
    `SELECT v.pk_venta, v.fk_recoleccion, v.folio, v.subtotal, v.iva, v.total,
       v.total - COALESCE((SELECT SUM(p.importe) FROM pagos_chofer p WHERE p.fk_venta = v.pk_venta), 0) saldo
     FROM ventas v JOIN servicios_chofer s ON s.fk_venta = v.pk_venta
     WHERE v.fk_cliente = ? AND v.estado = 1 AND (v.fk_recoleccion = ? OR v.total >
       COALESCE((SELECT SUM(p.importe) FROM pagos_chofer p WHERE p.fk_venta = v.pk_venta), 0))
     ORDER BY v.fecha_venta, v.pk_venta`, [stop.fk_cliente, stopId]);
  const [conceptos] = await db.execute(
    'SELECT concepto, cantidad, precio_unitario, subtotal FROM ventas_detalle WHERE fk_venta = ? AND estado = 1',
    [stop.fk_venta]
  );
  const [pagos] = await db.execute(
    `SELECT p.importe, m.nombre metodo, DATE_FORMAT(p.fecha, '%Y-%m-%dT%H:%i:%s') fecha
     FROM pagos_chofer p JOIN metodos_pago m ON m.pk_metodo_pago = p.fk_metodo_pago
     WHERE p.fk_venta = ? ORDER BY p.pk_pago`, [stop.fk_venta]
  );
  const fee = absenceQuote(policy);
  return { ...stop, es_hoy: stop.fecha.slice(0, 10) === today(), residuos, ventas, conceptos, pagos,
    cargo_ausencia: fee ? amount(fee.total) : null };
}

async function start(user, stopId) {
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    if (stop.estado !== 'pendiente') return { estado: stop.estado };
    if (stop.fecha.slice(0, 10) !== today()) {
      throw new RequestError('Solo puedes iniciar paradas de la jornada actual.', 409);
    }
    await conn.execute(
      'INSERT INTO servicios_chofer (fk_recoleccion, fk_usuario, estado, llegada) VALUES (?, ?, ?, ?)',
      [stopId, user, 'en_curso', now()]
    );
    await audit(conn, user, 'recolecciones', stopId, 'registrar_llegada');
    return { estado: 'en_curso' };
  });
}

function requireStarted(stop) {
  if (stop.estado !== 'en_curso') throw new RequestError('Primero inicia la parada.', 409);
}

async function fail(user, stopId, body) {
  const reason = text(body.motivo, 'Motivo', 255);
  const photo = image(body.foto, 'Foto');
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    if (stop.estado === 'fallida') return { estado: stop.estado };
    requireStarted(stop);
    const [[policy]] = await conn.execute(
      `SELECT cargo_visita_fallida, iva_porcentaje FROM contratos
       WHERE pk_contrato = ? AND fk_cliente = ?
         AND (fecha_inicio IS NULL OR fecha_inicio <= ?) AND (fecha_fin IS NULL OR fecha_fin >= ?) FOR UPDATE`,
      [stop.fk_contrato, stop.fk_cliente, stop.fecha.slice(0, 10), stop.fecha.slice(0, 10)]
    );
    const fee = absenceQuote(policy);
    const timestamp = now();
    let saleId = null;
    if (fee) {
      const [[existing]] = await conn.execute(
        'SELECT 1 FROM ventas WHERE fk_recoleccion = ? AND estado = 1 LIMIT 1', [stopId]
      );
      if (existing) throw new RequestError('La parada ya tiene una venta. Solicita una revisión.', 409);
      saleId = await saveSale(conn, user, stop, fee, reason, timestamp);
      await conn.execute('UPDATE recolecciones SET total = ? WHERE pk_recoleccion = ?', [amount(fee.total), stopId]);
    }
    await conn.execute(
      `UPDATE servicios_chofer SET estado = 'fallida', motivo = ?, foto = ?, cierre = ?, fk_usuario = ?,
       fk_venta = ? WHERE fk_recoleccion = ?`, [reason, photo, timestamp, user, saleId, stopId]
    );
    await audit(conn, user, 'recolecciones', stopId, 'registrar_ausencia');
    return { estado: 'fallida' };
  });
}

async function serviceData(conn, stop, input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    throw new RequestError('Captura entre 1 y 50 tipos de residuos.');
  }
  const items = input.map(item => ({
    wasteId: id(item?.fk_desecho),
    quantity: decimal(item?.cantidad, 'Cantidad'),
    weight: decimal(item?.peso, 'Peso'),
    notes: text(item?.observaciones, 'Observaciones del residuo', 255, false)
  }));
  const wasteIds = [...new Set(items.map(item => item.wasteId))];
  if (wasteIds.length !== items.length) throw new RequestError('Agrupa los residuos del mismo tipo.');
  const [catalog] = await conn.query(
    'SELECT pk_desecho, unidad_medida, nombre FROM desechos WHERE estado = 1 AND pk_desecho IN (?)',
    [wasteIds]
  );
  if (catalog.length !== wasteIds.length) throw new RequestError('Un residuo ya no está disponible.');
  const [[contract]] = await conn.execute(
    `SELECT monto, kilos_mensuales, tarifa_excedente, iva_porcentaje FROM contratos
     WHERE pk_contrato = ? AND fk_cliente = ?
       AND (fecha_inicio IS NULL OR fecha_inicio <= ?) AND (fecha_fin IS NULL OR fecha_fin >= ?)
     FOR UPDATE`, [stop.fk_contrato, stop.fk_cliente, stop.fecha.slice(0, 10), stop.fecha.slice(0, 10)]
  );
  if (!contract) throw new RequestError('La parada requiere un contrato del cliente vigente en la fecha del servicio.', 409);
  const month = stop.fecha.slice(0, 7) + '-01';
  const [[usage]] = await conn.execute(
    `SELECT COALESCE(SUM(d.peso), 0) kilos FROM recolecciones r
     JOIN servicios_chofer s ON s.fk_recoleccion = r.pk_recoleccion AND s.estado = 'completada'
     JOIN recolecciones_detalle d ON d.fk_recoleccion = r.pk_recoleccion AND d.estado = 1
     WHERE r.fk_contrato = ? AND r.fecha_recoleccion >= ? AND r.fecha_recoleccion < DATE_ADD(?, INTERVAL 1 MONTH)`,
    [stop.fk_contrato, month, month]
  );
  const kg = items.reduce((sum, item) => sum + item.weight, 0n);
  return {
    items: items.map(item => ({ ...item, waste: catalog.find(w => w.pk_desecho === item.wasteId) })),
    quote: calculate(contract, decimal(usage.kilos, 'Kilos del mes', true), kg)
  };
}

function quoteResponse(quote) {
  return {
    subtotal: amount(quote.subtotal), iva: amount(quote.iva), total: amount(quote.total),
    conceptos: quote.lines.map(line => ({ concepto: line.concept, subtotal: amount(line.total) }))
  };
}

function absenceQuote(policy) {
  if (!policy?.cargo_visita_fallida || Number(policy.cargo_visita_fallida) === 0) return null;
  const quote = calculate({ monto: policy.cargo_visita_fallida, iva_porcentaje: policy.iva_porcentaje }, 0n, 0n);
  quote.lines[0].concept = 'Visita fallida';
  return quote;
}

async function saveSale(conn, user, stop, quote, notes, timestamp) {
  const { subtotal, iva, total } = quoteResponse(quote);
  const [sale] = await conn.execute(
    `INSERT INTO ventas (fk_cliente, fk_usuario, fk_recoleccion, folio, fecha_venta, subtotal, iva, total, observaciones)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [stop.fk_cliente, user, stop.pk_recoleccion, `V-${stop.pk_recoleccion}`, timestamp, subtotal, iva, total, notes]
  );
  await conn.query(
    'INSERT INTO ventas_detalle (fk_venta, concepto, cantidad, precio_unitario, subtotal) VALUES ?',
    [quote.lines.map(line => [sale.insertId, line.concept, amount(line.quantity), amount(line.rate), amount(line.total)])]
  );
  await audit(conn, user, 'ventas', sale.insertId, 'emitir');
  return sale.insertId;
}

async function preview(user, stopId, body) {
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    requireStarted(stop);
    const { quote } = await serviceData(conn, stop, body.residuos);
    return quoteResponse(quote);
  });
}

async function complete(user, stopId, body) {
  const notes = text(body.observaciones, 'Observaciones', 255, false);
  const supplies = text(body.insumos, 'Insumos', 255, false);
  const origin = text(body.origen, 'Origen', 255);
  const destination = text(body.destino, 'Destino', 255);
  const signature = image(body.firma, 'Firma');
  const photo = image(body.foto, 'Foto', true);
  const accepted = decimal(body.total_confirmado, 'Total confirmado', true);
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    if (stop.estado === 'completada') {
      return { fk_venta: stop.fk_venta, fk_manifiesto: stop.fk_manifiesto };
    }
    requireStarted(stop);
    const [[legacy]] = await conn.execute(
      `SELECT EXISTS(SELECT 1 FROM ventas WHERE fk_recoleccion = ? AND estado = 1)
           OR EXISTS(SELECT 1 FROM manifiestos WHERE fk_recoleccion = ? AND estado = 1)
           OR EXISTS(SELECT 1 FROM recolecciones_detalle WHERE fk_recoleccion = ? AND estado = 1) previo`,
      [stopId, stopId, stopId]
    );
    if (legacy.previo) throw new RequestError('Esta parada ya contiene registros previos. Solicita una revisión.', 409);
    const { items, quote } = await serviceData(conn, stop, body.residuos);
    if (accepted !== quote.total) throw new RequestError('El importe cambió. Vuelve a calcular y recaba la firma.', 409);
    const amounts = quoteResponse(quote);
    const timestamp = now();
    const saleId = await saveSale(conn, user, stop, quote, notes, timestamp);
    const [manifest] = await conn.execute(
      `INSERT INTO manifiestos (fk_recoleccion, fk_cliente, fk_chofer, folio, fecha_emision,
         origen, destino, observaciones, cliente_nombre, chofer_nombre)
       SELECT r.pk_recoleccion, r.fk_cliente, r.fk_chofer, ?, ?, ?, ?, ?, c.nombre, ch.nombre
       FROM recolecciones r JOIN clientes c ON c.pk_cliente = r.fk_cliente
       JOIN choferes ch ON ch.pk_chofer = r.fk_chofer WHERE r.pk_recoleccion = ?`,
      [`M-${stopId}`, timestamp, origin, destination, notes, stopId]
    );
    await conn.query(
      'INSERT INTO recolecciones_detalle (fk_recoleccion, fk_desecho, cantidad, peso, observaciones) VALUES ?',
      [items.map(item => [stopId, item.wasteId, amount(item.quantity), amount(item.weight), item.notes])]
    );
    await conn.query(
      `INSERT INTO manifiestos_detalle
       (fk_manifiesto, fk_desecho, cantidad, peso, unidad_medida, descripcion) VALUES ?`,
      [items.map(item => [manifest.insertId, item.wasteId, amount(item.quantity), amount(item.weight),
        item.waste.unidad_medida, item.waste.nombre])]
    );
    await conn.execute('UPDATE recolecciones SET total = ?, observaciones = ? WHERE pk_recoleccion = ?',
      [amounts.total, notes, stopId]);
    await conn.execute(
      `UPDATE servicios_chofer SET estado = 'completada', cierre = ?, firma = ?, foto = ?, fk_usuario = ?, insumos = ?,
       fk_venta = ?, fk_manifiesto = ? WHERE fk_recoleccion = ?`,
      [timestamp, signature, photo, user, supplies, saleId, manifest.insertId, stopId]
    );
    await audit(conn, user, 'recolecciones', stopId, 'completar');
    await audit(conn, user, 'manifiestos', manifest.insertId, 'emitir');
    return { fk_venta: saleId, fk_manifiesto: manifest.insertId };
  });
}

async function requireOpen(conn, user, shift, day) {
  const [[cut]] = await conn.execute(
    'SELECT fk_corte FROM cierres_chofer WHERE fk_usuario = ? AND fk_turno = ? AND jornada = ?',
    [user, shift, day]
  );
  if (cut) throw new RequestError('El turno ya tiene un corte registrado.', 409);
}

async function pay(user, stopId, body) {
  const saleId = id(body.fk_venta);
  const method = id(body.fk_metodo_pago);
  const value = decimal(body.importe, 'Importe');
  const operation = key(body.clave);
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    const [[sale]] = await conn.execute(
      `SELECT v.total FROM ventas v JOIN servicios_chofer s ON s.fk_venta = v.pk_venta
       WHERE v.pk_venta = ? AND v.fk_cliente = ? AND v.estado = 1 FOR UPDATE OF v`, [saleId, stop.fk_cliente]
    );
    if (!sale) throw new RequestError('Venta no encontrada.', 404);
    const [[prior]] = await conn.execute(
      'SELECT pk_pago, fk_venta, fk_metodo_pago, importe FROM pagos_chofer WHERE fk_usuario = ? AND clave = ?',
      [user, operation]
    );
    if (prior) {
      if (prior.fk_venta !== saleId || prior.fk_metodo_pago !== method || prior.importe !== amount(value)) {
        throw new RequestError('La clave de operación ya se usó con otros datos.', 409);
      }
      return { pk_pago: prior.pk_pago };
    }
    const timestamp = now();
    const day = timestamp.slice(0, 10);
    if (stop.fecha.slice(0, 10) !== day) throw new RequestError('El cobro requiere una parada de hoy.', 409);
    await requireOpen(conn, user, stop.fk_turno, day);
    const [[paymentMethod]] = await conn.execute(
      'SELECT pk_metodo_pago FROM metodos_pago WHERE pk_metodo_pago = ? AND estado = 1', [method]
    );
    if (!paymentMethod) throw new RequestError('Método de pago no disponible.');
    const [[paid]] = await conn.execute(
      'SELECT COALESCE(SUM(importe), 0) importe FROM pagos_chofer WHERE fk_venta = ?', [saleId]
    );
    if (value > decimal(sale.total, 'Total', true) - decimal(paid.importe, 'Pagado', true)) {
      throw new RequestError('El importe supera el saldo pendiente.', 409);
    }
    const [payment] = await conn.execute(
      `INSERT INTO pagos_chofer (fk_venta, fk_usuario, fk_turno, fk_metodo_pago, importe, fecha, clave)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [saleId, user, stop.fk_turno, method, amount(value), timestamp, operation]
    );
    await conn.execute('UPDATE ventas SET fk_metodo_pago = COALESCE(fk_metodo_pago, ?) WHERE pk_venta = ?',
      [method, saleId]);
    await audit(conn, user, 'pagos', payment.insertId, 'registrar');
    return { pk_pago: payment.insertId };
  });
}

async function manifest(user, stopId) {
  const stop = await getStop(db, user, stopId);
  if (!stop.fk_manifiesto) throw new RequestError('Manifiesto no encontrado.', 404);
  const [[header]] = await db.execute(
    `SELECT m.folio, m.origen, m.destino, m.observaciones, m.cliente_nombre cliente, m.chofer_nombre chofer,
       DATE_FORMAT(m.fecha_emision, '%Y-%m-%dT%H:%i:%s') fecha_emision,
       DATE_FORMAT(e.fecha_entrega, '%Y-%m-%dT%H:%i:%s') fecha_entrega
     FROM manifiestos m LEFT JOIN entregas_manifiesto_chofer e ON e.fk_manifiesto = m.pk_manifiesto
     WHERE m.pk_manifiesto = ?`, [stop.fk_manifiesto]
  );
  const [residuos] = await db.execute(
    `SELECT descripcion, cantidad, peso, unidad_medida FROM manifiestos_detalle
     WHERE fk_manifiesto = ? ORDER BY pk_manifiesto_detalle`, [stop.fk_manifiesto]
  );
  return { ...header, residuos };
}

async function deliver(user, stopId) {
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    if (!stop.fk_manifiesto) throw new RequestError('Manifiesto no encontrado.', 404);
    const [[delivery]] = await conn.execute(
      'SELECT 1 FROM entregas_manifiesto_chofer WHERE fk_manifiesto = ?', [stop.fk_manifiesto]
    );
    if (!delivery) {
      await conn.execute(
        'INSERT INTO entregas_manifiesto_chofer (fk_manifiesto, fk_usuario, fecha_entrega) VALUES (?, ?, ?)',
        [stop.fk_manifiesto, user, now()]
      );
      await audit(conn, user, 'manifiestos', stop.fk_manifiesto, 'entregar');
    }
    return { fk_manifiesto: stop.fk_manifiesto };
  });
}

async function manifests(user, day, folio) {
  const [manifiestos] = await db.execute(
    `SELECT m.folio, m.fk_recoleccion, m.cliente_nombre cliente,
       DATE_FORMAT(m.fecha_emision, '%Y-%m-%dT%H:%i:%s') fecha
     FROM manifiestos m JOIN servicios_chofer s ON s.fk_manifiesto = m.pk_manifiesto
     JOIN recolecciones r ON r.pk_recoleccion = s.fk_recoleccion
     JOIN choferes ch ON ch.pk_chofer = r.fk_chofer AND ch.estado = 1
     WHERE ch.fk_usuario = ? AND
       ((? IS NOT NULL AND m.folio = ?) OR
        (? IS NULL AND m.fecha_emision >= ? AND m.fecha_emision < DATE_ADD(?, INTERVAL 1 DAY)))
     ORDER BY m.fecha_emision DESC, m.pk_manifiesto DESC`, [user, folio, folio, folio, day, day]
  );
  return { manifiestos };
}

async function evidence(user, stopId, type) {
  if (!['foto', 'firma'].includes(type)) throw new RequestError('Evidencia no encontrada.', 404);
  const [[row]] = await db.execute(
    `SELECT s.${type} bytes FROM servicios_chofer s JOIN recolecciones r ON r.pk_recoleccion = s.fk_recoleccion
     JOIN choferes ch ON ch.pk_chofer = r.fk_chofer
     WHERE r.pk_recoleccion = ? AND ch.fk_usuario = ? AND ch.estado = 1`, [stopId, user]
  );
  if (!row?.bytes) throw new RequestError('Evidencia no encontrada.', 404);
  return row.bytes;
}

async function catalog() {
  const [residuos] = await db.execute('SELECT pk_desecho id, nombre FROM desechos WHERE estado = 1 ORDER BY nombre');
  const [metodos] = await db.execute('SELECT pk_metodo_pago id, nombre FROM metodos_pago WHERE estado = 1 ORDER BY nombre');
  return { residuos, metodos };
}

async function clientVisits(user, stopId) {
  const stop = await getStop(db, user, stopId);
  const [paradas] = await db.execute(
    `SELECT ${stopFields} ${stopJoins}
     WHERE ch.fk_usuario = ? AND r.fk_cliente = ? AND s.estado IN ('completada', 'fallida')
     ORDER BY r.fecha_recoleccion DESC, r.pk_recoleccion DESC LIMIT 50`,
    [user, stop.fk_cliente]
  );
  return { paradas };
}

async function history(user, day, client) {
  const [sales] = await db.execute(
    `SELECT v.folio, c.nombre cliente, v.total,
       DATE_FORMAT(v.fecha_venta, '%Y-%m-%dT%H:%i:%s') fecha,
       v.total - COALESCE((SELECT SUM(p.importe) FROM pagos_chofer p WHERE p.fk_venta = v.pk_venta), 0) saldo
     FROM ventas v JOIN servicios_chofer s ON s.fk_venta = v.pk_venta
     JOIN clientes c ON c.pk_cliente = v.fk_cliente
     WHERE v.fk_usuario = ? AND v.estado = 1 AND v.fecha_venta >= ?
       AND v.fecha_venta < DATE_ADD(?, INTERVAL 1 DAY) AND c.nombre LIKE CONCAT('%', ?, '%')
     ORDER BY v.fecha_venta DESC, v.pk_venta DESC`, [user, day, day, client]
  );
  return { ventas: sales };
}

module.exports = { db, list, detail, start, fail, preview, complete, pay, manifest, deliver, manifests, evidence, catalog,
  history, clientVisits, transaction, getStop, requireOpen, today, now, audit };
