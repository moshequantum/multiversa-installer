/* ═══════════════════════════════════════════════════════════════════════
   Multiversa Project OS Installer · lógica de la interfaz

   Regla que gobierna este archivo: **nunca afirmar algo que no ocurrió.**

   El progreso solo avanza con eventos que emite el backend cuando un comando
   real termina, y cualquier fallo detiene la secuencia. Los secretos que el
   usuario introduce en Conexiones se guardan delegando en el CLI
   (`multiversa tenant set-secret`, valor por stdin) — este archivo nunca los
   escribe en disco ni los registra.
   ═══════════════════════════════════════════════════════════════════════ */

const tauri = window.__TAURI__ ?? null;
const invoke = tauri?.core?.invoke ?? null;
const listen = tauri?.event?.listen ?? null;

const $ = (id) => document.getElementById(id);

/* ─────────────────────────── Estado ─────────────────────────── */

const TOTAL_STEPS = 7;

const state = {
  step: 1,
  scanned: null,        // informe de detect, o null si aún no se leyó
  cliAvailable: false,
  installing: false,
  createdDir: '',
};

/* ─────────────────────────── Navegación ─────────────────────────── */

function goToStep(n) {
  if (n < 1 || n > TOTAL_STEPS || n === state.step) return;

  const current = $(`view${state.step}`);
  const next = $(`view${n}`);

  current.classList.remove('is-active');
  current.hidden = true;
  next.hidden = false;
  next.classList.remove('is-active');
  void next.offsetWidth;             // reinicia la animación de entrada
  next.classList.add('is-active');

  state.step = n;
  paintSteps();

  // El foco viaja al encabezado para quien navega con teclado o lector de
  // pantalla; si no, se quedaría en el botón anterior.
  const heading = next.querySelector('.display');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  next.querySelector('.view__body').scrollTop = 0;

  if (n === 2 && state.scanned === null) runScan();
  if (n === 5) paintReview();
  speakStep(n);
}

