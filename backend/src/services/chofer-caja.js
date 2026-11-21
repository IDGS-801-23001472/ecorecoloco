
const mongoose = require('mongoose');

const {
  Driver,
  Collection,
  Payment,
  Expense,
  Cut,
} = require('../models');

const {
  transaction,
  getStop,
  requireOpen,
  today,
  audit,
} = require('./chofer');

const {
  RequestError,
  decimal,
  amount,
  date,
  key,
  text,
} = require('./chofer-domain');

// ========================================
// UTILIDADES
// ========================================

function objectId(value, label = 'Identificador') {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{24}$/i.test(value)
  ) {
    throw new RequestError(`${label} inválido.`);
  }

  return new mongoose.Types.ObjectId(value);
}

function asId(value) {
  return value?._id?.toString() ||
    value?.toString() ||
    null;
}

function cents(value, label = 'Importe') {
  return decimal(
    value?.toString() ?? '0',
    label,
    true
  );
}

function decimal128(value) {
  return mongoose.Types.Decimal128.fromString(
    amount(value)
  );
}

// ========================================
// FECHAS LOCALES
// ========================================

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function localTime(value) {
  if (!value) return null;

  const p = Object.fromEntries(
    fmt.formatToParts(new Date(value))
      .filter(item => item.type !== 'literal')
      .map(item => [item.type, item.value])
  );

  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function startOfLocalDay(day) {
  const probe = new Date(`${day}T12:00:00Z`);

  const p = Object.fromEntries(
    fmt.formatToParts(probe)
      .filter(item => item.type !== 'literal')
      .map(item => [item.type, item.value])
  );

  const observedAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );

  return new Date(
    Date.parse(`${day}T00:00:00Z`) -
    (observedAsUtc - probe.getTime())
  );
}

function dayRange(day) {
  date(day);

  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);

  return {
    $gte: startOfLocalDay(day),
    $lt: startOfLocalDay(
      next.toISOString().slice(0, 10)
    ),
  };
}

// ========================================
// REGISTRAR VIÁTICO
// ========================================

async function expense(user, body) {
  const stopId = objectId(
    body?.fk_recoleccion,
    'Parada'
  );

  const concept = text(
    body?.concepto,
    'Concepto',
    120
  );

  const value = decimal(
    body?.importe,
    'Importe'
  );

  const operation = key(body?.clave);
  const userId = objectId(user, 'Usuario');

  return transaction(user, async session => {
    const stop = await getStop(
      session,
      user,
      stopId.toString()
    );

    // Evitar duplicados por reintentos.
    const prior = await Expense.findOne({
      usuarioId: userId,
      clave: operation,
    }).session(session);

    if (prior) {
      if (
        asId(prior.recoleccionId) !== asId(stop._id) ||
        asId(prior.rutaId) !== asId(stop.rutaId) ||
        asId(prior.turnoId) !== asId(stop.turnoId) ||
        cents(prior.importe) !== value ||
        prior.concepto !== concept
      ) {
        throw new RequestError(
          'La clave de operación ya se usó con otros datos.',
          409
        );
      }

      return { pk_viatico: asId(prior) };
    }

    const day = today();

    if (stop.fechaClave !== day) {
      throw new RequestError(
        'El gasto requiere una parada de hoy.',
        409
      );
    }

    await requireOpen(
      session,
      user,
      asId(stop.turnoId),
      day
    );

    const timestamp = new Date();

    const [saved] = await Expense.create([{
      choferId: stop.choferId._id,
      rutaId: stop.rutaId._id,
      usuarioId: userId,
      turnoId: stop.turnoId._id,
      recoleccionId: stop._id,

      fecha: timestamp,
      importe: decimal128(value),
      concepto: concept,
      clave: operation,

      detalles: [{
        concepto: concept,
        cantidad: decimal128(100n),
        importe: decimal128(value),
        fecha: timestamp,
      }],

      activo: true,
    }], { session });

    await audit(
      session,
      user,
      'viaticos',
      saved._id,
      'registrar'
    );

    return {
      pk_viatico: asId(saved),
    };
  });
}

// ========================================
// MOVIMIENTOS DEL TURNO
// ========================================

