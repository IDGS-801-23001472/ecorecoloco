const { db, transaction, today } = require('./chofer');
const { RequestError, date, id } = require('./chofer-domain');
const { audit, options } = require('./operacion-catalogos');

const dayString = value => value.toISOString().slice(0, 10);
const dayNumber = value => Date.parse(value) / 86400000;
const fromNumber = value => dayString(new Date(value * 86400000));

function occurrence(start, day, frequency) {
  if (frequency === 'Semanal' || frequency === 'Quincenal') {
    return (dayNumber(day) - dayNumber(start)) % (frequency === 'Semanal' ? 7 : 14) === 0;
  }
  if (frequency === 'Mensual') {
    const [year, month] = day.split('-').map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Number(day.slice(-2)) === Math.min(days, Number(start.slice(-2)));
  }
  return false;
}

async function createVisit(conn, user, contract, day) {
  const [[existing]] = await conn.execute(
    `SELECT 1 FROM visitas_generadas WHERE fk_contrato = ? AND fecha_original = ?
     UNION ALL
     SELECT 1 FROM recolecciones WHERE fk_contrato = ? AND fecha_recoleccion >= ?
       AND fecha_recoleccion < DATE_ADD(?, INTERVAL 1 DAY) LIMIT 1`,
    [contract.pk_contrato, day, contract.pk_contrato, day, day]
  );
  if (existing) return null;
  const [visit] = await conn.execute(
    `INSERT INTO recolecciones (fk_cliente, fk_contrato, folio, fecha_recoleccion)
     VALUES (?, ?, ?, ?)`, [contract.fk_cliente, contract.pk_contrato,
      `REC-${contract.pk_contrato}-${day.replaceAll('-', '')}`, day + ' ' + contract.hora_servicio]
  );
  await conn.execute(
    'INSERT INTO visitas_generadas (fk_contrato, fecha_original, fk_recoleccion) VALUES (?, ?, ?)',
    [contract.pk_contrato, day, visit.insertId]
  );
  await audit(conn, user, 'recolecciones', visit.insertId, 'programar');
  return visit.insertId;
}

async function schedule(user, body) {
  const day = date(body.fecha);
  const contractId = id(body.fk_contrato);
  if (day < today()) throw new RequestError('Selecciona hoy o una fecha futura.');
  return transaction(user, async conn => {
    const [[contract]] = await conn.execute(
      `SELECT k.pk_contrato, k.fk_cliente, k.hora_servicio
       FROM contratos k JOIN clientes c ON c.pk_cliente = k.fk_cliente AND c.estado = 1
       WHERE k.pk_contrato = ? AND k.estado = 1 AND k.fecha_inicio <= ? AND k.fecha_fin >= ?
         AND k.hora_servicio IS NOT NULL FOR UPDATE OF k`, [contractId, day, day]
    );
    if (!contract) throw new RequestError('Se requiere un contrato vigente con horario.', 409);
    const visit = await createVisit(conn, user, contract, day);
    if (!visit) throw new RequestError('El contrato ya tiene una visita para esa fecha.', 409);
    return { id: visit };
  });
}

async function generate(user, body) {
  const start = date(body.desde);
  const end = date(body.hasta);
  if (start < today() || start > end || dayNumber(end) - dayNumber(start) > 90) {
    throw new RequestError('Selecciona un periodo futuro de hasta 91 días.');
  }
  return transaction(user, async conn => {
    const [contracts] = await conn.execute(
      `SELECT k.pk_contrato, k.fk_cliente, DATE_FORMAT(k.fecha_inicio, '%Y-%m-%d') inicio,
         DATE_FORMAT(k.fecha_fin, '%Y-%m-%d') fin, k.hora_servicio, k.frecuencia_recoleccion
       FROM contratos k JOIN clientes c ON c.pk_cliente = k.fk_cliente AND c.estado = 1
       WHERE k.estado = 1 AND k.fecha_inicio <= ? AND k.fecha_fin >= ? AND k.hora_servicio IS NOT NULL
       ORDER BY k.pk_contrato FOR UPDATE OF k`, [end, start]
    );
    let created = 0;
    for (const contract of contracts) {
      const first = Math.max(dayNumber(start), dayNumber(contract.inicio));
      const last = Math.min(dayNumber(end), dayNumber(contract.fin));
      for (let n = first; n <= last; n++) {
        const day = fromNumber(n);
        if (occurrence(contract.inicio, day, contract.frecuencia_recoleccion) &&
            await createVisit(conn, user, contract, day)) created++;
      }
    }
    return { creadas: created };
  });
}