function paintSteps() {
  document.querySelectorAll('.step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('is-current', n === state.step);
    el.classList.toggle('is-done', n < state.step);
    if (n === state.step) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
}

/* ─────────────────────────── Paso 2 · Escaneo ─────────────────────────── */

async function runScan() {
  const box = $('scan');
  const next = $('next2');
  const rescan = $('rescan');

  next.disabled = true;
  rescan.hidden = true;
  box.innerHTML = `
    <div class="scan__loading">
      <span class="spinner" aria-hidden="true"></span>
      <span>Leyendo tu sistema…</span>
    </div>`;

  if (!invoke) {
    state.scanned = null;
    box.innerHTML = notice(
      'Vista previa sin acceso al sistema',
      'Esta ventana no está corriendo dentro de la aplicación, así que no puede leer tu equipo. La instalación real no está disponible aquí.',
      true,
    );
    rescan.hidden = false;
    return;
  }

  try {
    state.cliAvailable = await invoke('cli_available');
    if (!state.cliAvailable) {
      state.scanned = null;
      box.innerHTML = notice(
        'Falta el CLI de Multiversa',
        'El instalador visual es una capa sobre el CLI, no un reemplazo. Instálalo primero y vuelve a leer.',
        true,
        'curl -fsSL https://multiversa.group/install.sh | sh',
      );
      rescan.hidden = false;
      return;
    }

    const report = await invoke('check_prerequisites');
    state.scanned = report;
    box.innerHTML = renderScan(report);
    next.disabled = false;
    rescan.hidden = false;
  } catch (err) {
    state.scanned = null;
    box.innerHTML = notice('No se pudo leer el sistema', String(err), true);
    rescan.hidden = false;
  }
}

function renderScan(report) {
  const tools = Array.isArray(report.tools) ? report.tools : [];
  const engines = report.multiversa?.engines ?? [];
  const core = engines.filter((e) => !e.opt_in);

  const os = report.os
    ? `<p class="help">${escapeHtml(report.os.version ?? report.os.kind ?? '')} · ${escapeHtml(report.os.arch ?? '')}</p>`
    : '';

  return `
    ${os}
    <div class="scan__group">
      <h2 class="scan__title">Herramientas del sistema</h2>
      <ul class="tools">${tools.map(toolRow).join('')}</ul>
    </div>
    <div class="scan__group">
      <h2 class="scan__title">Motores detectados por Multiversa</h2>
      <ul class="tools">${core.map(engineRow).join('')}</ul>
      <p class="help">
        Lo que falte se instala en el paso siguiente. No necesitas Homebrew:
        hay más de una forma de instalar cada motor y se elige la que sirva
        en tu equipo.
      </p>
    </div>`;
}

function toolRow(t) {
  const st = t.installed ? 'ok' : 'missing';
  return `<li class="tool" data-state="${st}">
    <span class="tool__dot" aria-hidden="true"></span>
    <span class="tool__name">${escapeHtml(t.name)}</span>
    <span class="tool__ver">${escapeHtml(t.installed ? shortVersion(t.version) : 'no está')}</span>
  </li>`;
}

function engineRow(e) {
  const st = e.installed ? 'ok' : 'missing';
  return `<li class="tool" data-state="${st}">
    <span class="tool__dot" aria-hidden="true"></span>
    <span class="tool__name">${escapeHtml(e.name ?? e.id)}</span>
    <span class="tool__ver">${escapeHtml(e.installed ? shortVersion(e.version) : 'pendiente')}</span>
  </li>`;
}

function shortVersion(v) {
  if (!v) return 'ok';
  const m = String(v).match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : String(v).split(/\s+/)[0];
}

function notice(title, body, isError, code) {
  return `<div class="notice${isError ? ' notice--error' : ''}">
    <p class="notice__title">${escapeHtml(title)}</p>
    <p class="notice__body">${escapeHtml(body)}${code ? `<code>${escapeHtml(code)}</code>` : ''}</p>
  </div>`;
}

/* ─────────────────────────── Paso 3 · ADN ─────────────────────────── */

/* Refleja internal/tenant.slugifyPillar del CLI: los acentos se pliegan a su
   letra ASCII en vez de convertirse en separador. "Operación" → "operacion". */
const FOLD = {
  á:'a', à:'a', ä:'a', â:'a', ã:'a', å:'a',
  é:'e', è:'e', ë:'e', ê:'e',
  í:'i', ì:'i', ï:'i', î:'i',
  ó:'o', ò:'o', ö:'o', ô:'o', õ:'o',
  ú:'u', ù:'u', ü:'u', û:'u',
  ñ:'n', ç:'c', ý:'y', ÿ:'y',
};

/* El CLI valida ^[a-z0-9][a-z0-9-]{1,62}$ — máximo 63. Se recorta aquí para
   que un nombre largo nunca produzca un error evitable, cortando en el guion
   anterior para no partir una palabra. */
const SLUG_MAX = 63;

function slugify(text) {
  const raw = [...text.toLowerCase()]
    .map((ch) => FOLD[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (raw.length <= SLUG_MAX) return raw;
  const cut = raw.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

let slugEdited = false;

function setupDnaForm() {
  const name = $('tName');
  const slug = $('tSlug');

  name.addEventListener('input', () => {
    if (!slugEdited) slug.value = slugify(name.value);
  });
  slug.addEventListener('input', () => { slugEdited = true; });

  name.addEventListener('blur', () => validateName());
  slug.addEventListener('blur', () => validateSlug());

  $('addPillar').addEventListener('click', () => addPillar('', ''));

  // Dos pilares vacíos de arranque: sugieren la forma sin imponer contenido.
  addPillar('', '');
  addPillar('', '');
}

function addPillar(name, metric) {
  const row = document.createElement('div');
  row.className = 'pillar';
  row.innerHTML = `
    <input type="text" class="pillar__name" placeholder="Nombre del pilar" aria-label="Nombre del pilar">
    <input type="text" class="pillar__metric" placeholder="Cómo lo mides" aria-label="Métrica del pilar">
    <button type="button" class="pillar__drop" aria-label="Quitar este pilar">&times;</button>`;
  row.querySelector('.pillar__name').value = name;
  row.querySelector('.pillar__metric').value = metric;
  row.querySelector('.pillar__drop').addEventListener('click', () => row.remove());
  $('pillars').appendChild(row);
}

function readPillars() {
  return [...document.querySelectorAll('.pillar')]
    .map((row) => ({
      name: row.querySelector('.pillar__name').value.trim(),
      metric: row.querySelector('.pillar__metric').value.trim(),
    }))
    .filter((p) => p.name !== '');
}

function showError(input, errEl, message) {
  if (message) {
    errEl.textContent = message;
    errEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    return false;
  }
  errEl.hidden = true;
  input.removeAttribute('aria-invalid');
  return true;
}

function validateName() {
  const input = $('tName');
  return showError(input, $('tNameErr'),
    input.value.trim() === '' ? 'Ponle un nombre a tu sistema.' : '');
}

function validateSlug() {
  const input = $('tSlug');
  const value = input.value.trim();
  let msg = '';
  if (value === '') msg = 'Hace falta un identificador.';
  else if (value.length < 2) msg = 'Necesita al menos dos caracteres.';
  else if (value.length > SLUG_MAX) msg = `Máximo ${SLUG_MAX} caracteres (tiene ${value.length}).`;
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    msg = 'Solo minúsculas, números y guiones, empezando por letra o número.';
  }
  return showError(input, $('tSlugErr'), msg);
}

/* ─────────────────────────── Paso 4 · Conexiones ─────────────────────────── */

/* Cada conexión conocida se mapea a un nombre de variable de entorno, que es la
   clave con la que se guarda en el vault. Los valores vacíos se descartan. */
function readSecrets() {
  const raw = [
    { key: 'ELEVENLABS_API_KEY',    value: $('connElevenKey').value,  label: 'Voz (ElevenLabs)' },
    { key: 'INSFORGE_API_KEY',      value: $('connInsforgeKey').value, label: 'InsForge · clave' },
    { key: 'INSFORGE_API_BASE_URL', value: $('connInsforgeUrl').value, label: 'InsForge · URL' },
  ];
  return raw
    .map((s) => ({ ...s, value: s.value.trim() }))
    .filter((s) => s.value !== '');
}

/* ─────────────────────────── Paso 5 · Revisión ─────────────────────────── */

const KIND_LABEL = {
  'project-os': 'Project OS único',
};

function currentKind() {
  return document.querySelector('input[name="kind"]:checked')?.value ?? 'project-os';
}

function paintReview() {
  const name = $('tName').value.trim();
  const slug = $('tSlug').value.trim();
  const pillars = readPillars();
  const secrets = readSecrets();

  const pillarList = pillars.length
    ? pillars.map((p) => `${escapeHtml(p.name)}${p.metric ? ` <span class="muted">${escapeHtml(p.metric)}</span>` : ''}`).join('')
    : '<span class="muted">Se usarán los de la plantilla.</span>';

  // Solo los NOMBRES de las conexiones, nunca los valores.
  const connList = secrets.length
    ? secrets.map((s) => escapeHtml(s.label)).join('<span class="muted"> · </span>')
    : '<span class="muted">Ninguna. Puedes añadirlas después.</span>';

  $('review').innerHTML = `
    <dt>Nombre</dt><dd>${escapeHtml(name)}</dd>
    <dt>Carpeta</dt><dd>~/.multiversa/tenants/${escapeHtml(slug)}/</dd>
    <dt>Perfil</dt><dd>${escapeHtml(KIND_LABEL[currentKind()])}</dd>
    <dt>Pilares</dt><dd>${pillarList}</dd>
    <dt>Conexiones</dt><dd>${connList}</dd>
    <dt>Se creará</dt><dd>
      El manifiesto <code>multiversa.toml</code> con tu ADN
      <span class="muted">y una bóveda con permisos 0700 que Multiversa no serializa.</span>
    </dd>
    <dt>No se hará</dt><dd>
      Nada se sube a internet
      <span class="muted">y ningún archivo existente se sobrescribe.</span>
    </dd>`;
}

/* ─────────────────────────── Paso 6 · Instalación ─────────────────────────── */

function log(text, kind) {
  const el = $('console');
  const tag = kind === 'ok' ? 'b' : kind === 'error' ? 'i' : 'span';
  el.insertAdjacentHTML('beforeend', `<${tag}>${escapeHtml(text)}</${tag}>\n`);
  el.scrollTop = el.scrollHeight;
}

function setProgress(completed, total) {
  const fill = $('progressFill');
  const track = $('progressBar');
  fill.style.transform = `scaleX(${total ? completed / total : 0})`;
  track.setAttribute('aria-valuenow', String(completed));
  track.setAttribute('aria-valuemax', String(total));
  $('progressCount').textContent = `${completed} / ${total}`;
}

async function runInstall() {
  if (state.installing) return;
  state.installing = true;

  goToStep(6);
  $('console').innerHTML = '';
  $('next6').disabled = true;
  $('retry').hidden = true;
  $('installNote').textContent = '';
  $('progressBar').removeAttribute('data-state');

  const secrets = readSecrets();
  setProgress(0, secrets.length ? 3 : 2);
  $('progressLabel').textContent = 'Creando tu perfil…';

  if (!invoke) {
    $('progressLabel').textContent = 'No disponible en vista previa';
    $('progressBar').dataset.state = 'error';
    log('Esta ventana no corre dentro de la aplicación: no se escribió nada.', 'error');
    $('installNote').textContent = 'Abre el instalador como aplicación para crear tu sistema.';
    state.installing = false;
    return;
  }

  try {
    const created = await invoke('create_tenant', {
      slug: $('tSlug').value.trim(),
      name: $('tName').value.trim(),
      kind: currentKind(),
      pillars: readPillars(),
      // Solo key + value viajan al backend; el label es de UI.
      secrets: secrets.map(({ key, value }) => ({ key, value })),
    });

    state.createdDir = created?.data?.dir ?? '';
    $('progressLabel').textContent = 'Listo';
    $('next6').disabled = false;
    paintDone();
  } catch (err) {
    $('progressLabel').textContent = 'No se pudo completar';
    $('progressBar').dataset.state = 'error';
    log(String(err), 'error');
    $('installNote').textContent = 'No se escribió nada a medias: el perfil no quedó creado.';
    $('retry').hidden = false;
  } finally {
    state.installing = false;
  }
}

function paintDone() {
  const name = $('tName').value.trim();
  $('doneLede').textContent = state.createdDir
    ? `«${name}» quedó creado en ${state.createdDir} y es tu perfil activo.`
    : `«${name}» quedó creado y es tu perfil activo.`;
}

/* ─────────────────────────── Voz ─────────────────────────── */

const LINES = {
  1: 'Bienvenido. Vamos a crear tu propio sistema operativo en esta máquina. Todo se queda aquí, y tú decides cada paso.',
  2: 'Primero leo qué hay en tu equipo. No instalo nada todavía.',
  3: 'Ahora lo importante: tu ADN. Cómo se llama tu sistema y qué mueve de verdad tu negocio.',
  4: 'Si tu sistema usa algún servicio, pon aquí sus claves. Se guardan en tu bóveda y nunca salen de esta máquina. Es opcional.',
  5: 'Esto es exactamente lo que voy a hacer. Revísalo antes de confirmar.',
  6: 'Creando tu perfil.',
  7: 'Tu sistema ya existe. Te dejo tres cosas que puedes hacer ahora.',
};

const voice = { on: false, key: '', id: 'EXAVITQu4vr4xnSDxMaL', audio: null };

function setupVoice() {
  const toggle = $('voiceToggle');
  const config = $('voiceConfig');
  const stateEl = $('voiceState');

  toggle.addEventListener('change', (e) => {
    voice.on = e.target.checked;
    config.hidden = !voice.on;
    stateEl.textContent = voice.on ? 'Activada' : 'Desactivada';
    stateEl.dataset.on = String(voice.on);
    if (!voice.on) stopVoice();
    else speakStep(state.step);
  });

  $('voiceKey').addEventListener('input', (e) => { voice.key = e.target.value.trim(); });
  $('voicePick').addEventListener('change', (e) => { voice.id = e.target.value; });
}

function stopVoice() {
  if (voice.audio) { voice.audio.pause(); voice.audio = null; }
  window.speechSynthesis?.cancel();
}

async function speakStep(n) {
  if (!voice.on) return;
  const text = LINES[n];
  if (!text) return;
  stopVoice();

  if (voice.key && invoke) {
    try {
      const dataUrl = await invoke('tts_elevenlabs', {
        apiKey: voice.key, voiceId: voice.id, text,
      });
      voice.audio = new Audio(dataUrl);
      await voice.audio.play();
      return;
    } catch {
      /* cae al sintetizador del sistema */
    }
  }

  if (window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'es-ES';
    utter.rate = 1.02;
    window.speechSynthesis.speak(utter);
  }
}

/* ─────────────────────────── Utilidades ─────────────────────────── */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ─────────────────────────── Arranque ─────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  setupDnaForm();
  setupVoice();
  paintSteps();

  document.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Salir del ADN (paso 3) exige un formulario válido; retroceder nunca
      // se bloquea.
      if (btn.id === 'next3') {
        const okName = validateName();
        const okSlug = validateSlug();
        if (!okName || !okSlug) {
          (okName ? $('tSlug') : $('tName')).focus();
          return;
        }
      }
      goToStep(Number(btn.dataset.go));
    });
  });

  $('rescan').addEventListener('click', runScan);
  $('confirm').addEventListener('click', runInstall);
  $('retry').addEventListener('click', runInstall);
  $('finish').addEventListener('click', () => {
    stopVoice();
    tauri?.window?.getCurrentWindow?.().close();
  });

  // El progreso lo dicta el backend: un evento por cada paso real que termina.
  listen?.('install-progress', ({ payload }) => {
    setProgress(payload.completed, payload.total);
    log(payload.message, payload.status === 'error' ? 'error'
      : payload.status === 'done' ? 'ok' : null);
    if (payload.status !== 'error') $('progressLabel').textContent = payload.message;
  });

  // Escape cierra la ventana solo si no hay trabajo en curso.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !state.installing) {
      tauri?.window?.getCurrentWindow?.().close();
    }
  });
});
