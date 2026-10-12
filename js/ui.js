/*
 * 세 화면 공통 UI: 맨 위 메뉴, 테스트 시각 표시, 저장소 안내 배너, 확인 창(Dialog) 도우미. (CLAUDE.md 4장 "세 화면 공통")
 * 계산은 하지 않는다 (계산은 reset.js). 화면에 쓰는 글자는 모두 textContent로 넣는다.
 * alert()·confirm()·prompt()를 쓰지 않는다. 확인과 오류는 <dialog>와 페이지 안 안내로 보여 준다.
 */
(function (global) {
  'use strict';

  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  // 메뉴. ready가 false인 화면은 아직 없어서 링크 대신 "준비 중"으로 보인다 (6단계에서 켠다).
  var PAGES = [
    { key: 'index', label: '메인', href: 'index.html', ready: true },
    { key: 'settings', label: '설정', href: 'settings.html', ready: true },
    { key: 'history', label: '기록', href: 'history.html', ready: false }
  ];

  /* ---------- 요소 만들기 ---------- */

  function append(parent, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(parent, x); }); return; }
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }

  // el('div', { class: 'card', onclick: fn, value: 'x' }, [자식…])
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    var value;
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
    append(e, children);
    if (value !== undefined) e.value = value; // select는 자식(option)을 붙인 뒤에 값을 정한다
    return e;
  }

  var uid = 0;
  function nextId(prefix) { uid += 1; return (prefix || 'ui') + '-' + uid; }

  // 라벨 + 입력 한 묶음
  function field(label, control, hint, id) {
    var lab = el('label', { class: 'label', for: id || control.id, text: label });
    return el('div', { class: 'field' }, [lab, control, hint ? el('p', { class: 'hint', text: hint }) : null]);
  }

  /* ---------- 대화상자 ---------- */

  var openCount = 0;
  var closedCallbacks = [];
  function isDialogOpen() { return openCount > 0; }

  // 열린 대화상자가 모두 닫힌 뒤에 fn을 한 번 부른다 (이미 없으면 바로). 같은 fn은 한 번만 기다린다.
  function whenDialogsClosed(fn) {
    if (openCount === 0) { fn(); return; }
    if (closedCallbacks.indexOf(fn) < 0) closedCallbacks.push(fn);
  }
  function flushClosed() {
    if (openCount > 0) return;
    var cbs = closedCallbacks;
    closedCallbacks = [];
    cbs.forEach(function (cb) { cb(); });
  }

  // modal({ title, description, body, submitLabel, cancelLabel, danger, hideSubmit, onSubmit })
  //   onSubmit()가 { ok:false, error }를 돌려주면(Promise도 된다) 닫지 않고 그 오류를 창 안에 보여 준다.
  //   돌려주는 Promise는 [저장]으로 닫히면 true, 취소(버튼·Esc·바깥 클릭)로 닫히면 false다.
  // body는 Node이거나, 닫기 함수를 받는 함수(ctx)다: body({ close: function (result) {} })
  function modal(opts) {
    return new Promise(function (resolve) {
      var opener = document.activeElement;
      var titleId = nextId('dlg-title');
      var result = false;
      var busy = false;
      var finished = false;

      var errBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
      var cancelBtn = el('button', { type: 'button', class: 'btn', text: opts.cancelLabel || '취소' });
      var submitBtn = opts.hideSubmit ? null : el('button', { type: 'submit', class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), text: opts.submitLabel || '저장' });
      var dlg;

      // 정리는 한 번만 한다. close 이벤트에만 기대지 않고(일부 환경에서는 오지 않는다), 닫는 쪽에서도 직접 부른다.
      function finish() {
        if (finished) return;
        finished = true;
        openCount -= 1;
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
        resolve(result);
        setTimeout(flushClosed, 0); // 곧바로 다음 창이 열리면 그 창이 닫힐 때까지 기다린다
      }
      function close(res) {
        if (res !== undefined) result = res;
        try { if (dlg.open) dlg.close(); } catch (err) { /* 이미 닫힘 */ }
        finish();
      }

      var body = typeof opts.body === 'function' ? opts.body({ close: close }) : opts.body;
      var form = el('form', { class: 'dlg-form', novalidate: true }, [
        el('div', { class: 'dlg-head' }, [
          el('h2', { class: 'dlg-title', id: titleId, text: opts.title }),
          opts.description ? el('p', { class: 'dlg-desc', text: opts.description }) : null
        ]),
        el('div', { class: 'dlg-body' }, [body || null, errBox]),
        el('div', { class: 'dlg-foot' }, [cancelBtn, submitBtn])
      ]);
      dlg = el('dialog', { class: 'dlg', 'aria-labelledby': titleId }, [form]);

      function showError(msg) { errBox.textContent = msg; errBox.hidden = false; }

      cancelBtn.addEventListener('click', function () { close(false); });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) close(false); });
      dlg.addEventListener('close', finish); // 브라우저가 스스로 닫은 경우
      dlg.addEventListener('keydown', function (e) {
        // Esc는 직접 처리한다 (close 이벤트가 오지 않는 환경에서도 정리가 되게)
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        errBox.hidden = true;
        var r;
        try { r = opts.onSubmit ? opts.onSubmit() : { ok: true }; } catch (err) { showError('처리하지 못했어요.'); return; }
        busy = true;
        Promise.resolve(r).then(function (res) {
          busy = false;
          if (res && res.ok === false) { showError(res.error || '처리하지 못했어요.'); return; }
          close(true);
        }, function () { busy = false; showError('처리하지 못했어요.'); });
      });

      document.body.appendChild(dlg);
      openCount += 1;
      dlg.showModal();
      var first = opts.danger ? cancelBtn : (dlg.querySelector('.dlg-body input:not([disabled]), .dlg-body select:not([disabled]), .dlg-body textarea') || submitBtn || cancelBtn);
      if (first && typeof first.focus === 'function') first.focus();
    });
  }

  // UI.confirm({ title, message, lines: [고정 문장 등], confirmLabel, danger }) → Promise<boolean>
  function confirmDialog(opts) {
    var body = el('div', {}, [
      opts.message ? el('p', { text: opts.message }) : null,
      (opts.lines || []).map(function (l) {
        return typeof l === 'string' ? el('p', { text: l }) : el('p', { class: l.strong ? 'fixed-line' : '', text: l.text });
      })
    ]);
    return modal({ title: opts.title, body: body, submitLabel: opts.confirmLabel || '확인', danger: opts.danger === true, onSubmit: opts.onConfirm });
  }

  // info({ title, message }) → 확인만 있는 안내 창 (이유를 알려 줄 때)
  function info(opts) {
    return modal({ title: opts.title || '알림', body: el('p', { text: opts.message }), hideSubmit: true, cancelLabel: '닫기' });
  }

  // sheet({ title, description, actions: [{ label, danger, onClick }] }) → 행 하나의 작업 목록. 고르면 닫고 나서 onClick을 부른다.
  function sheet(opts) {
    var chosen = null;
    var promise = modal({
      title: opts.title, description: opts.description, hideSubmit: true, cancelLabel: '닫기',
      body: function (ctx) {
        var box = el('div', { class: 'sheet-actions' });
        (opts.actions || []).forEach(function (a) {
          if (!a) return;
          box.appendChild(el('button', { type: 'button', class: 'btn' + (a.danger ? ' btn-danger' : ''), text: a.label, onclick: function () {
            chosen = a;
            ctx.close(true);
          } }));
        });
        return box;
      }
    });
    return promise.then(function () { if (chosen && chosen.onClick) chosen.onClick(); });
  }

  /* ---------- 페이지 안 안내 ---------- */

  var noticeBox = null;
  // 대화상자 밖에서 일어난 실패를 알린다. message가 비면 지운다.
  function notice(message) {
    if (!noticeBox) return;
    noticeBox.textContent = '';
    noticeBox.hidden = !message;
    if (!message) return;
    noticeBox.appendChild(el('p', { text: message }));
    noticeBox.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: '닫기', onclick: function () { notice(''); } }));
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- 맨 위: 테스트 시각, 배너, 메뉴 ---------- */

  function two(n) { return n < 10 ? '0' + n : String(n); }
  function clockText(d) {
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '(' + WEEKDAYS[d.getDay()] + ') ' +
      two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  var clockEl = null;
  var clockTimer = null;
  function tickClock() {
    clearTimeout(clockTimer);
    if (!clockEl) return;
    var d = global.Reset.now();
    clockEl.textContent = '테스트 시각 ' + clockText(d);
    clockTimer = setTimeout(tickClock, Math.min(60000, global.Reset.msUntilNextSecond(d)));
  }

  var storageBox = null;
  function refreshStorageBanner() {
    if (!storageBox) return;
    storageBox.textContent = '';
    var st = global.Store.status();
    if (st.status === 'corrupted') {
      storageBox.hidden = false;
      storageBox.appendChild(el('p', { class: 'fixed-line', text: '저장된 데이터가 손상돼 있어서 변경할 수 없어요.' }));
      storageBox.appendChild(el('p', { text: st.error || '' }));
      storageBox.appendChild(el('p', { text: '손상된 원문을 내려받아 보관한 뒤 [새로 시작]을 누르세요. JSON 파일을 가져와서 복구하는 기능은 아직 없어요.' }));
      storageBox.appendChild(el('div', { class: 'banner-actions' }, [
        el('button', { type: 'button', class: 'btn', text: '손상된 원문 내려받기', onclick: function () {
          var d = global.Reset.now();
          download('vibe-coding-hangisu-broken-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + '.txt', global.Store.rawText() || '');
        } }),
        el('button', { type: 'button', class: 'btn btn-danger', text: '새로 시작', onclick: function () {
          confirmDialog({
            title: '새로 시작할까요?',
            lines: ['저장된 손상 데이터는 이 브라우저 안에 따로 보관해 두고, 빈 상태로 시작해요.', '먼저 [손상된 원문 내려받기]로 파일을 받아 두는 것을 권해요.'],
            confirmLabel: '새로 시작', danger: true,
            onConfirm: function () {
              var r = global.Store.startFresh();
              if (!r.ok) return r;
              global.location.reload();
              return { ok: true };
            }
          });
        } })
      ]));
    } else if (!st.persistent) {
      storageBox.hidden = false;
      storageBox.appendChild(el('p', { class: 'fixed-line', text: '이 브라우저에서는 저장할 수 없어요.' }));
      storageBox.appendChild(el('p', { text: '지금 입력하는 내용은 저장되지 않고, 이 페이지를 닫으면 사라져요.' }));
    } else {
      storageBox.hidden = true;
    }
  }

  // 맨 위에 테스트 시각 표시, 저장소 안내, 메뉴를 만든다. active는 지금 화면의 key ('index' | 'settings' | 'history')
  function mountChrome(opts) {
    var host = document.getElementById('chrome');
    if (!host) { host = el('div', { id: 'chrome' }); document.body.insertBefore(host, document.body.firstChild); }
    host.textContent = '';

    var info = global.Reset.nowInfo();
    if (info.isTest) {
      clockEl = el('div', { class: 'test-banner', role: 'status' });
      host.appendChild(clockEl);
      tickClock();
    } else if (info.error) {
      host.appendChild(el('div', { class: 'test-banner', role: 'status', text: info.error }));
    }

    // 링크는 누르기 직전에 다시 계산해서, 그 순간의 테스트 시각이 다음 화면으로 이어지게 한다.
    var nav = el('nav', { class: 'nav', 'aria-label': '메뉴' }, PAGES.map(function (p) {
      if (!p.ready) return el('span', { class: 'disabled', 'aria-disabled': 'true', text: p.label + ' (준비 중)' });
      var a = el('a', { href: p.href + global.Reset.nowQuery(), 'aria-current': p.key === opts.active ? 'page' : null, text: p.label });
      function refresh() { a.setAttribute('href', p.href + global.Reset.nowQuery()); }
      ['pointerdown', 'mouseenter', 'focus', 'click'].forEach(function (ev) { a.addEventListener(ev, refresh); });
      return a;
    }));
    host.appendChild(el('header', { class: 'app-header' }, [el('div', { class: 'app-header-inner' }, [el('span', { class: 'app-title', text: '게임 숙제 체크' }), nav])]));

    storageBox = el('div', { class: 'banner', role: 'status', hidden: true });
    host.appendChild(storageBox);
    noticeBox = el('div', { class: 'notice', role: 'alert', hidden: true });
    host.appendChild(noticeBox);
    refreshStorageBanner();

    // 탭이 다시 보이면 바로 다시 그린다 (3장 "화면 갱신")
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (clockEl) tickClock();
      refreshStorageBanner();
    });
  }

  // 다른 화면으로 가는 링크. 메뉴처럼 누르기 직전에 테스트 시각(?now=)을 다시 계산해서 붙인다.
  function navLink(text, href, className) {
    var a = el('a', { href: href + global.Reset.nowQuery(), class: className || null, text: text });
    function refresh() { a.setAttribute('href', href + global.Reset.nowQuery()); }
    ['pointerdown', 'mouseenter', 'focus', 'click'].forEach(function (ev) { a.addEventListener(ev, refresh); });
    return a;
  }

  global.UI = {
    el: el, field: field, nextId: nextId, navLink: navLink,
    modal: modal, confirm: confirmDialog, info: info, sheet: sheet, isDialogOpen: isDialogOpen, whenDialogsClosed: whenDialogsClosed,
    notice: notice, download: download,
    mountChrome: mountChrome, refreshStorageBanner: refreshStorageBanner, clockText: clockText
  };
})(window);