const visitFields = `r.pk_recoleccion id, r.folio, c.nombre cliente,
  DATE_FORMAT(r.fecha_recoleccion, '%Y-%m-%dT%H:%i:%s') fecha,
  r.estado activo, r.respuesta_cliente, r.publicada, r.fk_ruta, r.fk_chofer, r.fk_turno,
  r.orden_parada, ru.nombre ruta, ch.nombre chofer, t.nombre turno,
  COALESCE(s.estado, 'pendiente') servicio`;
const visitJoins = `FROM recolecciones r
  JOIN clientes c ON c.pk_cliente = r.fk_cliente
  LEFT JOIN rutas ru ON ru.pk_ruta = r.fk_ruta
  LEFT JOIN choferes ch ON ch.pk_chofer = r.fk_chofer
  LEFT JOIN turnos t ON t.pk_turno = r.fk_turno
  LEFT JOIN servicios_chofer s ON s.fk_recoleccion = r.pk_recoleccion`;

async function agenda(day) {
  const [items] = await db.execute(
    `SELECT ${visitFields} ${visitJoins} WHERE r.fecha_recoleccion >= ?
     AND r.fecha_recoleccion < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY r.fk_ruta, r.orden_parada, r.fecha_recoleccion, r.pk_recoleccion`, [day, day]
  );
  return { fecha: day, hoy: today(), items, rutas: await options(db, 'rutas'),
    choferes: await options(db, 'choferes'), turnos: await options(db, 'turnos'),
    contratos: await options(db, 'contratos') };
}

