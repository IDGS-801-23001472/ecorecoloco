const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('../config/db');
const { createSession } = require('../middleware/session');

const derive = promisify(scrypt);

exports.login = async (req, res, next) => {
  const { usuario, pass } = req.body;
  if (typeof usuario !== 'string' || !usuario.trim() || usuario.length > 255 ||
      typeof pass !== 'string' || !pass || pass.length > 1024) {
    return res.status(400).json({ ok: false, mensaje: 'Credenciales inválidas.' });
  }

  try {
    const [[account]] = await db.execute(
      `SELECT u.pk_usuario, u.fk_rol, u.usuario, u.nombre, u.correo, u.estado, u.pass
       FROM usuarios u JOIN roles r ON r.pk_rol = u.fk_rol AND r.estado = 1
       WHERE u.estado = 1 AND (u.usuario = ? OR u.correo = ?)
       ORDER BY (u.usuario = ?) DESC, u.pk_usuario LIMIT 1`,
      [usuario, usuario, usuario]
    );
    let valid = false;
    if (account?.pass?.startsWith('scrypt:')) {
      const [, salt, hash] = account.pass.split(':');
      if (/^[a-f0-9]{32}$/.test(salt) && /^[a-f0-9]{128}$/.test(hash)) {
        valid = timingSafeEqual(await derive(pass, salt, 64), Buffer.from(hash, 'hex'));
      }
    } else if (account?.pass) {
      const expected = Buffer.from(account.pass);
      const received = Buffer.from(pass);
      valid = expected.length === received.length && timingSafeEqual(expected, received);
      if (valid) {
        const salt = randomBytes(16).toString('hex');
        const hash = (await derive(pass, salt, 64)).toString('hex');
        await db.execute('UPDATE usuarios SET pass = ? WHERE pk_usuario = ? AND BINARY pass = ?',
          [`scrypt:${salt}:${hash}`, account.pk_usuario, account.pass]);
      }
    }
    if (!valid) {
      return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos.' });
    }
    const { pass: stored, ...user } = account;
    return res.json({
      ok: true,
      mensaje: 'Inicio de sesión exitoso',
      usuario: user,
      token: createSession(user.pk_usuario)
    });
  } catch (error) {
    next(error);
  }
};
