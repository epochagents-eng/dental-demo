/* Página del paciente — habla solo con los webhooks del motor, nunca con el modelo. */
(function () {
  'use strict';

  var TOPE = 90000;        // tope por intento (diseño §5.2); el frío de Render tarda ~60 s
  var AVISO_LENTO = 8000;  // a partir de aquí se dice que el sistema está despertando
  var CLAVE = 'emp_sesion_v1';
  var DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

  var cfg = null;
  var sesion = '';
  var ocupado = false;

  var chat, form, campo, boton, punto;

  function $(id) { return document.getElementById(id); }

  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID(); } catch (e) { /* sigue abajo */ }
    }
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 256).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
           h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  /* La sesión vive en el navegador; el texto y el nombre no se guardan aquí. */
  function sesionDeLaPestana() {
    var s = '';
    try { s = localStorage.getItem(CLAVE) || ''; } catch (e) { /* modo privado */ }
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(s)) {
      s = uuid();
      try { localStorage.setItem(CLAVE, s); } catch (e) { /* da igual: dura la pestaña */ }
    }
    return s;
  }

  function pintarCabecera(c) {
    document.title = 'Pedir cita — ' + c.nombre;
    $('nombre').textContent = c.nombre || '';
    $('direccion').textContent = c.direccion || '';
    var tel = $('telefono');
    if (c.telefono) {
      tel.textContent = c.telefono;
      tel.href = 'tel:' + String(c.telefono).replace(/[^+\d]/g, '');
    } else {
      tel.textContent = '';
      tel.removeAttribute('href');
    }
  }

  function marcarPunto(estado) {
    punto.className = 'punto' + (estado ? ' ' + estado : '');
  }

  function bajar() {
    chat.scrollTop = chat.scrollHeight;
  }

  function burbuja(texto, clase) {
    var d = document.createElement('div');
    d.className = 'burbuja' + (clase ? ' ' + clase : '');
    var p = document.createElement('p');
    p.textContent = String(texto || '');
    d.appendChild(p);
    chat.appendChild(d);
    bajar();
    return d;
  }

  function esperando() {
    var d = document.createElement('div');
    d.className = 'burbuja asistente';
    d.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>' +
                  '<span class="espera">Escribiendo…</span>';
    chat.appendChild(d);
    bajar();
    return d;
  }

  function textoEspera(nodo, texto) {
    var e = nodo.querySelector('.espera');
    if (e) e.textContent = texto;
  }

  /* Una petición, con tope de tiempo. Rechaza si no hay respuesta válida. */
  function pedir(texto, turno) {
    return new Promise(function (ok, mal) {
      var ctrl = null;
      var reloj = null;
      if (typeof AbortController === 'function') {
        ctrl = new AbortController();
        reloj = setTimeout(function () { ctrl.abort(); }, TOPE);
      } else {
        /* Sin AbortController: el tope se cumple igual, nunca spinner eterno. */
        reloj = setTimeout(function () { mal(new Error('tiempo')); }, TOPE);
      }
      var limpiar = function () { if (reloj) clearTimeout(reloj); };

      var opciones = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinica: cfg.slug,
          sesion: sesion,
          turno: turno,
          texto: texto
        })
      };
      if (ctrl) opciones.signal = ctrl.signal;

      fetch(cfg.motor + '/webhook/citas', opciones)
        .then(function (r) {
          return r.text().then(function (t) {
            var d = null;
            try { d = JSON.parse(t); } catch (e) { d = null; }
            /* Un 502/503 de Render también es JSON (`{"code":503,...}`): sin `estado`
               no es una respuesta del motor, así que cuenta como fallo y se reintenta. */
            if (!d || typeof d.estado !== 'string') throw new Error('respuesta ' + r.status);
            return d;
          });
        })
        .then(function (d) { limpiar(); ok(d); },
              function (e) { limpiar(); mal(e); });
    });
  }

  function legible(fecha) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(fecha || ''));
    if (!m) return String(fecha || '');
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var h = +m[4];
    return DIAS[d.getUTCDay()] + ' ' + m[3] + '/' + m[2] + ' · ' +
      (h % 12 === 0 ? 12 : h % 12) + ':' + m[5] + (h < 12 ? ' a. m.' : ' p. m.');
  }

  function fila(dl, etiqueta, valor) {
    if (!valor) return;
    var dt = document.createElement('dt');
    dt.textContent = etiqueta;
    var dd = document.createElement('dd');
    dd.textContent = valor;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  /* La tarjeta de las citas de esta conversación. Si ya había una en pantalla, se sustituye:
     así el paciente ve el estado actual, no una tarjeta nueva por cada mensaje. */
  function pintarCitas(citas) {
    var viejo = $('miscitas');
    if (viejo && viejo.parentNode) viejo.parentNode.removeChild(viejo);
    if (!citas || !citas.length) return;

    var c = document.createElement('div');
    c.className = 'cita';
    c.id = 'miscitas';

    var h = document.createElement('h2');
    h.textContent = citas.length === 1 ? 'Cita confirmada' : 'Tus citas';
    c.appendChild(h);

    citas.forEach(function (x) {
      var it = document.createElement('div');
      it.className = 'cita-item';
      var dl = document.createElement('dl');
      fila(dl, 'Cuándo', legible(x.fecha));
      fila(dl, 'Paciente', x.nombre || '');
      fila(dl, 'Servicio', x.servicio || '');
      it.appendChild(dl);

      if (x.token) {
        var a = document.createElement('a');
        a.className = 'boton';
        a.href = 'cita/?t=' + encodeURIComponent(x.token);
        a.textContent = 'Ver o cancelar';
        it.appendChild(a);
      }
      c.appendChild(it);
    });

    var pie = document.createElement('div');
    pie.className = 'cita-pie';
    var dl2 = document.createElement('dl');
    fila(dl2, 'Dónde', cfg.direccion || '');
    pie.appendChild(dl2);
    if (dl2.childNodes.length) c.appendChild(pie);

    chat.appendChild(c);
    bajar();
  }

  function soltar() {
    ocupado = false;
    campo.disabled = false;
    boton.disabled = false;
  }

  function enviar(texto) {
    texto = String(texto || '').trim();
    if (ocupado) return;
    if (!cfg) {
      burbuja('Espera un segundo: la página todavía está cargando.', 'aviso error');
      return;
    }
    if (!texto) return;

    ocupado = true;
    campo.disabled = true;
    boton.disabled = true;
    campo.value = '';

    var sug = $('sugerencias');
    if (sug && sug.parentNode) sug.parentNode.removeChild(sug);

    burbuja(texto, 'paciente');
    var nodo = esperando();
    var lento = setTimeout(function () {
      textoEspera(nodo, 'El sistema está despertando; puede tardar hasta un minuto…');
    }, AVISO_LENTO);

    var turno = uuid();

    /* Si el primer intento no vuelve, se repite UNA vez con el mismo turno:
       el motor devuelve lo guardado y no crea la cita dos veces. */
    pedir(texto, turno)
      .catch(function () {
        textoEspera(nodo, 'Reintentando…');
        return pedir(texto, turno);
      })
      .then(function (d) {
        clearTimeout(lento);
        nodo.remove();

        var estado = d.estado || 'ok';

        if (estado === 'ok') {
          marcarPunto('ok');
          burbuja(d.respuesta || 'Perdona, no te he entendido. ¿Me lo repites?', 'asistente');
          pintarCitas(d.citas || (d.cita ? [d.cita] : []));
        } else if (estado === 'limite') {
          burbuja(d.respuesta || 'Has escrito mucho en poco tiempo. Espera un momento.', 'aviso error');
        } else {
          marcarPunto('mal');
          burbuja(d.respuesta || ('Ahora mismo no puedo contestar.' +
            (cfg.telefono ? ' Llama al ' + cfg.telefono + ' y te atendemos.' : '')), 'aviso error');
        }
        soltar();
      })
      .catch(function () {
        clearTimeout(lento);
        nodo.remove();
        marcarPunto('mal');
        burbuja('No consigo conectar con la clínica.' +
          (cfg.telefono ? ' Llama al ' + cfg.telefono + ' y te atendemos.' : ' Inténtalo en un momento.'),
          'aviso error');
        soltar();
      });
  }

  function arrancar() {
    chat = $('chat');
    form = $('form');
    campo = $('texto');
    boton = $('enviar');
    punto = $('punto');
    sesion = sesionDeLaPestana();

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      enviar(campo.value);
      if (!/Mobi|Android/i.test(navigator.userAgent)) campo.focus();
    });

    chat.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.sugerencia') : null;
      if (b) enviar(b.getAttribute('data-texto'));
    });

    /* La cabecera sale de aquí: no espera al motor. */
    fetch('clinica.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('clinica.json ' + r.status);
        return r.json();
      })
      .then(function (c) {
        cfg = c;
        pintarCabecera(c);
      })
      .catch(function () {
        marcarPunto('mal');
        burbuja('No se pudo cargar la información de la clínica. ' +
          'Comprueba la conexión y recarga la página.', 'aviso error');
      });
  }

  document.addEventListener('DOMContentLoaded', arrancar);
})();
