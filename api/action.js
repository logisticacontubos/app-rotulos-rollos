// =====================================================================
// App Rótulos Rollos Tecnipapel — backend (Vercel serverless)
// Lee/escribe directo en Google Sheets con cuenta de servicio.
// Variables de entorno en Vercel:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID
// Hojas requeridas en el Sheet: "Usuarios" y "Rollos" (ver encabezados abajo)
// =====================================================================
const crypto = require('crypto');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Primer número de par. Los rollos salen como 90001-1 / 90001-2, 90002-1 / ...
const CONSECUTIVO_INICIAL = 90001;

const TIPOS = {
  GLAZE:    { material: 'CONFLEX GLAZE',    gramaje: 70 },
  GLAZE_PS: { material: 'CONFLEX GLAZE PS', gramaje: 50 }
};

// Hoja "Rollos" — columnas A..T (fila 1 = encabezados)
// ID_Par | Fecha | Hora | Registrado_Por | Tipo | Material | Gramaje | Pedido | Reel |
// Ancho_mm | Peso_Total_kg | Peso_Rollo_kg | Rollo_1 | Rollo_2 | QR_1 | QR_2 |
// Estado | Fecha_Impresion | Impreso_Por | Veces_Impreso
const CLAVES = ['id', 'fecha', 'hora', 'registradoPor', 'tipo', 'material', 'gramaje', 'pedido', 'reel',
  'ancho', 'pesoTotal', 'pesoRollo', 'rollo1', 'rollo2', 'qr1', 'qr2',
  'estado', 'fechaImpresion', 'impresoPor', 'vecesImpreso'];

// ---------------------------------------------------------------------
// Autenticación Google (JWT firmado con la llave de la cuenta de servicio)
// ---------------------------------------------------------------------
let tokenCache = { token: null, exp: 0 };

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function obtenerToken() {
  const ahoraSeg = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > ahoraSeg) return tokenCache.token;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: ahoraSeg,
    exp: ahoraSeg + 3600
  }));
  const firmador = crypto.createSign('RSA-SHA256');
  firmador.update(header + '.' + claim);
  const firma = firmador.sign(SA_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: header + '.' + claim + '.' + firma
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Error autenticando con Google: ' + (j.error_description || j.error || r.status));
  tokenCache = { token: j.access_token, exp: ahoraSeg + (j.expires_in || 3600) };
  return j.access_token;
}

async function sheets(ruta, opciones = {}) {
  const token = await obtenerToken();
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + ruta, {
    ...opciones,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Error en Google Sheets: ' + ((j.error && j.error.message) || r.status));
  return j;
}

async function leer(rango) {
  const j = await sheets('/values/' + encodeURIComponent(rango));
  return j.values || [];
}

function agregarFilas(rango, filas) {
  return sheets('/values/' + encodeURIComponent(rango) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ values: filas })
  });
}

