/* Página de la cita: ve el detalle y cancela. Habla solo con los webhooks. */
(function () {
  'use strict';

  var TOPE = 90000;
  var AVISO_LENTO = 8000;
  var DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

  var cfg = null;
  var token = '';
  var actual = null;
  var zona;

  function $(id) { return document.getElementById(id); }

  function legible(fecha) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(fecha || ''));
    if (!m) return String(fecha || '');
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var h = +m[4];
    return DIAS[d.getUTCDay()] + ' ' + m[3] + '/' + m[2] + ' · ' +
      (h % 12 === 0 ? 12 : h % 12) + ':' + m[5] + (h < 12 ? ' a. m.' : ' p. m.');
  }

  function pedir(url, opciones, valida) {
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
      opciones = opciones || {};
      if (ctrl) opciones.signal = ctrl.signal;

      fetch(url, opciones)
        .then(function (r) {
          return r.text().then(function (t) {
            var d = null;
            try { d = JSON.parse(t); } catch (e) { d = null; }
            /* Un 502/503 de Render también es JSON (`{"code":503,...}`): si no tiene
               la forma esperada, es un fallo y se reintenta. */
            if (!d || typeof d !== 'object' || (valida && !valida(d))) {
              throw new Error('respuesta ' + r.status);
            }
            return d;
          });
        })
        .then(function (d) { limpiar(); ok(d); },
              function (e) { limpiar(); mal(e); });
    });
  }

  function limpiarZona() {
    while (zona.firstChild) zona.removeChild(zona.firstChild);
  }

  function titulo(texto) {
    var h = document.createElement('h2');
    h.textContent = texto;
    return h;
  }

  function nota(texto) {
    var p = document.createElement('p');
    p.className = 'nota';
    p.textContent = texto;
    return p;
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

  function mensaje(tituloTexto, texto, conTelefono) {
    limpiarZona();
    zona.appendChild(titulo(tituloTexto));
    zona.appendChild(nota(texto));
    if (conTelefono && cfg && cfg.telefono) {
      zona.appendChild(nota('También puedes llamar al ' + cfg.telefono + '.'));
    }
  }

  /* ---------- La tarjeta ---------- */

  function pintarCita(d) {
    actual = d;
    limpiarZona();

    var cancelada = d.estado === 'cancelada';

    zona.appendChild(titulo(cancelada ? 'Esta cita está cancelada' : 'Tu cita'));

    var c = document.createElement('div');
    c.className = 'cita';

    var dl = document.createElement('dl');
    fila(dl, 'Cuándo', legible(d.fecha));
    fila(dl, 'A nombre de', d.nombre || '');
    fila(dl, 'Reserva', d.contacto || '');
    fila(dl, 'Servicio', d.servicio || '');
    fila(dl, 'Dónde', d.direccion || (cfg && cfg.direccion) || '');
    c.appendChild(dl);

    zona.appendChild(c);

    if (cancelada) {
      zona.appendChild(nota('Si quieres otra hora, pídenos una cita nueva en el chat.'));
      return;
    }

    zona.appendChild(nota('Si no puedes venir, cancélala cuanto antes para dejar el hueco a otro paciente.'));

    var acciones = document.createElement('div');
    acciones.className = 'acciones';

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'peligro';
    b.textContent = 'Cancelar mi cita';
    b.addEventListener('click', function () { confirmar(acciones); });
    acciones.appendChild(b);

    zona.appendChild(acciones);
  }

  /* ---------- La cancelación, en dos pasos ---------- */

  function confirmar(acciones) {
    acciones.innerHTML = '';

    var si = document.createElement('button');
    si.type = 'button';
    si.className = 'peligro';
    si.textContent = 'Sí, cancelar la cita';

    var no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'No, dejarla como está';

    acciones.appendChild(nota('¿Seguro? La cita se quitará del calendario de la clínica.'));
    acciones.appendChild(si);
    acciones.appendChild(no);

    no.addEventListener('click', function () { pintarCita(actual); });
    si.addEventListener('click', function () { cancelar(si, no); });
  }

  function cancelar(si, no) {
    si.disabled = true;
    no.disabled = true;
    si.textContent = 'Cancelando…';

    /* Sin reintento: si la respuesta se pierde, recargar enseña el estado real.
       Repetir ya no confunde: el motor distingue «cancelada» de «ya_cancelada»
       (2026-11-16). */
    pedir(cfg.motor + '/webhook/cancelar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, c: cfg.slug })
    }, function (d) {
      return typeof d.estado === 'string';
    }).then(function (d) {
      if (d.estado === 'cancelada' || d.estado === 'ya_cancelada') {
        actual.estado = 'cancelada';
        pintarCita(actual);
      } else {
        mensaje('No encontramos esa cita',
          'Puede que ya estuviera cancelada. Recarga la página para comprobarlo.', true);
      }
    }).catch(function () {
      mensaje('No sabemos si se canceló',
        'No llegó la respuesta. Recarga la página para comprobar el estado antes de repetir.', true);
    });
  }

  /* ---------- Arranque ---------- */

  function pintarCabecera(c) {
    document.title = 'Mi cita — ' + c.nombre;
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

  function cargarCita() {
    var url = cfg.motor + '/webhook/cita?t=' + encodeURIComponent(token) +
              '&c=' + encodeURIComponent(cfg.slug);

    var lento = setTimeout(function () {
      mensaje('Un momento…',
        'El sistema está despertando. Esto puede tardar hasta un minuto.', false);
    }, AVISO_LENTO);

    pedir(url, null, function (d) {
      return typeof d.estado === 'string' || !!d.fecha;
    })
      .catch(function () {
        return pedir(url, null, function (d) {
          return typeof d.estado === 'string' || !!d.fecha;
        });
      })
      .then(function (d) {
        clearTimeout(lento);
        if (!d || d.estado === 'no_encontrada') {
          mensaje('No encontramos esa cita',
            'El enlace puede estar incompleto o la cita ya no existe.', true);
          return;
        }
        pintarCita(d);
      })
      .catch(function () {
        clearTimeout(lento);
        mensaje('No consigo conectar con la clínica',
          'Comprueba la conexión y recarga la página.', true);
      });
  }

  function arrancar() {
    zona = $('zona');

    var m = /[?&]t=([^&]+)/.exec(window.location.search);
    token = m ? decodeURIComponent(m[1]).trim() : '';

    if (!token) {
      mensaje('No encontramos esa cita',
        'Falta el código de la cita en el enlace. Pídenos una nueva desde el chat.', false);
      return;
    }

    fetch('../clinica.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('clinica.json ' + r.status);
        return r.json();
      })
      .then(function (c) {
        cfg = c;
        pintarCabecera(c);
        cargarCita();
      })
      .catch(function () {
        mensaje('No se pudo cargar la página',
          'Comprueba la conexión y vuelve a abrir el enlace.', false);
      });
  }

  document.addEventListener('DOMContentLoaded', arrancar);
})();
