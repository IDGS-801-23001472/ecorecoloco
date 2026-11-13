const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth.routes');
const choferRoutes = require('./routes/chofer.routes');
const operacionRoutes = require('./routes/operacion.routes');
const { RequestError } = require('./services/chofer-domain');
const { startScheduler } = require('./services/programador');
const db = require('./config/db');

const app = express();
const metrics = { solicitudes: 0, errores: 0, total_ms: 0, ultima_generacion: null };
app.locals.metrics = metrics;

// Middlewares
app.use(cors());
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    metrics.solicitudes++;
    metrics.total_ms += Number(process.hrtime.bigint() - start) / 1e6;
    if (res.statusCode >= 500) metrics.errores++;
  });
  next();
});

// Rutas API
app.use('/api/auth', express.json(), authRoutes);
app.use('/api/v1/chofer', express.json({ limit: '6mb' }), choferRoutes);
app.use('/api/v1/operacion', express.json(), operacionRoutes);

// Ruta de prueba de salud de la API
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mensaje: 'API EcoReco activa y respondiendo' });
});

app.get('/api/ready', async (req, res) => {
  try {
    await db.query('SELECT 1 FROM bitacora_operacion LIMIT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof RequestError) {
    return res.status(error.status).json({ mensaje: error.message });
  }
  if (error.status === 413) return res.status(413).json({ mensaje: 'La solicitud es demasiado grande.' });
  if (error.status === 400) return res.status(400).json({ mensaje: 'Solicitud inválida.' });
  console.error(error);
  return res.status(500).json({ mensaje: 'Error interno de la API.' });
});

const PORT = process.env.PORT || 3000;
startScheduler(metrics);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ejecutándose en http://0.0.0.0:${PORT}`);
});
