/*
 * 세 화면 공통 UI: 맨 위 메뉴, 테스트 시각 표시, 저장소 안내 배너, 확인 창(Dialog) 도우미. (CLAUDE.md 4장 "세 화면 공통")
 * 계산은 하지 않는다 (계산은 reset.js). 화면에 쓰는 글자는 모두 textContent로 넣는다.
 * alert()·confirm()·prompt()를 쓰지 않는다. 확인과 오류는 <dialog>와 페이지 안 안내로 보여 준다.
 */
(function (global) {
  'use strict';

  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  // 메뉴. ready가 false인 화면은 아직 없어서 링크 대신 "준비 중"으로 보인다.
  var PAGES = [
    { key: 'index', label: '메인', href: 'index.html', ready: true },
    { key: 'settings', label: '설정', href: 'settings.html', ready: true },
    { key: 'history', label: '기록', href: 'history.html', ready: true }
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

  // 날짜 글자는 이 함수 한 곳에서 만든다. "MM/DD(요일) HH:mm" (withWeekday가 false이면 "MM/DD HH:mm").
  // 그 날짜의 연도가 at(지금)의 연도와 다르면 앞에 "YYYY/"를 붙인다.
  function formatWhen(d, at, withWeekday) {
    var year = d.getFullYear() !== at.getFullYear() ? d.getFullYear() + '/' : '';
    return year + two(d.getMonth() + 1) + '/' + two(d.getDate()) + (withWeekday ? '(' + WEEKDAYS[d.getDay()] + ')' : '') + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  // 기간 한 줄의 글자. 시작·끝이 없는 1회 주기는 "1회 · 기한 없음", 주기를 1회로 바꾸기 전 구간은 "1회로 바꾸기 전".
  function formatPeriod(p, at) {
    if (p.legacy) return '1회로 바꾸기 전';
    if (!p.start || !p.end) return '1회 · 기한 없음';
    return formatWhen(p.start, at, true) + ' ~ ' + formatWhen(p.end, at, true);
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

  /* ---------- 데이터 백업: 내보내기와 가져오기 (CLAUDE.md 3장 "저장", 4장 설정) ---------- */

  var IMPORT_FIXED = '기존 데이터와 완료 기록이 모두 바뀝니다. 먼저 내보내기를 해 두세요';
  var IMPORT_SHOWN_ERRORS = 5;
  var TOO_BIG_MESSAGE = '파일이 너무 커요. 약 6MB까지 가져올 수 있어요.';

  // 파일을 읽기 전에 아주 큰 파일을 거르는 바이트 상한. 가져오기 상한(Store.LIMIT.text)은 글자 수이고 한글은 UTF-8로
  // 글자당 3바이트라서, 상한 안의 정상 파일을 막지 않도록 넉넉하게(4배) 둔다. 진짜 판정은 읽은 뒤 importJson의 글자 수 검사다.
  function importMaxBytes() { return global.Store.LIMIT.text * 4; }
  function importTooBig(bytes) { return bytes > importMaxBytes(); }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + '바이트';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }

  // 가져오기 확인 창의 글. o: { fileName, size, corrupted, persistent } → { title, lines }
  // 손상 상태에서는 내보낼 데이터가 없으므로 고정 문장 대신 "손상된 원문을 보관(백업)한 뒤 바꿔요"를 쓴다.
  function importDialogText(o) {
    var lines = [];
    if (o.corrupted) lines.push({ text: '저장된 데이터가 손상돼 있어요. 가져오면 이 데이터를 대신해요. 손상된 원문은 이 브라우저 안에 따로 보관(백업)해 두고 바꿔요.', strong: true });
    else lines.push({ text: IMPORT_FIXED, strong: true });
    lines.push('파일: ' + o.fileName + ' (' + formatSize(o.size) + ')');
    if (!o.persistent) lines.push('이 브라우저에서는 저장되지 않아요. 가져와도 이 페이지를 닫으면 사라지니, 닫기 전에 다시 내보내 주세요.');
    return { title: '가져올까요?', lines: lines };
  }

  // importJson이 실패했을 때 창 안에 보여 줄 글: 앞의 5개까지, 나머지는 "외 N개". res: { error, errors? }
  function formatImportErrors(res) {
    var list = res.errors && res.errors.length ? res.errors : [res.error || '가져오지 못했어요.'];
    var shown = list.slice(0, IMPORT_SHOWN_ERRORS);
    var text = '가져오지 못했어요. 기존 데이터는 그대로예요.\n' + shown.map(function (m) { return '· ' + m; }).join('\n');
    var rest = list.length - shown.length;
    if (rest > 0) text += '\n외 ' + rest + '개' + (list.length >= global.Store.LIMIT.errors ? ' 이상' : '');
    return text;
  }

  function importSummaryText(s, persistent) {
    var text = '게임 ' + s.games + '개, 숙제 ' + s.tasks + '개, 완료 기록 ' + s.records + '개를 가져왔어요.';
    if (s.dropped > 0) text += ' 알 수 없는 항목 ' + s.dropped + '개는 건너뛰었어요.';
    if (!persistent) text += ' 이 브라우저에서는 저장되지 않아요.';
    return text;
  }

  var lastExported = null;
  // 지금 데이터를 JSON 파일로 내려받는다. 시각은 Reset.now() (?now=이면 테스트 시각). 파일 이름을 돌려준다.
  function exportFile() {
    var out = global.Store.exportJson(global.Reset.now());
    download(out.filename, out.text, 'application/json;charset=utf-8');
    lastExported = out.filename;
    return out.filename;
  }

  var fileInput = null;
  var importDone = null; // 저장소가 없는 모드에서 가져온 뒤 화면을 다시 그리는 함수 (설정 화면이 등록한다)

  function startImport() {
    if (!fileInput) return;
    fileInput.value = '';
    fileInput.click();
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  }

  // 고른 파일을 읽고 확인 창을 거쳐 가져온다. 성공하면 저장소가 있는 모드는 새로 고치고, 없는 모드는 화면만 다시 그린다.
  function handleImportFile(file) {
    if (!file) return Promise.resolve();
    if (importTooBig(file.size)) { return info({ title: '가져올 수 없어요', message: TOO_BIG_MESSAGE }); }
    return readFile(file).then(function (text) {
      var st = global.Store.status();
      var corrupted = st.status === 'corrupted';
      var t = importDialogText({ fileName: file.name, size: file.size, corrupted: corrupted, persistent: st.persistent });
      var note = el('p', { class: 'muted', hidden: true });
      var body = el('div', {}, [
        t.lines.map(function (l) { return el('p', { class: l.strong ? 'fixed-line' : '', text: l.strong ? l.text : l }); }),
        corrupted ? null : el('div', { class: 'banner-actions' }, [el('button', { type: 'button', class: 'btn btn-sm', text: '먼저 내보내기', onclick: function () {
          note.textContent = '내보냈어요: ' + exportFile();
          note.hidden = false;
        } })]),
        note
      ]);
      var summary = null;
      return modal({
        title: t.title, body: body, submitLabel: '가져오기', danger: true,
        onSubmit: function () {
          var r = global.Store.importJson(text);
          if (!r.ok) return { ok: false, error: formatImportErrors(r) };
          summary = r.summary;
          return { ok: true };
        }
      }).then(function (done) {
        if (!done) return;
        var persistent = global.Store.status().persistent;
        return info({ title: '가져왔어요', message: importSummaryText(summary, persistent) }).then(function () {
          if (persistent) { global.location.reload(); return; }
          refreshStorageBanner();
          if (importDone) importDone();
        });
      });
    }, function () { return info({ title: '가져올 수 없어요', message: '파일을 읽지 못했어요.' }); });
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
      storageBox.appendChild(el('p', { text: '이전에 내보낸 JSON 파일이 있으면 [JSON 가져오기로 복구]를 누르세요. 없으면 손상된 원문을 내려받아 보관한 뒤 [새로 시작]을 누르세요.' }));
      storageBox.appendChild(el('div', { class: 'banner-actions' }, [
        el('button', { type: 'button', class: 'btn', text: '손상된 원문 내려받기', onclick: function () {
          var d = global.Reset.now();
          download('vibe-coding-hangisu-broken-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + '.txt', global.Store.rawText() || '');
        } }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'JSON 가져오기로 복구', onclick: startImport }),
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
    // 가져오기 파일 선택창 (보이지 않는 입력). [JSON 가져오기] 버튼들이 이것을 연다.
    fileInput = el('input', { type: 'file', id: 'import-file', accept: '.json,application/json', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    fileInput.addEventListener('change', function () { handleImportFile(fileInput.files && fileInput.files[0]); });
    host.appendChild(fileInput);
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
    mountChrome: mountChrome, refreshStorageBanner: refreshStorageBanner, clockText: clockText, formatWhen: formatWhen, formatPeriod: formatPeriod,
    exportFile: exportFile, lastExportedName: function () { return lastExported; }, startImport: startImport, handleImportFile: handleImportFile,
    onImported: function (fn) { importDone = fn; }, importDialogText: importDialogText, formatImportErrors: formatImportErrors, importSummaryText: importSummaryText,
    importTooBig: importTooBig, importMaxBytes: importMaxBytes, formatSize: formatSize, IMPORT_FIXED: IMPORT_FIXED
  };
})(window);
