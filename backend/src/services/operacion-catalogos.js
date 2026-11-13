const { randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const { db, transaction, now, audit } = require('./chofer');
const { RequestError, id, text, date, decimal, amount } = require('./chofer-domain');

const derive = promisify(scrypt);
const field = (key, label, type = 'text', required = true, max = 120) =>
  ({ key, label, type, required, max });
const ref = (key, label, source, required = true) =>
  ({ ...field(key, label, 'ref', required), source });
const name = field('nombre', 'Nombre');
const description = field('descripcion', 'Descripción', 'text', false, 255);
const catalogs = {
  usuarios: { pk: 'pk_usuario', label: 'Usuarios', created: 'fecha_creacion', fields: [
    ref('fk_rol', 'Rol', 'roles'), field('usuario', 'Usuario'), field('nombre', 'Nombre', 'text', true, 255),
    field('correo', 'Correo', 'email', false), field('pass', 'Contraseña', 'password', false, 120)
  ] },
  roles: { pk: 'pk_rol', label: 'Roles', fields: [name, description] },
  clientes: { pk: 'pk_cliente', label: 'Clientes', commercial: true, created: 'fecha_registro', fields: [
    ref('fk_usuario', 'Cuenta del cliente', 'cuentas_cliente', false), name,
    field('telefono', 'Teléfono', 'text', false, 10), field('correo', 'Correo', 'email', false),
    ref('fk_actividad_comercial', 'Actividad comercial', 'actividades_comerciales', false),
    field('razon_social', 'Razón social', 'text', false, 255), field('rfc', 'RFC', 'text', false, 13),
    field('direccion', 'Dirección', 'text', true, 255), ref('fk_colonia', 'Colonia', 'colonias', false),
    field('codigo_postal', 'Código postal', 'text', false, 10)
  ] },
  contratos: { pk: 'pk_contrato', label: 'Contratos', title: 'folio', commercial: true, created: 'fecha_creacion', fields: [
    ref('fk_cliente', 'Cliente', 'clientes'), field('folio', 'Folio', 'text', true, 50),
    field('fecha_inicio', 'Inicio de vigencia', 'date'), field('fecha_fin', 'Fin de vigencia', 'date'),
    field('frecuencia_recoleccion', 'Frecuencia', 'frequency'), field('hora_servicio', 'Hora del servicio', 'time'),
    field('monto', 'Cuota por visita', 'decimal'), field('iva_porcentaje', 'IVA (%)', 'decimal'),
    field('cargo_visita_fallida', 'Cargo por visita fallida', 'decimal', false),
    field('kilos_mensuales', 'Kilos incluidos al mes', 'decimal', false),
    field('tarifa_excedente', 'Tarifa por kilo excedente', 'decimal', false), description
  ] },
  rutas: { pk: 'pk_ruta', label: 'Rutas', commercial: true, created: 'fecha_creacion', fields: [
    name, ref('fk_sector', 'Sector', 'sectores'), description
  ] },
  choferes: { pk: 'pk_chofer', label: 'Choferes', fields: [
    ref('fk_usuario', 'Cuenta del chofer', 'cuentas_chofer'), name,
    field('telefono', 'Teléfono', 'text', false, 10), field('numero_licencia', 'Número de licencia', 'text', true, 50),
    field('vencimiento_licencia', 'Vencimiento de licencia', 'date'), field('fecha_ingreso', 'Fecha de ingreso', 'date')
  ] },
  turnos: { pk: 'pk_turno', label: 'Turnos', fields: [
    name, field('hora_inicio', 'Hora de inicio', 'time'), field('hora_fin', 'Hora de fin', 'time'), description
  ] },
  sectores: { pk: 'pk_sector', label: 'Sectores', fields: [name, description] },
  colonias: { pk: 'pk_colonias', label: 'Colonias', fields: [
    name, ref('fk_sector', 'Sector', 'sectores'), field('municipio', 'Municipio'),
    field('ciudad', 'Ciudad'), field('estado_republica', 'Estado'), field('codigo_postal', 'Código postal', 'text', true, 10)
  ] },
  actividades_comerciales: { pk: 'pk_actividad_comercial', label: 'Actividades comerciales', fields: [name, description] },
  desechos: { pk: 'pk_desecho', label: 'Residuos', fields: [
    name, field('tipo', 'Tipo'), field('unidad_medida', 'Unidad de medida', 'text', true, 50),
    field('precio', 'Precio', 'decimal'), description
  ] },
  metodos_pago: { pk: 'pk_metodo_pago', label: 'Métodos de pago', fields: [name, description] },
  banners: { pk: 'pk_banner', label: 'Avisos', title: 'titulo', fields: [
    field('titulo', 'Título'), field('descripcion', 'Descripción', 'text', true, 255)
  ] }
};
const frequencies = ['Semanal', 'Quincenal', 'Mensual'];
const accounts = { cuentas_cliente: 4, cuentas_chofer: 3 };

function definition(resource, role) {
  const config = Object.hasOwn(catalogs, resource) && catalogs[resource];
  if (!config || (role !== 1 && !config.commercial)) throw new RequestError('Catálogo no disponible.', 404);
  return config;
}

function menu(role) {
  return { items: Object.entries(catalogs)
    .filter(([, config]) => role === 1 || config.commercial)
    .map(([key, config]) => ({ key, label: config.label })) };
}

async function options(conn, source) {
  if (Object.hasOwn(accounts, source)) {
    const [rows] = await conn.execute(
      'SELECT pk_usuario id, CONCAT(nombre, " · ", usuario) nombre FROM usuarios WHERE fk_rol = ? AND estado = 1 ORDER BY nombre',
      [accounts[source]]
    );
    return rows;
  }
  const config = catalogs[source];
  const [rows] = await conn.query(
    `SELECT ${config.pk} id, ${config.title || 'nombre'} nombre FROM ${source} WHERE estado = 1 ORDER BY nombre`
  );
  return rows;
}

async function list(resource, role, page) {
  const config = definition(resource, role);
  const offset = (page - 1) * 50;
  const fields = config.fields.filter(item => item.type !== 'password').map(item =>
    item.type === 'date' ? `DATE_FORMAT(${item.key}, '%Y-%m-%d') ${item.key}` : item.key);
  const [items] = await db.execute(
    `SELECT ${config.pk} id, estado, ${fields.join(', ')} FROM ${resource}
     ORDER BY estado DESC, ${config.pk} DESC LIMIT 51 OFFSET ?`, [offset]
  );
  const selectors = {};
  for (const item of config.fields.filter(item => item.source)) {
    selectors[item.source] = await options(db, item.source);
  }
  return { items: items.slice(0, 50), more: items.length > 50, fields: config.fields, selectors,
    title: config.title || 'nombre', label: config.label, frequencies };
}

function valueFor(item, value) {
  if ((value == null || value === '') && !item.required) return null;
  switch (item.type) {
    case 'ref': return id(value);
    case 'decimal': return amount(decimal(value, item.label, true));
    case 'date': return date(value);
    case 'time':
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)) {
        throw new RequestError(`${item.label} requiere formato HH:MM.`);
      }
      return value.slice(0, 5) + ':00';
    case 'frequency':
      if (!frequencies.includes(value)) throw new RequestError('Selecciona una frecuencia válida.');
      return value;
    case 'email':
      if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
        throw new RequestError('Correo inválido.');
      }
      return text(value, item.label, item.max);
    default: return text(value, item.label, item.max, item.required);
  }
}

