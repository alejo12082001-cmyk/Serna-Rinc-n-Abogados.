/* Transición de color del isologo (navy → negro → gris).
   · Agrega a cada logo el destello que lo cruza en cada cambio de tono.
   · Alinea todas las animaciones del logo (encabezado, pie, asistente) en el mismo instante.
   · Cambia el favicon de la pestaña al mismo ritmo.
   Con movimiento reducido o sin soporte, todo queda quieto en navy. */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { window.srMark = function () {}; return; }
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  // Banda de luz sobre el recuadro y reflejo dorado recortado a la silueta de la columna
  function decorate(svg) {
    if (!svg || svg.querySelector('.mark-sheen')) return;
    svg.append(el('rect', { class: 'mark-sheen', x: '-50', y: '-8', width: '30', height: '80', fill: 'url(#sheen)' }));
    var g = el('g', { mask: 'url(#isoMask)' });
    g.append(el('rect', { class: 'mark-sheen', x: '-44', y: '-8', width: '18', height: '80', fill: 'url(#glint)' }));
    svg.append(g);
    requestAnimationFrame(sync);   // el logo del asistente aún no está en la página al decorarlo
  }

  // Todas las animaciones del logo arrancan en el mismo instante, aunque el logo aparezca después
  var origin = null;
  function sync() {
    document.getAnimations().forEach(function (a) {
      if (a.animationName !== 'markTone' && a.animationName !== 'markSheen') return;
      if (origin == null) origin = a.startTime;
      if (origin != null && a.startTime !== origin) a.startTime = origin;
    });
  }

  document.querySelectorAll('svg').forEach(function (svg) {
    if (svg.querySelector('use[href="#mark"]')) decorate(svg);
  });
  window.srMark = decorate;   // lo usa el asistente virtual al crear su cabecera

  /* ---------- Favicon ---------- */
  var link = document.querySelector('link[rel="icon"]');
  var iso = document.querySelector('#iso path');
  var ref = document.querySelector('.brand.mark-tone');   // el del telón de carga se elimina
  if (!link || !iso || !ref || !ref.getAnimations) return;

  var TONES = ['#0F2B4B', '#17171C', '#5F5F5F'];
  var CYCLE = 18000;          // igual que markTone en el CSS
  var d = iso.getAttribute('d');
  var icons = TONES.map(function (c) {
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='" + c + "'/>" +
      "<svg x='5' y='4.5' width='54' height='55' viewBox='49 49 1146 1117'><path fill='#E5E5E5' d='" + d + "'/></svg></svg>";
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  });

  var current = 0;
  function tick() {
    var anim = ref.getAnimations()[0];
    if (!anim || anim.currentTime == null) return;
    // El cambio de tono ocurre a mitad de cada transición CSS (≈ 30 %, 63 % y 96 % del ciclo)
    var p = ((anim.currentTime % CYCLE) / CYCLE + 0.04) % 1;
    var i = Math.floor(p * 3) % 3;
    if (i !== current) { current = i; link.href = icons[i]; }
  }
  setInterval(tick, 500);
})();