function actualizarRangos(data) {
  return sheets('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function ahoraBogota() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const p = (t) => (partes.find((x) => x.type === t) || {}).value;
  return { fecha: `${p('year')}-${p('month')}-${p('day')}`, hora: `${p('hour')}:${p('minute')}` };
}

function aObjeto(fila, numeroFila) {
  const o = {};
  CLAVES.forEach((k, i) => { o[k] = fila[i] !== undefined ? fila[i] : ''; });
  o.vecesImpreso = Number(o.vecesImpreso) || 0;
  o.fila = numeroFila;
  return o;
}

function numero(valor) {
  if (valor === null || valor === undefined) return NaN;
  return Number(String(valor).trim().replace(',', '.'));
}

// ---------------------------------------------------------------------
// Usuarios — hoja "Usuarios": PIN | Nombre | Rol | Activo
// Todos los usuarios activos pueden registrar e imprimir (el rol no restringe)
// ---------------------------------------------------------------------
async function validarUsuario(pin) {
  if (!pin) throw new Error('Sesión vencida. Ingresa tu PIN de nuevo.');
  const filas = await leer('Usuarios!A2:D');
  const f = filas.find((r) =>
    String(r[0] || '').trim() === String(pin).trim() &&
    String(r[3] || 'SI').trim().toUpperCase() !== 'NO'
  );
  if (!f) throw new Error('PIN incorrecto');
  return { nombre: String(f[1] || '').trim(), rol: String(f[2] || 'bodega').trim().toLowerCase() };
}

// ---------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------
async function registrar(usuario, d) {
  const tipo = TIPOS[d.tipo];
  if (!tipo) throw new Error('Selecciona el tipo de rollo.');

  const pedido = String(d.pedido || '').trim();
  if (!/^\d{5,8}(-\d{1,2})?$/.test(pedido)) throw new Error('Pedido inválido. Ej: 5076002 o 5076002-01');

  const reelTxt = String(d.reel || '').trim();
  if (!/^\d{1,5}$/.test(reelTxt)) throw new Error('Reel inválido. Ej: 0003');
  const reel = reelTxt.padStart(4, '0');

  const ancho = numero(d.ancho);
  if (!(ancho >= 100 && ancho <= 3000)) throw new Error('Ancho inválido (entre 100 y 3000 mm).');

  const pesoTotal = numero(d.pesoTotal);
  if (!(pesoTotal >= 100 && pesoTotal <= 1500)) throw new Error('Peso total inválido (entre 100 y 1500 kg).');

  const filas = await leer('Rollos!A2:T');

  // ¿Este rollo padre (pedido + reel) ya se registró?
  if (!d.forzar) {
    const pedidoBase = pedido.split('-')[0];
    const dup = filas.find((r) =>
      String(r[7] || '').split('-')[0] === pedidoBase &&
      String(r[8] || '').padStart(4, '0') === reel
    );
    if (dup) return { duplicado: { id: dup[0], fecha: dup[1], hora: dup[2], por: dup[3] } };
  }

  // Siguiente consecutivo
  let max = CONSECUTIVO_INICIAL - 1;
  filas.forEach((r) => {
    const n = parseInt(r[0], 10);
    if (!isNaN(n) && n > max) max = n;
  });
  const id = max + 1;

  const pesoRollo = Math.round((pesoTotal / 2) * 10) / 10;
  const gramos = Math.round(pesoRollo * 1000); // la app de trazabilidad divide entre 1000
  const rollo1 = id + '-1';
  const rollo2 = id + '-2';
  const { fecha, hora } = ahoraBogota();

  const fila = [
    String(id), fecha, hora, usuario.nombre, d.tipo, tipo.material, tipo.gramaje, pedido, reel,
    ancho, pesoTotal, pesoRollo, rollo1, rollo2,
    rollo1 + '#' + gramos, rollo2 + '#' + gramos,
    'PENDIENTE', '', '', 0
  ];
  await agregarFilas('Rollos!A:T', [fila]);
  return { par: aObjeto(fila, null) };
}

async function historial() {
  const filas = await leer('Rollos!A2:T');
  const pares = filas
    .map((r, i) => aObjeto(r, i + 2))
    .filter((p) => p.id)
    .reverse()
    .slice(0, 500);
  return { pares };
}

async function marcarImpreso(usuario, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('No hay rótulos seleccionados.');
  const filas = await leer('Rollos!A2:T');
  const { fecha, hora } = ahoraBogota();
  const data = [];
  ids.forEach((id) => {
    const idx = filas.findIndex((r) => String(r[0]) === String(id));
    if (idx === -1) return;
    const n = idx + 2;
    const veces = (Number(filas[idx][19]) || 0) + 1;
    data.push({ range: `Rollos!Q${n}:T${n}`, values: [['IMPRESO', fecha + ' ' + hora, usuario.nombre, veces]] });
  });
  if (!data.length) throw new Error('No se encontraron los registros.');
  await actualizarRangos(data);
  return { actualizados: data.length };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });

  try {
    if (!SHEET_ID || !SA_EMAIL || !SA_KEY) throw new Error('Faltan variables de entorno en Vercel.');

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { action, pin, data } = body;

    const usuario = await validarUsuario(pin);
    let resultado;

    switch (action) {
      case 'login':         resultado = { usuario }; break;
      case 'registrar':     resultado = await registrar(usuario, data || {}); break;
      case 'historial':     resultado = await historial(); break;
      case 'marcarImpreso': resultado = await marcarImpreso(usuario, (data || {}).ids); break;
      default: throw new Error('Acción desconocida: ' + action);
    }

    return res.status(200).json({ ok: true, ...resultado });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message || 'Error inesperado' });
  }
};
