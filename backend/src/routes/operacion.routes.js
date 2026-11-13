const express = require('express');
const { authorize } = require('../middleware/session');
const { db, today } = require('../services/chofer');
const { date, id, RequestError } = require('../services/chofer-domain');
const catalogs = require('../services/operacion-catalogos');
const agenda = require('../services/operacion-agenda');

const router = express.Router();
const respond = handler => (req, res, next) =>
  Promise.resolve().then(() => handler(req)).then(data => res.json(data)).catch(next);
const commercial = (req, res, next) =>
  [1, 2].includes(req.user.fk_rol) ? next() : next(new RequestError('Acceso denegado.', 403));

router.use(authorize());

router.get('/catalogos', commercial, respond(req => catalogs.menu(req.user.fk_rol)));
router.get('/catalogos/:resource', commercial, respond(req =>
  catalogs.list(req.params.resource, req.user.fk_rol, id(req.query.pagina ?? 1))));
router.post('/catalogos/:resource', commercial, respond(req =>
  catalogs.save(req.user, req.params.resource, null, req.body)));
router.post('/catalogos/:resource/:id', commercial, respond(req =>
  catalogs.save(req.user, req.params.resource, id(req.params.id), req.body)));
router.post('/catalogos/:resource/:id/estado', commercial, respond(req =>
  catalogs.setActive(req.user, req.params.resource, id(req.params.id), req.body.activo)));

router.get('/agenda', commercial, respond(req => agenda.agenda(date(req.query.fecha ?? today()))));
router.post('/agenda/generar', commercial, respond(req => agenda.generate(req.user.pk_usuario, req.body)));
router.post('/agenda/programar', commercial, respond(req => agenda.schedule(req.user.pk_usuario, req.body)));
router.post('/agenda/asignar', commercial, respond(req => agenda.assign(req.user.pk_usuario, req.body)));
router.post('/agenda/:id/desasignar', commercial, respond(req => agenda.unassign(req.user.pk_usuario, id(req.params.id))));

function requireRole(role) {
  return (req, res, next) => req.user.fk_rol === role
    ? next()
    : next(new RequestError('Acceso denegado.', 403));
}

router.get('/cliente/visitas', requireRole(4), respond(req => agenda.customerVisits(req.user.pk_usuario)));
router.post('/cliente/visitas/:id', requireRole(4), respond(req =>
  agenda.customerAction(req.user.pk_usuario, id(req.params.id), req.body)));

router.get('/cliente/cuenta', requireRole(4), respond(async req => {
  const user = req.user.pk_usuario;
  const [clientes] = await db.execute(
    'SELECT nombre, direccion, correo, telefono FROM clientes WHERE fk_usuario = ? AND estado = 1', [user]);
  const [contratos] = await db.execute(
    `SELECT k.folio, DATE_FORMAT(k.fecha_inicio, '%Y-%m-%d') inicio,
       DATE_FORMAT(k.fecha_fin, '%Y-%m-%d') fin, k.frecuencia_recoleccion frecuencia, k.monto, k.estado
     FROM contratos k JOIN clientes c ON c.pk_cliente = k.fk_cliente
     WHERE c.fk_usuario = ? AND c.estado = 1 ORDER BY k.pk_contrato DESC LIMIT 100`, [user]);
  const [ventas] = await db.execute(
    `SELECT v.folio, v.total, v.total - COALESCE((SELECT SUM(p.importe) FROM pagos_chofer p
       WHERE p.fk_venta = v.pk_venta), 0) saldo
     FROM ventas v JOIN servicios_chofer s ON s.fk_venta = v.pk_venta
     JOIN clientes c ON c.pk_cliente = v.fk_cliente
     WHERE c.fk_usuario = ? AND c.estado = 1 AND v.estado = 1 ORDER BY v.pk_venta DESC LIMIT 100`, [user]);
  const [manifiestos] = await db.execute(
    `SELECT m.pk_manifiesto id, m.folio, DATE_FORMAT(m.fecha_emision, '%Y-%m-%d') fecha
     FROM manifiestos m JOIN clientes c ON c.pk_cliente = m.fk_cliente
     WHERE c.fk_usuario = ? AND c.estado = 1 AND m.estado = 1 ORDER BY m.pk_manifiesto DESC LIMIT 100`, [user]);
  const [avisos] = await db.query('SELECT titulo, descripcion FROM banners WHERE estado = 1 ORDER BY pk_banner DESC LIMIT 10');
  return { clientes, contratos, ventas, manifiestos, avisos };
}));