async function shiftData(session, user, shiftId, day) {
  const userId = objectId(user, 'Usuario');

  const driver = await Driver.findOne({
    cuentaId: userId,
    activo: true,
  })
    .session(session)
    .select('_id');

  if (!driver) {
    throw new RequestError(
      'Chofer no disponible.',
      403
    );
  }

  const hasStops = await Collection.exists({
    choferId: driver._id,
    turnoId: shiftId,
    fechaClave: day,
  }).session(session);

  if (!hasStops) {
    throw new RequestError(
      'No tienes paradas en ese turno.',
      404
    );
  }

  const range = dayRange(day);

  // Las consultas en una transacción se ejecutan
  // secuencialmente para evitar conflictos de sesión.

  const payments = await Payment.find({
    usuarioId: userId,
    turnoId: shiftId,
    fecha: range,
  })
    .populate('metodoPagoId', 'nombre')
    .populate('ventaId', 'folio')
    .sort({ _id: 1 })
    .session(session)
    .lean();

  const expenses = await Expense.find({
    usuarioId: userId,
    turnoId: shiftId,
    fecha: range,
    activo: true,
  })
    .sort({ _id: 1 })
    .session(session)
    .lean();

  let paymentTotal = 0n;
  let cash = 0n;
  let costs = 0n;

  const paymentRows = payments.map(payment => {
    const value = cents(payment.importe, 'Pago');

    const method =
      payment.metodoPagoId?.nombre || '';

    paymentTotal += value;

    if (
      method.trim().toLowerCase() === 'efectivo'
    ) {
      cash += value;
    }

    return {
      pk_pago: asId(payment),
      fk_venta: asId(payment.ventaId),
      fk_metodo_pago: asId(payment.metodoPagoId),

      importe: amount(value),
      metodo: method,

      folio: payment.ventaId?.folio || '',
      fecha: localTime(payment.fecha),
    };
  });

  const expenseRows = expenses.map(item => {
    const value = cents(item.importe, 'Gasto');

    costs += value;

    return {
      concepto: item.concepto,
      importe: amount(value),
    };
  });

  return {
    payments,
    paymentRows,
    expenseRows,
    paymentTotal,
    cash,
    costs,
  };
}

// ========================================
// FORMATO DE CORTE PARA FLUTTER
// ========================================

function formatCut(cut) {
  if (!cut) return null;

  return {
    fk_corte: asId(cut),
    fk_usuario: asId(cut.usuarioId),
    fk_turno: asId(cut.turnoId),

    turno: cut.turnoId?.nombre || '',
    chofer: cut.usuarioId?.nombre || '',

    jornada: cut.jornada,

    monto_inicial: amount(cents(cut.fondoInicial)),
    total_ventas: amount(cents(cut.totalCobros)),
    total_gastos: amount(cents(cut.totalViaticos)),

    efectivo_esperado:
      cut.efectivoEsperado?.toString() ?? '0.00',

    efectivo_contado:
      amount(cents(cut.efectivoContado)),

    diferencia:
      cut.diferencia?.toString() ?? '0.00',

    fk_revisor: asId(cut.revisorId),

    nota_revision:
      cut.notaRevision ?? null,

    fecha_revision:
      localTime(cut.fechaRevision),
  };
}

// ========================================
// BUSCAR CORTE
// ========================================

async function findCut(session, user, shiftId, day) {
  const query = Cut.findOne({
    usuarioId: objectId(user, 'Usuario'),
    turnoId: shiftId,
    jornada: day,
  })
    .populate('usuarioId', 'nombre')
    .populate('turnoId', 'nombre');

  if (session) {
    query.session(session);
  }

  return query.lean();
}

// ========================================
// RESUMEN DE CAJA
// ========================================

async function summary(user, shift, day) {
  const shiftId = objectId(shift, 'Turno');

  date(day);

  return transaction(user, async session => {
    const cut = await findCut(
      session,
      user,
      shiftId,
      day
    );

    const data = await shiftData(
      session,
      user,
      shiftId,
      day
    );

    return {
      corte: formatCut(cut),

      pagos: data.paymentRows,
      viaticos: data.expenseRows,

      total_pagos: amount(data.paymentTotal),
      efectivo: amount(data.cash),
      gastos: amount(data.costs),
    };
  });
}

// ========================================
// CERRAR TURNO Y GENERAR CORTE
// ========================================