async function assign(user, body) {
  const day = date(body.fecha);
  const route = id(body.fk_ruta);
  const driver = id(body.fk_chofer);
  const shift = id(body.fk_turno);
  if (day < today() || typeof body.publicar !== 'boolean' ||
      !Array.isArray(body.paradas) || !body.paradas.length || body.paradas.length > 100) {
    throw new RequestError('Selecciona hasta 100 paradas para una fecha vigente.');
  }
  const ids = body.paradas.map(id);
  if (new Set(ids).size !== ids.length) throw new RequestError('Hay paradas repetidas.');
  return transaction(user, async conn => {
    // Serializa planificación entre vendedores, incluso en rutas distintas.
    await conn.query('SELECT pk_rol FROM roles WHERE pk_rol = 1 FOR UPDATE');
    const [[driverRow]] = await conn.execute(
      `SELECT ch.pk_chofer FROM choferes ch JOIN usuarios u ON u.pk_usuario = ch.fk_usuario
       WHERE ch.pk_chofer = ? AND ch.estado = 1 AND u.estado = 1 AND u.fk_rol = 3
       AND ch.vencimiento_licencia >= ?`, [driver, day]
    );
    const [[slot]] = await conn.execute(
      'SELECT hora_inicio, hora_fin FROM turnos WHERE pk_turno = ? AND estado = 1', [shift]);
    const [[routeRow]] = await conn.execute('SELECT pk_ruta FROM rutas WHERE pk_ruta = ? AND estado = 1', [route]);
    if (!driverRow || !slot || !routeRow) throw new RequestError('Verifica ruta, turno y licencia vigente del chofer.', 409);

    const [visits] = await conn.query(
      `SELECT r.pk_recoleccion id, TIME(r.fecha_recoleccion) hora, s.estado servicio
       FROM recolecciones r LEFT JOIN servicios_chofer s ON s.fk_recoleccion = r.pk_recoleccion
       WHERE r.pk_recoleccion IN (?) AND DATE(r.fecha_recoleccion) = ? AND r.estado = 1
         AND (r.fk_ruta IS NULL OR (r.fk_ruta = ? AND r.fk_turno = ? AND r.fk_chofer = ?))
       FOR UPDATE OF r`, [ids, day, route, shift, driver]
    );
    if (visits.length !== ids.length || visits.some(visit =>
      visit.servicio || visit.hora < slot.hora_inicio || visit.hora >= slot.hora_fin)) {
      throw new RequestError('Hay una parada ya iniciada, asignada a otro grupo o fuera del horario del turno.', 409);
    }
    const [[conflict]] = await conn.query(
      `SELECT r.pk_recoleccion FROM recolecciones r JOIN turnos t ON t.pk_turno = r.fk_turno
       WHERE DATE(r.fecha_recoleccion) = ? AND r.estado = 1 AND r.pk_recoleccion NOT IN (?)
         AND ((r.fk_chofer = ? AND t.hora_inicio < ? AND t.hora_fin > ?
               AND (r.fk_ruta <> ? OR r.fk_turno <> ?))
           OR (r.fk_ruta = ? AND r.fk_turno = ? AND r.fk_chofer <> ?)) LIMIT 1`,
      [day, ids, driver, slot.hora_fin, slot.hora_inicio, route, shift, route, shift, driver]
    );
    if (conflict) throw new RequestError('El chofer o la ruta ya tienen una asignación incompatible.', 409);

    const [[tail]] = await conn.query(
      `SELECT COALESCE(MAX(orden_parada), 0) orden FROM recolecciones
       WHERE DATE(fecha_recoleccion) = ? AND fk_ruta = ? AND fk_turno = ?
         AND fk_chofer = ? AND estado = 1 AND pk_recoleccion NOT IN (?)`,
      [day, route, shift, driver, ids]
    );
    for (const [index, visit] of ids.entries()) {
      await conn.execute(
        'UPDATE recolecciones SET fk_ruta = ?, fk_chofer = ?, fk_turno = ?, orden_parada = ?, publicada = ? WHERE pk_recoleccion = ?',
        [route, driver, shift, Number(tail.orden) + index + 1, Number(body.publicar), visit]
      );
      await audit(conn, user, 'recolecciones', visit, body.publicar ? 'publicar' : 'guardar_borrador');
    }
    return { asignadas: ids.length };
  });
}

async function unassign(user, visitId) {
  return transaction(user, async conn => {
    await conn.query('SELECT pk_rol FROM roles WHERE pk_rol = 1 FOR UPDATE');
    const [result] = await conn.execute(
      `UPDATE recolecciones r LEFT JOIN servicios_chofer s ON s.fk_recoleccion = r.pk_recoleccion
       SET r.fk_ruta = NULL, r.fk_chofer = NULL, r.fk_turno = NULL, r.orden_parada = NULL
       WHERE r.pk_recoleccion = ? AND r.estado = 1 AND r.fecha_recoleccion >= ?
         AND s.fk_recoleccion IS NULL`, [visitId, today()]
    );
    if (!result.affectedRows) throw new RequestError('La parada no se puede desasignar.', 409);
    await audit(conn, user, 'recolecciones', visitId, 'desasignar');
    return { id: visitId };
  });
}

async function customerVisits(user) {
  const [items] = await db.execute(
    `SELECT ${visitFields}, k.frecuencia_recoleccion frecuencia ${visitJoins}
     LEFT JOIN contratos k ON k.pk_contrato = r.fk_contrato
     WHERE c.fk_usuario = ? AND c.estado = 1
     ORDER BY (r.fecha_recoleccion >= ?) DESC, ABS(DATEDIFF(r.fecha_recoleccion, ?)), r.pk_recoleccion DESC
     LIMIT 100`, [user, today(), today()]
  );
  return { fecha: today(), items };
}

