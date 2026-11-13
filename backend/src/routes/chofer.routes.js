const express = require('express');
const { authorize } = require('../middleware/session');
const service = require('../services/chofer');
const caja = require('../services/chofer-caja');
const { date, id, text, imageType } = require('../services/chofer-domain');

const router = express.Router();
const withUser = handler => (req, res, next) => {
  Promise.resolve().then(() => handler(req.user.pk_usuario, req, res))
    .then(result => { if (result !== undefined) res.json(result); }).catch(next);
};
const day = req => date(req.query.fecha ?? service.today());
const stop = req => id(req.params.id);

router.get('/revision/cortes', authorize(1), withUser((_, req) => caja.listCuts(day(req))));
router.post('/revision/cortes/:id', authorize(1), withUser((user, req) => caja.review(user, stop(req), req.body)));
router.use(authorize(3));

router.get('/catalogos', withUser(() => service.catalog()));
router.get('/paradas', withUser((user, req) => service.list(user, day(req))));
router.get('/paradas/:id', withUser((user, req) => service.detail(user, stop(req))));
router.get('/paradas/:id/historial', withUser((user, req) => service.clientVisits(user, stop(req))));
router.post('/paradas/:id/inicio', withUser((user, req) => service.start(user, stop(req))));
router.post('/paradas/:id/fallida', withUser((user, req) => service.fail(user, stop(req), req.body)));
router.post('/paradas/:id/cotizacion', withUser((user, req) => service.preview(user, stop(req), req.body)));
router.post('/paradas/:id/completar', withUser((user, req) => service.complete(user, stop(req), req.body)));
router.post('/paradas/:id/pagos', withUser((user, req) => service.pay(user, stop(req), req.body)));
router.get('/paradas/:id/manifiesto', withUser((user, req) => service.manifest(user, stop(req))));
router.post('/paradas/:id/manifiesto/entrega', withUser((user, req) => service.deliver(user, stop(req))));
router.get('/manifiestos', withUser((user, req) =>
  service.manifests(user, day(req), text(req.query.folio, 'Folio', 50, false))));
router.get('/paradas/:id/evidencias/:tipo', withUser(async (user, req, res) => {
  const bytes = await service.evidence(user, stop(req), req.params.tipo);
  res.set('Cache-Control', 'private, no-store');
  res.type(imageType(bytes)).send(bytes);
}));
router.get('/ventas', withUser((user, req) =>
  service.history(user, day(req), text(req.query.cliente, 'Cliente', 120, false) ?? '')));
router.post('/viaticos', withUser((user, req) => caja.expense(user, req.body)));
router.get('/turnos/:id/corte', withUser((user, req) => caja.summary(user, stop(req), day(req))));
router.post('/turnos/:id/corte', withUser((user, req) => caja.close(user, stop(req), day(req), req.body)));

module.exports = router;