router.get('/cliente/manifiestos/:id', requireRole(4), respond(async req => {
  const manifest = id(req.params.id);
  const [[header]] = await db.execute(
    `SELECT m.folio, m.origen, m.destino, m.chofer_nombre chofer, m.observaciones,
       COALESCE(m.cliente_nombre, c.nombre) cliente,
       DATE_FORMAT(m.fecha_emision, '%Y-%m-%dT%H:%i:%s') emision,
       DATE_FORMAT(COALESCE(e.fecha_entrega, m.fecha_entrega), '%Y-%m-%dT%H:%i:%s') entrega
     FROM manifiestos m JOIN clientes c ON c.pk_cliente = m.fk_cliente
     LEFT JOIN entregas_manifiesto_chofer e ON e.fk_manifiesto = m.pk_manifiesto
     WHERE m.pk_manifiesto = ? AND c.fk_usuario = ? AND c.estado = 1 AND m.estado = 1`,
    [manifest, req.user.pk_usuario]);
  if (!header) throw new RequestError('Manifiesto no encontrado.', 404);
  const [items] = await db.execute(
    `SELECT COALESCE(md.descripcion, d.nombre) descripcion, md.cantidad, md.peso
     FROM manifiestos_detalle md LEFT JOIN desechos d ON d.pk_desecho = md.fk_desecho
     WHERE md.fk_manifiesto = ? AND md.estado = 1`, [manifest]);
  return { ...header, items };
}));

router.get('/reportes', requireRole(1), respond(async req => {
  const day = date(req.query.fecha ?? today());
  const [ventas] = await db.execute(
    `SELECT v.folio, c.nombre cliente, v.total, v.total - COALESCE((SELECT SUM(p.importe)
       FROM pagos_chofer p WHERE p.fk_venta = v.pk_venta), 0) saldo
     FROM ventas v JOIN servicios_chofer s ON s.fk_venta = v.pk_venta JOIN clientes c ON c.pk_cliente = v.fk_cliente
     WHERE v.fecha_venta >= ? AND v.fecha_venta < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY v.pk_venta DESC`, [day, day]);
  const [incidencias] = await db.execute(
    `SELECT r.folio, c.nombre cliente, s.motivo
     FROM servicios_chofer s JOIN recolecciones r ON r.pk_recoleccion = s.fk_recoleccion
     JOIN clientes c ON c.pk_cliente = r.fk_cliente
     WHERE s.estado = 'fallida' AND s.cierre >= ? AND s.cierre < DATE_ADD(?, INTERVAL 1 DAY)`, [day, day]);
  const [eventos] = await db.execute(
    `SELECT b.recurso, b.recurso_id, b.accion, u.usuario, DATE_FORMAT(b.fecha, '%H:%i') hora
     FROM bitacora_operacion b JOIN usuarios u ON u.pk_usuario = b.fk_usuario
     WHERE b.fecha >= ? AND b.fecha < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY b.pk_evento DESC LIMIT 100`, [day, day]);
  const metrics = req.app.locals.metrics;
  return { fecha: day, ventas, incidencias, eventos, servidor: {
    solicitudes: metrics.solicitudes, errores: metrics.errores,
    latencia_ms: Math.round(metrics.total_ms / Math.max(1, metrics.solicitudes)),
    uptime_s: Math.floor(process.uptime()), ultima_generacion: metrics.ultima_generacion
  } };
}));

module.exports = router;
