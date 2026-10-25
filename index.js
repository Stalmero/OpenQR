const express = require('express');
const cors = require('cors');
const { generateSecret, verify, generate } = require('otplib');
const db = require('./db');
require('dotenv').config();

const app = express();
const DEVICE_SECRET = process.env.DEVICE_SECRET;

let puertaPendiente = false;
let puertaTimestamp = 0;
const VENTANA_VALIDEZ_MS = 8000; // si el ESP32 no la recoge en 8s, se descarta

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// --- MOTOR INTELIGENTE (Sistemas Inteligentes) ---
function evaluarRiesgoAcceso(usuarioId, historialIntentosRecientes) {
    let puntajeRiesgo = 0;
    const ahora = new Date();
    const horaActual = ahora.getHours();

    // Regla 1: Control de horario atípico (Madrugada: 00:00 a 05:00 hrs)
    if (horaActual >= 0 && horaActual < 5) {
        puntajeRiesgo += 40; 
    }

    // Regla 2: Intentos fallidos previos en ventana corta (Anti-Brute Force)
    const fallosRecientes = historialIntentosRecientes.filter(i => i.estatus === 'DENEGADO').length;
    if (fallosRecientes >= 2) {
        puntajeRiesgo += 35 * fallosRecientes; 
    }

    // Regla 3: Frecuencia de acceso anómala (doble marcaje en menos de 10 segundos)
    if (historialIntentosRecientes.length > 0) {
        const ultimoAcceso = new Date(historialIntentosRecientes[0].fecha);
        const segundosDiferencia = (ahora - ultimoAcceso) / 1000;
        if (segundosDiferencia < 10) {
            puntajeRiesgo += 50; // Posible reenvío rápido o clonación
        }
    }

    const esAnomalia = puntajeRiesgo >= 60;
    return {
        puntajeRiesgo: Math.min(puntajeRiesgo, 100),
        esAnomalia,
        motivo: esAnomalia ? "Acceso denegado por patrón de comportamiento anómalo o alto riesgo" : "Acceso normal"
    };
}

// Endpoint para validar el token enviado desde el Escáner/Lector QR
app.post('/api/validar-qr', async (req, res) => {
  const { usuario_id, token } = req.body;

  try {
    // 1. Obtener datos del usuario
    const userResult = await db.query(
      'SELECT secret_totp, nombre FROM usuarios WHERE id = $1',
      [usuario_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ valido: false, mensaje: 'Usuario no encontrado' });
    }

    const { secret_totp, nombre } = userResult.rows[0];

    // 2. Verificar el código TOTP matemáticamente
    const { valid: isValid } = await verify({ token, secret: secret_totp });
    
    if (!isValid) {
      await db.query(
        'INSERT INTO registros_acceso (usuario_id, estatus, detalles) VALUES ($1, $2, $3)',
        [usuario_id, 'DENEGADO', 'Código expirado o inválido']
      );
      return res.status(400).json({ valido: false, mensaje: 'Código QR expirado o inválido' });
    }

    // 3. PROTECCIÓN ANTI-REPLAY: Verificar si este token exacto ya fue consumido recientemente
    const tokenUsadoCheck = await db.query(
      `SELECT id FROM registros_acceso 
       WHERE usuario_id = $1 AND estatus = 'PERMITIDO' 
       AND detalles LIKE $2 AND fecha > NOW() - INTERVAL '30 seconds'`,
      [usuario_id, `%Token usado: ${token}%`]
    );

    if (tokenUsadoCheck.rows.length > 0) {
      await db.query(
        'INSERT INTO registros_acceso (usuario_id, estatus, detalles) VALUES ($1, $2, $3)',
        [usuario_id, 'DENEGADO', 'Intento de reutilización de token (Replay Attack bloqueado)']
      );
      return res.status(403).json({ 
        valido: false, 
        mensaje: 'Acceso denegado: El código QR ya fue utilizado en esta ventana temporal.' 
      });
    }

    // 4. SISTEMAS INTELIGENTES: Consultar historial reciente para análisis heurístico
    const historialRes = await db.query(
      'SELECT estatus, fecha FROM registros_acceso WHERE usuario_id = $1 ORDER BY fecha DESC LIMIT 5',
      [usuario_id]
    );

    // const analisisInteligente = evaluarRiesgoAcceso(usuario_id, historialRes.rows);

    // if (analisisInteligente.esAnomalia) {
    //   await db.query(
    //     'INSERT INTO registros_acceso (usuario_id, estatus, detalles) VALUES ($1, $2, $3)',
    //     [usuario_id, 'DENEGADO', `Bloqueo IA: ${analisisInteligente.motivo} (Riesgo: ${analisisInteligente.puntajeRiesgo}%)`]
    //   );
    //   return res.status(403).json({
    //     valido: false,
    //     mensaje: `Acceso bloqueado por seguridad inteligente: ${analisisInteligente.motivo}`
    //   });
    // }

    // 5. ACCESO EXITOSO
    await db.query(
      'INSERT INTO registros_acceso (usuario_id, estatus, detalles) VALUES ($1, $2, $3)',
      [usuario_id, 'PERMITIDO', `Acceso correcto por QR. Token usado: ${token}`]
    );

    puertaPendiente = true;
    puertaTimestamp = Date.now();
    return res.json({ valido: true, mensaje: `Bienvenido, ${nombre}` });

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

module.exports = app;