async function validateReferences(conn, config, values) {
  for (const item of config.fields.filter(item => item.source && values[item.key] != null)) {
    const source = item.source;
    const target = catalogs[source];
    const [rows] = target
      ? await conn.execute(`SELECT 1 FROM ${source} WHERE ${target.pk} = ? AND estado = 1`, [values[item.key]])
      : await conn.execute('SELECT 1 FROM usuarios WHERE pk_usuario = ? AND fk_rol = ? AND estado = 1',
        [values[item.key], accounts[source]]);
    if (!rows.length) throw new RequestError(`${item.label} no está disponible.`, 409);
  }
}

async function validateUnique(conn, resource, config, values, resourceId) {
  const fields = { usuarios: ['usuario', 'correo'], contratos: ['folio'], choferes: ['fk_usuario'], clientes: ['fk_usuario'] };
  for (const key of fields[resource] || []) {
    if (values[key] == null) continue;
    const [[existing]] = await conn.execute(
      `SELECT ${config.pk} id FROM ${resource} WHERE ${key} = ? AND ${config.pk} <> ? LIMIT 1`,
      [values[key], resourceId || 0]
    );
    if (existing) throw new RequestError(`El campo ${config.fields.find(item => item.key === key).label} ya está en uso.`, 409);
  }
}

