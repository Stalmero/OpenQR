const express = require('express');
const cors = require('cors');
// const { generateSecret, verify } = require('otplib');
const { generateSecret, verify, generate } = require('otplib');
const db = require('./db');
// const ngrok = require("@ngrok/ngrok");
require('dotenv').config();

const app = express();
const DEVICE_SECRET = process.env.DEVICE_SECRET;

let puertaPendiente = false;
let puertaTimestamp = 0;
const VENTANA_VALIDEZ_MS = 8000; // si el ESP32 no la recoge en 8s, se descarta

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// async function forwardToApp() {
//   const forwarder = await ngrok.forward({
//     addr: "localhost:3000",
//     authtoken_from_env: true,
//     domain: "polygraph-spherical-ecosphere.ngrok-free.dev",
//   });
//   console.log(`Available at: ${forwarder.url()}`);
// }

// forwardToApp();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Control de Acceso corriendo en http://localhost:${PORT}`);
});

console.log("DATABASE_URL detectada:", process.env.DATABASE_URL ? "SÍ" : "NO");
console.log("SUPABASE_URL detectada:", process.env.SUPABASE_URL ? "SÍ" : "NO");

// Endpoint de prueba de conexión a Supabase
app.get('/test-db', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.json({ status: 'ok', time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al conectar a Supabase' });
  }
});

// Endpoint para generar un nuevo secreto TOTP a un usuario
app.post('/api/generar-secreto', async (req, res) => {
  const { usuario_id } = req.body;
  try {
    const secret = generateSecret();
    await db.query(
      'UPDATE usuarios SET secret_totp = $1 WHERE id = $2',
      [secret, usuario_id]
    );
    res.json({ status: 'ok', secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar secreto TOTP' });
  }
});

// Endpoint para validar el token enviado desde el Escáner/Lector QR
app.post('/api/validar-qr', async (req, res) => {
  const { usuario_id, token } = req.body;

  try {
    const userResult = await db.query(
      'SELECT secret_totp, nombre FROM usuarios WHERE id = $1',
      [usuario_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ valido: false, mensaje: 'Usuario no encontrado' });
    }

    const { secret_totp, nombre } = userResult.rows[0];

    // Verificar el código TOTP
    const { valid: isValid } = await verify({ token, secret: secret_totp });
    const estatus = isValid ? 'PERMITIDO' : 'DENEGADO';

    await db.query(
      'INSERT INTO registros_acceso (usuario_id, estatus, detalles) VALUES ($1, $2, $3)',
      [usuario_id, estatus, isValid ? 'Acceso correcto por QR' : 'Código expirado o inválido']
    );

    if (isValid) {
      puertaPendiente = true;
      puertaTimestamp = Date.now();
      return res.json({ valido: true, mensaje: `Bienvenido, ${nombre}` });
    } else {
      return res.status(400).json({ valido: false, mensaje: 'Código QR expirado o inválido' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor al validar el acceso' });
  }
});

// Endpoint para obtener los últimos 50 registros de acceso
app.get('/api/registros-acceso', async (req, res) => {
  try {
    const query = `
      SELECT 
        r.id, 
        r.estatus, 
        r.detalles, 
        r.fecha, 
        u.nombre AS usuario_nombre
      FROM registros_acceso r
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      ORDER BY r.fecha DESC
      LIMIT 50;
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar la bitácora de accesos' });
  }
});

// Devuelve el token TOTP vigente sin exponer el secreto
app.get('/api/token-actual/:usuario_id', async (req, res) => {
  const { usuario_id } = req.params;
  try {
    const userResult = await db.query(
      'SELECT secret_totp FROM usuarios WHERE id = $1',
      [usuario_id]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const token = await generate({ secret: userResult.rows[0].secret_totp });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar el token' });
  }
});

app.get('/api/device/status', (req, res) => {
  if (req.query.secret !== DEVICE_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const vigente = puertaPendiente && (Date.now() - puertaTimestamp) < VENTANA_VALIDEZ_MS;
  if (vigente) {
    puertaPendiente = false; // se consume, solo se abre una vez por escaneo
    return res.json({ abrir: true });
  }
  return res.json({ abrir: false });
});