async function customerAction(user, visitId, body) {
  const action = body.accion;
  if (!['confirmar', 'cancelar', 'reprogramar'].includes(action)) throw new RequestError('Acción inválida.');
  const day = action === 'reprogramar' ? date(body.fecha) : null;
  return transaction(user, async conn => {
    const [[owner]] = await conn.execute(
      `SELECT r.fk_contrato FROM recolecciones r JOIN clientes c ON c.pk_cliente = r.fk_cliente
       WHERE r.pk_recoleccion = ? AND c.fk_usuario = ? AND c.estado = 1`, [visitId, user]
    );
    if (!owner) throw new RequestError('Visita no encontrada.', 404);
    const [[contract]] = await conn.execute(
      `SELECT DATE_FORMAT(fecha_inicio, '%Y-%m-%d') inicio, DATE_FORMAT(fecha_fin, '%Y-%m-%d') fin,
       frecuencia_recoleccion frecuencia, estado FROM contratos WHERE pk_contrato = ? FOR UPDATE`, [owner.fk_contrato]
    );
    const [[visit]] = await conn.execute(
      `SELECT r.estado activo, r.respuesta_cliente, r.fk_contrato, s.estado servicio,
        DATE_FORMAT(r.fecha_recoleccion, '%Y-%m-%d') fecha, TIME(r.fecha_recoleccion) hora
       FROM recolecciones r JOIN clientes c ON c.pk_cliente = r.fk_cliente
       LEFT JOIN servicios_chofer s ON s.fk_recoleccion = r.pk_recoleccion
       WHERE r.pk_recoleccion = ? AND c.fk_usuario = ? AND c.estado = 1 FOR UPDATE OF r`, [visitId, user]
    );
    const recovering = visit && action === 'reprogramar' && visit.respuesta_cliente === 'cancelada' &&
      contract?.frecuencia === 'Mensual' && day.slice(0, 7) === visit.fecha.slice(0, 7);
    if (!visit || visit.servicio || (!recovering && (!visit.activo || visit.fecha < today()))) {
      throw new RequestError('La visita ya no admite este cambio.', 409);
    }
    if (action === 'reprogramar') {
      if (!contract?.estado || !contract.inicio || !contract.fin || day === visit.fecha ||
          day < today() || day < contract.inicio || day > contract.fin) {
        throw new RequestError('Selecciona una nueva fecha dentro de la vigencia del contrato.');
      }
      const [[duplicate]] = await conn.execute(
        'SELECT 1 FROM recolecciones WHERE fk_contrato = ? AND DATE(fecha_recoleccion) = ? AND estado = 1 LIMIT 1',
        [visit.fk_contrato, day]
      );
      if (duplicate) throw new RequestError('Ya existe una visita para ese día.', 409);
      const [[available]] = await conn.execute(
        `SELECT 1 FROM turnos t
         WHERE t.estado = 1 AND t.hora_inicio <= ? AND t.hora_fin > ?
           AND EXISTS (
             SELECT 1 FROM choferes ch JOIN usuarios u ON u.pk_usuario = ch.fk_usuario
             WHERE ch.estado = 1 AND u.estado = 1 AND u.fk_rol = 3 AND ch.vencimiento_licencia >= ?
           ) LIMIT 1`, [visit.hora, visit.hora, day]
      );
      if (!available) throw new RequestError('No hay un turno y chofer habilitados para esa fecha y hora.', 409);
      await conn.execute(
        `UPDATE recolecciones SET fecha_recoleccion = ?, estado = 1, respuesta_cliente = 'reprogramada',
         fk_ruta = NULL, fk_chofer = NULL, fk_turno = NULL, orden_parada = NULL WHERE pk_recoleccion = ?`,
        [day + ' ' + visit.hora, visitId]
      );
    } else if (action === 'cancelar') {
      await conn.execute(
        `UPDATE recolecciones SET estado = 0, respuesta_cliente = 'cancelada',
         fk_ruta = NULL, fk_chofer = NULL, fk_turno = NULL, orden_parada = NULL WHERE pk_recoleccion = ?`, [visitId]
      );
    } else {
      await conn.execute("UPDATE recolecciones SET respuesta_cliente = 'confirmada' WHERE pk_recoleccion = ?", [visitId]);
    }
    await audit(conn, user, 'recolecciones', visitId, action);
    return { id: visitId };
  });
}

module.exports = { agenda, assign, unassign, generate, schedule, customerVisits, customerAction, occurrence };