async function close(user, shift, day, body) {
  const shiftId = objectId(shift, 'Turno');

  date(day);

  const initial = decimal(
    body?.monto_inicial,
    'Fondo inicial',
    true
  );

  const counted = decimal(
    body?.efectivo_contado,
    'Efectivo contado',
    true
  );

  const notes = text(
    body?.observaciones,
    'Observaciones',
    255,
    false
  );

  if (day > today()) {
    throw new RequestError(
      'La jornada todavía no inicia.'
    );
  }

  return transaction(user, async session => {
    const previous = await findCut(
      session,
      user,
      shiftId,
      day
    );

    if (previous) {
      if (
        cents(previous.fondoInicial) !== initial ||
        cents(previous.efectivoContado) !== counted
      ) {
        throw new RequestError(
          'El turno ya fue cerrado con otros importes.',
          409
        );
      }

      return formatCut(previous);
    }

    const data = await shiftData(
      session,
      user,
      shiftId,
      day
    );

    // Fondo inicial + efectivo recibido - viáticos.
    const expected =
      initial + data.cash - data.costs;

    const timestamp = new Date();

    // Guardar instantánea de los cobros del turno.
    const movements = data.payments.map(payment => ({
      pagoId: payment._id,

      ventaId:
        payment.ventaId?._id,

      metodoPagoId:
        payment.metodoPagoId?._id,

      concepto: 'Cobro',

      importe: payment.importe,
      fecha: payment.fecha,
    }));

    if (movements.some(item =>
      !item.ventaId || !item.metodoPagoId
    )) {
      throw new RequestError(
        'Hay pagos con referencias incompletas.',
        409
      );
    }

    const [saved] = await Cut.create([{
      usuarioId: objectId(user, 'Usuario'),
      turnoId: shiftId,
      jornada: day,

      fechaInicio: dayRange(day).$gte,
      fechaFin: timestamp,

      fondoInicial: decimal128(initial),
      totalCobros: decimal128(data.paymentTotal),
      totalViaticos: decimal128(data.costs),

      efectivoFinal: decimal128(counted),

      efectivoEsperado: decimal128(expected),
      efectivoContado: decimal128(counted),
      diferencia: decimal128(counted - expected),

      observaciones: notes,
      movimientos: movements,
    }], { session });

    await audit(
      session,
      user,
      'cortes',
      saved._id,
      'cerrar'
    );

    const cut = await findCut(
      session,
      user,
      shiftId,
      day
    );

    return formatCut(cut);
  });
}

// ========================================
// CORTES PARA ADMINISTRACIÓN
// ========================================

async function listCuts(day) {
  date(day);

  const cuts = await Cut.find({
    jornada: day,
  })
    .populate('usuarioId', 'nombre')
    .populate('turnoId', 'nombre')
    .lean();

  // Mostrar los pendientes de revisión primero.
  cuts.sort((a, b) => {
    const aReviewed = a.revisorId ? 1 : 0;
    const bReviewed = b.revisorId ? 1 : 0;

    return aReviewed - bReviewed ||
      (a.usuarioId?.nombre || '').localeCompare(
        b.usuarioId?.nombre || '',
        'es'
      ) ||
      (a.turnoId?.nombre || '').localeCompare(
        b.turnoId?.nombre || '',
        'es'
      );
  });

  return {
    fecha: day,
    cortes: cuts.map(formatCut),
  };
}

// ========================================
// REVISIÓN ADMINISTRATIVA
// ========================================

async function review(user, cut, body) {
  const cutId = objectId(cut, 'Corte');
  const reviewer = objectId(user, 'Usuario');

  const note = text(
    body?.nota_revision,
    'Nota de revisión',
    255
  );

  return transaction(user, async session => {
    // Solo puede revisarse una vez.
    const updated = await Cut.findOneAndUpdate(
      {
        _id: cutId,
        revisorId: null,
      },
      {
        $set: {
          revisorId: reviewer,
          fechaRevision: new Date(),
          notaRevision: note,
        },
      },
      {
        new: true,
        session,
        runValidators: true,
      }
    );

    if (!updated) {
      throw new RequestError(
        'Corte inexistente o previamente revisado.',
        409
      );
    }

    await audit(
      session,
      user,
      'cortes',
      cutId,
      'revisar'
    );

    return {
      fk_corte: asId(cutId),
    };
  }, [`corte:${cutId}`]);
}

module.exports = {
  expense,
  summary,
  close,
  listCuts,
  review,
};
