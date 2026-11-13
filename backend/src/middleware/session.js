const { randomBytes } = require('node:crypto');
const db = require('../config/db');

const sessions = new Map();
const duration = 8 * 60 * 60 * 1000;

function createSession(userId) {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expires <= now) sessions.delete(token);
  }
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: now + duration });
  return token;
}

function authorize(role) {
  return async (req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(token);
      return res.status(401).json({ mensaje: 'Inicia sesión nuevamente.' });
    }
    try {
      const [[user]] = await db.execute(
        `SELECT u.pk_usuario, u.fk_rol FROM usuarios u
         JOIN roles r ON r.pk_rol = u.fk_rol AND r.estado = 1
         WHERE u.pk_usuario = ? AND u.estado = 1`,
        [session.userId]
      );
      if (!user || (role && user.fk_rol !== role)) {
        return res.status(403).json({ mensaje: 'Acceso denegado.' });
      }
      req.user = user;
      req.token = token;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function endSession(req, res) {
  sessions.delete(req.token);
  res.sendStatus(204);
}

module.exports = { createSession, authorize, endSession };
