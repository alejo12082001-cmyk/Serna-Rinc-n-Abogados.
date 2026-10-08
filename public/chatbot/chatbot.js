/* =========================================================
   Asistente virtual · Serna-Rincón Abogados
   · Historial solo en memoria (se pierde al recargar la página).
   · Al servidor se envían como máximo los últimos 10 turnos.
   · Las respuestas se pintan con nodos DOM (textContent), nunca con innerHTML.
   ========================================================= */
(() => {
  'use strict';
  if (window.__srChatLoaded) return;
  window.__srChatLoaded = true;

  /* ---------- Configuración ---------- */
  // La versión de archivo único (Serna-Rincon-Abogados-con-chat.html) define estas dos variables antes de cargar el widget.
  const ENDPOINT = window.SR_CHAT_ENDPOINT || '/api/chat';
  const PRIVACY_URL = window.SR_PRIVACY_URL || '/politica-de-tratamiento-de-datos.html';
  const MAX_CHARS = 1000;
  const MAX_TURNS_SENT = 10;
  const MAX_USER_TURNS = 20;        // el servidor admite unos pocos más (MAX_USER_TURNS_PER_SESSION) para cubrir reintentos
  const SUGGESTIONS = [
    '¿Qué áreas de práctica atienden?',
    '¿Cómo puedo agendar una consulta?',
    '¿Cómo trabaja la firma?',
    '¿Qué tipo de asesoría necesito para una sucesión?',
  ];
  const GREETING = 'Bienvenido a Serna-Rincón Abogados. Puedo informarle sobre nuestras áreas de práctica, nuestra forma de trabajar y cómo agendar una consulta. ¿En qué puedo orientarle?';
  const ERR_NETWORK = 'No fue posible obtener una respuesta. Revise su conexión e intente de nuevo.';
  const ERR_GENERIC = 'El asistente no está disponible en este momento. Intente más tarde o contáctenos por teléfono, WhatsApp o correo.';
  const ERR_LIMIT = 'Se alcanzó el límite de mensajes de esta conversación. Para continuar, contáctenos al +57 315 609 9876 o en sernarincon@gmail.com, o borre la conversación para empezar de nuevo.';

  /* ---------- Estado (solo memoria) ---------- */
  let history = [];               // [{ role: 'user'|'model', text }]
  let userTurns = 0;
  let sessionId = newId();
  let busy = false;
  let controller = null;
  let lastFocus = null;

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- Utilidades DOM ---------- */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function icon(paths, extra) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    if (extra) extra(svg);
    return svg;
  }

  /* ---------- Formato seguro del texto del modelo ----------
     Admite párrafos, listas con "-", "*" o "1." y **negritas**.
     El correo y el teléfono de la firma se convierten en enlaces. Todo lo demás es texto plano. */
  const LINK_RE = /(sernarincon@gmail\.com|\+57 ?315 ?609 ?9876|\b123\b)/g;
  function inline(parent, text) {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    for (const part of parts) {
      if (!part) continue;
      if (/^\*\*[^*]+\*\*$/.test(part)) { parent.append(h('strong', { text: part.slice(2, -2) })); continue; }
      let last = 0;
      for (const m of part.matchAll(LINK_RE)) {
        if (m.index > last) parent.append(document.createTextNode(part.slice(last, m.index)));
        const v = m[0];
        const href = v.includes('@') ? 'mailto:' + v : 'tel:' + v.replace(/\s/g, '');
        parent.append(h('a', { href, text: v }));
        last = m.index + v.length;
      }
      if (last < part.length) parent.append(document.createTextNode(part.slice(last)));
    }
  }
  function renderRich(container, text) {
    container.replaceChildren();
    const lines = text.replace(/\r/g, '').split('\n');
    let list = null, para = null;
    for (const raw of lines) {
      const line = raw.trim();
      const ul = line.match(/^[-*•]\s+(.*)$/);
      const ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (!line) { list = null; para = null; continue; }
      if (ul || ol) {
        const type = ul ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== type) { list = h(type); container.append(list); }
        const li = h('li'); inline(li, (ul || ol)[1]); list.append(li);
        para = null;
      } else {
        list = null;
        const clean = line.replace(/^#{1,6}\s+/, '');
        if (para) { para.append(h('br')); inline(para, clean); }
        else { para = h('p'); inline(para, clean); container.append(para); }
      }
    }
  }

  /* ---------- Construcción de la interfaz ---------- */
  const root = h('div', { class: 'src' });

  const launcher = h('button', {
    class: 'src-launcher', type: 'button',
    'aria-label': 'Abrir el asistente virtual', 'aria-expanded': 'false', 'aria-controls': 'src-panel',
    onclick: () => (panel.classList.contains('is-open') ? close() : open()),
  }, icon(['M4 5.5h16v10H9.5L5.5 19v-3.5H4z'], svg => {
    for (const cx of [9, 12, 15]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', '10.5'); c.setAttribute('r', '1');
      c.setAttribute('class', 'src-dot');
      svg.append(c);
    }
  }));

  const btnClear = h('button', { class: 'src-icon', type: 'button', 'aria-label': 'Borrar la conversación', title: 'Borrar la conversación', onclick: clearChat },
    icon(['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5.5', 'M14 11v5.5']));
  const btnClose = h('button', { class: 'src-icon', type: 'button', 'aria-label': 'Cerrar el asistente', title: 'Cerrar', onclick: close },
    icon(['M6 6l12 12', 'M18 6L6 18']));

  const log = h('div', { class: 'src-log', role: 'log', 'aria-label': 'Conversación con el asistente', tabindex: '0' });
  const live = h('div', { class: 'src-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });

  const input = h('textarea', {
    class: 'src-input', id: 'src-input', rows: '1', maxlength: String(MAX_CHARS),
    placeholder: 'Escriba su pregunta…', 'aria-describedby': 'src-count src-hint', autocomplete: 'off',
  });
  const count = h('span', { class: 'src-count', id: 'src-count', 'aria-live': 'off', text: `0 / ${MAX_CHARS}` });
  const send = h('button', { class: 'src-send', type: 'submit', 'aria-label': 'Enviar mensaje', disabled: true },
    icon(['M3 12h15', 'M13 6l6 6-6 6']));
  const form = h('form', { class: 'src-form', novalidate: true, onsubmit: e => { e.preventDefault(); submit(input.value); } },
    h('label', { class: 'src-sr', for: 'src-input', text: 'Su pregunta' }),
    h('div', { class: 'src-row' }, input, send),
    h('div', { class: 'src-meta' },
      h('span', { id: 'src-hint', text: 'Enter para enviar · Mayús + Enter para nueva línea' }),
      count));

  const panel = h('section', {
    class: 'src-panel', id: 'src-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'src-title', 'aria-hidden': 'true',
  },
    h('header', { class: 'src-head' },
      h('div', { class: 'src-head__t' },
        h('span', { class: 'src-head__l', text: 'Serna-Rincón Abogados' }),
        h('h2', { id: 'src-title', text: 'Asistente virtual' })),
      btnClear, btnClose),
    log, live, form);
  panel.inert = true;

  root.append(panel, launcher);
  document.body.append(root);
  document.documentElement.classList.add('src-ready');

  /* ---------- Bienvenida ---------- */
  function welcome() {
    log.replaceChildren();
    const privacy = h('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener', text: 'Política de tratamiento de datos personales' });
    log.append(h('p', { class: 'src-notice' },
      h('strong', { text: 'Asistente automatizado con inteligencia artificial.' }),
      ' La información es general, no constituye asesoría jurídica ni crea una relación abogado-cliente. No comparta datos personales sensibles ni detalles confidenciales de su caso. ',
      privacy, '.'));
    const greet = h('div', { class: 'src-msg src-msg--bot' });
    renderRich(greet, GREETING);
    log.append(greet);
    const list = h('ul', { class: 'src-sugg', 'aria-label': 'Preguntas sugeridas' });
    for (const q of SUGGESTIONS) list.append(h('li', null, h('button', { class: 'src-chip', type: 'button', text: q, onclick: () => submit(q) })));
    log.append(list);
  }
  welcome();

  /* ---------- Abrir / cerrar / foco ---------- */
  function open() {
    lastFocus = document.activeElement;
    panel.inert = false;
    panel.setAttribute('aria-hidden', 'false');
    panel.classList.add('is-open');
    document.documentElement.classList.add('src-open');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Cerrar el asistente virtual');
    requestAnimationFrame(() => (input.disabled ? btnClose : input).focus());
  }
  function close() {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.documentElement.classList.remove('src-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Abrir el asistente virtual');
    (lastFocus && document.contains(lastFocus) && lastFocus !== document.body ? lastFocus : launcher).focus();
  }
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll('button, [href], textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------- Entrada de texto ---------- */
  function syncInput() {
    const n = input.value.length;
    count.textContent = `${n} / ${MAX_CHARS}`;
    count.classList.toggle('is-over', n >= MAX_CHARS);
    send.disabled = busy || !input.value.trim() || userTurns >= MAX_USER_TURNS;
    input.style.height = '';
    if (input.value && input.offsetParent) input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  }
  input.addEventListener('input', syncInput);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); }
  });

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  /* ---------- Envío ---------- */
  function submit(raw) {
    const text = (raw || '').trim();
    if (!text || busy) return;
    if (text.length > MAX_CHARS) { announce(`El mensaje supera el límite de ${MAX_CHARS} caracteres.`); return; }
    if (userTurns >= MAX_USER_TURNS) { showError(ERR_LIMIT, false); return; }
    const sugg = log.querySelector('.src-sugg');
    if (sugg) sugg.remove();
    clearErrors();
    if (history.length && history[history.length - 1].role === 'user') history.pop();   // mensaje anterior sin respuesta
    history.push({ role: 'user', text });
    userTurns++;
    log.append(h('div', { class: 'src-msg src-msg--user' }, text));
    input.value = '';
    syncInput();
    request();
  }

  async function request() {
    busy = true; syncInput();
    clearErrors();
    const typing = h('div', { class: 'src-typing', role: 'status' },
      h('i'), h('i'), h('i'), h('span', { class: 'src-sr', text: 'El asistente está escribiendo' }));
    log.append(typing); scrollDown();

    const payload = { sessionId, messages: history.slice(-MAX_TURNS_SENT) };
    controller = new AbortController();
    const myController = controller;
    let bubble = null, answer = '', failed = null, retryable = true;

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: myController.signal,
      });
      if (!res.ok || !res.body) {
        let msg = ERR_GENERIC;
        try { const j = await res.json(); if (j && typeof j.error === 'string') msg = j.error; if (j && j.code === 'session_limit') retryable = false; } catch {}
        if (res.status === 413) retryable = false;
        throw Object.assign(new Error('http'), { userMessage: msg });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', frame = 0;
      const paint = () => { frame = 0; renderRich(bubble, answer); scrollDown(); };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (typeof msg.t === 'string') {
            answer += msg.t;
            if (!bubble) { typing.remove(); bubble = h('div', { class: 'src-msg src-msg--bot' }); log.append(bubble); }
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (typeof msg.error === 'string') {
            failed = msg.error;
          }
        }
      }
      if (frame) { cancelAnimationFrame(frame); paint(); }
      if (!answer && !failed) failed = ERR_GENERIC;
    } catch (err) {
      if (myController.signal.aborted) return;                // conversación borrada
      failed = err.userMessage || ERR_NETWORK;
    } finally {
      if (controller === myController) { controller = null; busy = false; typing.remove(); syncInput(); }
    }

    if (answer && !failed) {
      history.push({ role: 'model', text: answer });
      announce('Respuesta del asistente: ' + answer.replace(/\*\*/g, ''));
    } else {
      if (bubble) bubble.remove();                            // respuesta incompleta: se descarta
      showError(failed, retryable);
    }
    scrollDown();
  }

  function showError(message, retryable) {
    clearErrors();
    const box = h('div', { class: 'src-msg src-msg--error', role: 'alert' }, h('p', { text: message }));
    if (retryable) box.append(h('button', { class: 'src-retry', type: 'button', text: 'Reintentar', onclick: () => { box.remove(); request(); } }));
    log.append(box); scrollDown();
  }
  function clearErrors() { log.querySelectorAll('.src-msg--error').forEach(el => el.remove()); }
  function announce(text) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 50); }

  /* ---------- Borrar conversación ---------- */
  function clearChat() {
    if (controller) controller.abort();
    controller = null; busy = false;
    history = []; userTurns = 0; sessionId = newId();
    input.value = '';
    welcome(); syncInput();
    announce('Conversación borrada.');
    input.focus();
  }

  syncInput();
})();
