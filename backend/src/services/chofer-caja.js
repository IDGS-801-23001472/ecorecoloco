const { db, transaction, getStop, requireOpen, today, now, audit } = require('./chofer');
const { RequestError, amount, decimal, id, key, text } = require('./chofer-domain');

async function expense(user, body) {
  const stopId = id(body.fk_recoleccion);
  const concept = text(body.concepto, 'Concepto', 120);
  const value = amount(decimal(body.importe, 'Importe'));
  const operation = key(body.clave);
  return transaction(user, async conn => {
    const stop = await getStop(conn, user, stopId, true);
    const [[prior]] = await conn.execute(
      'SELECT pk_viatico, fk_ruta, fk_turno, monto_gastado, observaciones FROM viaticos WHERE fk_usuario = ? AND clave = ?',
      [user, operation]
    );
    if (prior) {
      if (prior.monto_gastado !== value || prior.observaciones !== concept ||
          prior.fk_ruta !== stop.fk_ruta || prior.fk_turno !== stop.fk_turno) {
        throw new RequestError('La clave de operación ya se usó con otros datos.', 409);
      }
      return { pk_viatico: prior.pk_viatico };
    }
    const timestamp = now();
    const day = timestamp.slice(0, 10);
    if (stop.fecha.slice(0, 10) !== day) throw new RequestError('El gasto requiere una parada de hoy.', 409);
    await requireOpen(conn, user, stop.fk_turno, day);
    const [row] = await conn.execute(
      `INSERT INTO viaticos (fk_chofer, fk_ruta, fk_usuario, fk_turno, fecha, monto_gastado, observaciones, clave)
       SELECT fk_chofer, fk_ruta, ?, fk_turno, ?, ?, ?, ? FROM recolecciones WHERE pk_recoleccion = ?`,
      [user, timestamp, value, concept, operation, stopId]
    );
    await conn.execute(
      'INSERT INTO viaticos_detalle (fk_viatico, concepto, cantidad, monto, fecha_gasto) VALUES (?, ?, 1, ?, ?)',
      [row.insertId, concept, value, timestamp]
    );
    await audit(conn, user, 'viaticos', row.insertId, 'registrar');
    return { pk_viatico: row.insertId };
  });
}

async function shiftData(conn, user, shift, day) {
  const [[assigned]] = await conn.execute(
    `SELECT r.pk_recoleccion FROM recolecciones r JOIN choferes ch ON ch.pk_chofer = r.fk_chofer
     WHERE ch.fk_usuario = ? AND ch.estado = 1 AND r.fk_turno = ?
       AND r.fecha_recoleccion >= ? AND r.fecha_recoleccion < DATE_ADD(?, INTERVAL 1 DAY)
     LIMIT 1`, [user, shift, day, day]
  );
  if (!assigned) throw new RequestError('No tienes paradas en ese turno.', 404);
  const [payments] = await conn.execute(
    `SELECT p.pk_pago, p.fk_venta, p.fk_metodo_pago, p.importe, m.nombre metodo, v.folio,
       DATE_FORMAT(p.fecha, '%Y-%m-%dT%H:%i:%s') fecha
     FROM pagos_chofer p JOIN metodos_pago m ON m.pk_metodo_pago = p.fk_metodo_pago
     JOIN ventas v ON v.pk_venta = p.fk_venta
     WHERE p.fk_usuario = ? AND p.fk_turno = ? AND p.fecha >= ? AND p.fecha < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY p.pk_pago`, [user, shift, day, day]
  );
  const [expenses] = await conn.execute(
    `SELECT observaciones concepto, monto_gastado importe
     FROM viaticos WHERE fk_usuario = ? AND fk_turno = ? AND estado = 1
       AND fecha >= ? AND fecha < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY pk_viatico`, [user, shift, day, day]
  );
  const paymentTotal = payments.reduce((sum, p) => sum + decimal(p.importe, 'Pago'), 0n);
  const cash = payments.filter(p => p.metodo.trim().toLowerCase() === 'efectivo')
    .reduce((sum, p) => sum + decimal(p.importe, 'Pago'), 0n);
  const costs = expenses.reduce((sum, p) => sum + decimal(p.importe, 'Gasto'), 0n);
  return { payments, expenses, paymentTotal, cash, costs };
}

