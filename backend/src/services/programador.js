const { generate } = require('./operacion-agenda');
const { db, today } = require('./chofer');

function startScheduler(metrics) {
  if (!process.env.GENERACION_USUARIO_ID) return;
  const user = Number(process.env.GENERACION_USUARIO_ID);
  const horizon = Number(process.env.GENERACION_HORIZONTE_DIAS ?? 30);
  if (!Number.isSafeInteger(user) || user < 1 || !Number.isInteger(horizon) || horizon < 1 || horizon > 91) {
    throw new Error('Configuración inválida de generación automática de visitas.');
  }

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const [[actor]] = await db.execute(
        `SELECT u.pk_usuario FROM usuarios u JOIN roles r ON r.pk_rol = u.fk_rol AND r.estado = 1
         WHERE u.pk_usuario = ? AND u.estado = 1 AND u.fk_rol IN (1, 2)`, [user]
      );
      if (!actor) throw new Error('El usuario de generación automática no está activo.');
      const day = today();
      const last = new Date(day);
      last.setUTCDate(last.getUTCDate() + horizon - 1);
      const result = await generate(user, { desde: day, hasta: last.toISOString().slice(0, 10) });
      metrics.ultima_generacion = { fecha: new Date().toISOString(), estado: 'correcta', creadas: result.creadas };
      console.log(`Generación automática ${day}: ${result.creadas} visitas nuevas.`);
    } catch (error) {
      metrics.ultima_generacion = { fecha: new Date().toISOString(), estado: 'error' };
      console.error('Error al generar visitas automáticamente:', error.code || error.message);
    } finally {
      running = false;
    }
  }

  void run();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { startScheduler };