async function save(user, resource, resourceId, body) {
  const existingId = resourceId;
  const config = definition(resource, user.fk_rol);
  const values = Object.fromEntries(config.fields.map(item => [item.key, valueFor(item, body[item.key])]));
  if (resource === 'usuarios') {
    if (!resourceId && !values.pass) throw new RequestError('Captura una contraseña.');
    if (values.pass) {
      if (values.pass.length < 8) throw new RequestError('La contraseña requiere al menos ocho caracteres.');
      const salt = randomBytes(16).toString('hex');
      const encoded = Buffer.from(values.pass).toString('base64');
      values.pass = `scrypt:${salt}:${(await derive(encoded, salt, 64)).toString('hex')}`;
    } else {
      delete values.pass;
    }
    if (resourceId === user.pk_usuario && values.fk_rol !== user.fk_rol) {
      throw new RequestError('Tu cuenta debe conservar el rol de administrador.', 409);
    }
  }
  if (resource === 'contratos' && (values.fecha_fin < values.fecha_inicio ||
      Number(values.iva_porcentaje) > 100 ||
      (values.kilos_mensuales != null && values.tarifa_excedente == null))) {
    throw new RequestError('Revisa la vigencia, el porcentaje de IVA y la tarifa de excedente.');
  }
  if (resource === 'turnos' && values.hora_inicio >= values.hora_fin) {
    throw new RequestError('La hora de fin debe ser posterior a la de inicio.');
  }
  return transaction(user.pk_usuario, async conn => {
    // Un solo coordinador evita altas duplicadas entre usuarios distintos.
    await conn.query('SELECT pk_rol FROM roles WHERE pk_rol = 1 FOR UPDATE');
    await validateReferences(conn, config, values);
    await validateUnique(conn, resource, config, values, resourceId);
    if (resource === 'contratos' && existingId) {
      const [[contract]] = await conn.execute(
        'SELECT fk_cliente FROM contratos WHERE pk_contrato = ? FOR UPDATE', [existingId]
      );
      if (contract && values.fk_cliente !== contract.fk_cliente) {
        const [[visit]] = await conn.execute(
          'SELECT 1 FROM recolecciones WHERE fk_contrato = ? LIMIT 1', [existingId]
        );
        if (visit) throw new RequestError('El contrato ya tiene visitas. Conserva el cliente original.', 409);
      }
    }
    let savedId = existingId;
    if (existingId) {
      const [result] = await conn.query(`UPDATE ${resource} SET ? WHERE ${config.pk} = ?`, [values, resourceId]);
      if (!result.affectedRows) throw new RequestError('Registro no encontrado.', 404);
    } else {
      if (config.created) values[config.created] = now();
      const [result] = await conn.query(`INSERT INTO ${resource} SET ?`, [values]);
      savedId = result.insertId;
    }
    await audit(conn, user.pk_usuario, resource, savedId, 'guardar');
    return { id: savedId };
  });
}

async function setActive(user, resource, resourceId, active) {
  const config = definition(resource, user.fk_rol);
  if (typeof active !== 'boolean') throw new RequestError('Estado inválido.');
  if (!active && ((resource === 'usuarios' && resourceId === user.pk_usuario) ||
      (resource === 'roles' && resourceId === 1))) {
    throw new RequestError('La cuenta o rol de administración debe permanecer activo.', 409);
  }
  return transaction(user.pk_usuario, async conn => {
    const [result] = await conn.execute(
      `UPDATE ${resource} SET estado = ? WHERE ${config.pk} = ?`, [Number(active), resourceId]
    );
    if (!result.affectedRows) throw new RequestError('Registro no encontrado.', 404);
    await audit(conn, user.pk_usuario, resource, resourceId, active ? 'activar' : 'desactivar');
    return { id: resourceId };
  });
}

module.exports = { audit, menu, options, list, save, setActive };