const cutFields = `x.fk_corte, c.fk_usuario, x.fk_turno, t.nombre turno, u.nombre chofer,
  DATE_FORMAT(x.jornada, '%Y-%m-%d') jornada, c.monto_inicial, c.total_ventas, c.total_gastos,
  x.efectivo_esperado, x.efectivo_contado, x.diferencia, x.fk_revisor, x.nota_revision,
  DATE_FORMAT(x.fecha_revision, '%Y-%m-%dT%H:%i:%s') fecha_revision`;
const cutJoins = `FROM cierres_chofer x JOIN cortes c ON c.pk_corte = x.fk_corte
  JOIN usuarios u ON u.pk_usuario = x.fk_usuario JOIN turnos t ON t.pk_turno = x.fk_turno`;

async function findCut(conn, user, shift, day) {
  const [[row]] = await conn.execute(
    `SELECT ${cutFields} ${cutJoins} WHERE x.fk_usuario = ? AND x.fk_turno = ? AND x.jornada = ?`,
    [user, shift, day]
  );
  return row;
}

async function summary(user, shift, day) {
  return transaction(user, async conn => {
    const cut = await findCut(conn, user, shift, day);
    const data = await shiftData(conn, user, shift, day);
    return { corte: cut ?? null, pagos: data.payments, viaticos: data.expenses,
      total_pagos: amount(data.paymentTotal), efectivo: amount(data.cash), gastos: amount(data.costs) };
  });
}

async function close(user, shift, day, body) {
  const initial = decimal(body.monto_inicial, 'Fondo inicial', true);
  const counted = decimal(body.efectivo_contado, 'Efectivo contado', true);
  const notes = text(body.observaciones, 'Observaciones', 255, false);
  if (day > today()) throw new RequestError('La jornada todavía no inicia.');
  return transaction(user, async conn => {
    const cut = await findCut(conn, user, shift, day);
    if (cut) {
      if (cut.monto_inicial !== amount(initial) || cut.efectivo_contado !== amount(counted)) {
        throw new RequestError('El turno ya fue cerrado con otros importes.', 409);
      }
      return cut;
    }
    const data = await shiftData(conn, user, shift, day);
    const expected = initial + data.cash - data.costs;
    const timestamp = now();
    const [row] = await conn.execute(
      `INSERT INTO cortes
       (fk_usuario, fk_turno, fecha_inicio, fecha_fin, monto_inicial, total_ventas, total_gastos, monto_final, observaciones)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user, shift, day + ' 00:00:00', timestamp, amount(initial),
        amount(data.paymentTotal), amount(data.costs), amount(counted), notes]
    );
    await conn.execute(
      `INSERT INTO cierres_chofer
       (fk_corte, fk_usuario, fk_turno, jornada, efectivo_esperado, efectivo_contado, diferencia)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.insertId, user, shift, day, amount(expected), amount(counted), amount(counted - expected)]
    );
    if (data.payments.length) {
      await conn.query(
        `INSERT INTO cortes_detalle (fk_corte, fk_pago, fk_venta, fk_metodo_pago, concepto, monto, fecha)
         VALUES ?`,
        [data.payments.map(p => [row.insertId, p.pk_pago, p.fk_venta, p.fk_metodo_pago,
          'Cobro', p.importe, p.fecha.replace('T', ' ')])]
      );
    }
    await audit(conn, user, 'cortes', row.insertId, 'cerrar');
    return findCut(conn, user, shift, day);
  });
}

async function listCuts(day) {
  const [rows] = await db.execute(
    `SELECT ${cutFields} ${cutJoins} WHERE x.jornada = ? ORDER BY x.fk_revisor IS NOT NULL, u.nombre, t.nombre`,
    [day]
  );
  return { fecha: day, cortes: rows };
}

async function review(user, cutId, body) {
  const notes = text(body.nota_revision, 'Nota de revisión', 255);
  return transaction(user, async conn => {
    const [result] = await conn.execute(
      `UPDATE cierres_chofer SET fk_revisor = ?, fecha_revision = ?, nota_revision = ?
       WHERE fk_corte = ? AND fk_revisor IS NULL`, [user, now(), notes, cutId]
    );
    if (!result.affectedRows) throw new RequestError('Corte inexistente o previamente revisado.', 409);
    await audit(conn, user, 'cortes', cutId, 'revisar');
    return { fk_corte: cutId };
  });
}

module.exports = { expense, summary, close, listCuts, review };
