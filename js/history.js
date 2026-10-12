/*
 * 기록 화면 (history.html): 숙제마다 지난 기간별 함/안함을 보여 준다. (CLAUDE.md 3장 "지난 기간 기록", 4장 3번)
 * 기간 나누기와 판정은 모두 Reset.buildHistory가 하고, 이 파일은 그 결과를 그리기만 한다. 읽기 전용이다.
 *
 * 다시 그리기: 결과가 바뀌었을 때만 DOM을 새로 만든다. 펼침 상태는 사용자가 직접 바꾼 것만 기억하고
 * (기본은 놓친 것이 있으면 펼침), "더 보기"로 늘린 개수는 이 페이지가 열려 있는 동안만 기억한다.
 */
(function () {
  'use strict';

  var UI = window.UI, Store = window.Store, Reset = window.Reset, el = UI.el;
  var host = document.getElementById('history');

  var state = {
    sig: null,
    model: null,
    index: Object.create(null), // 숙제 키 → { gm, t, at } (펼칠 때 만들거나 "더 보기"로 그 숙제만 바꿀 때 쓴다)
    limits: Object.create(null), // "숙제id/폴더id" → 보여 줄 개수
    open: Object.create(null),   // 숙제 키 → 사용자가 정한 펼침 (정하지 않았으면 기본값)
    timer: null,
    pressed: false,
    pressedAt: 0
  };

  var STEP = 10;

  /* ---------- 글자 ---------- */

  function badge(text, cls) { return el('span', { class: 'badge' + (cls ? ' ' + cls : ''), text: text }); }

  function summaryText(t) {
    if (!t.shown) return '';
    return t.missed > 0 ? '놓친 ' + t.missed + '번 · 최근 ' + t.shown + '개 중' : '최근 ' + t.shown + '개 중 놓친 것 없음';
  }

  // 기간 한 줄의 결과 글자와 모양
  function statusView(r, at) {
    switch (r.status) {
      case 'done': return { text: '함' + (r.doneAt ? ' (' + UI.formatWhen(r.doneAt, at, false) + ')' : ''), cls: 'st-done' };
      case 'missed': return { text: '안함', cls: 'st-missed', flag: true };
      case 'missed-group-met': return { text: '안함 (묶음 달성)', cls: 'st-neutral' };
      case 'group-checked': return { text: '묶음 체크로 완료', cls: 'st-neutral' };
      case 'pending-group-met': return { text: '안 해도 돼요 (묶음 달성)', cls: 'st-neutral' };
      default: return { text: '아직 안 함', cls: 'st-neutral' };
    }
  }

  /* ---------- 그리기 ---------- */

  function emptyCard(title, text, linkText) {
    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: title })]),
      el('div', { class: 'card-body' }, [el('p', { class: 'empty', text: text })]),
      el('div', { class: 'card-foot' }, [linkText ? UI.navLink(linkText, 'settings.html', 'btn btn-primary') : null])
    ]);
  }

  // 숙제 하나의 기간 줄 목록 (펼친 것만 만든다. 접힌 것은 열 때 만든다)
  function rowsBody(gm, t, at) {
    var key = gm.game.id + '/' + t.key;
    var rows = t.rows.map(function (r) {
      var v = statusView(r, at);
      return el('li', { class: 'hrow' + (r.period.isCurrent ? ' is-current' : '') }, [
        el('span', { class: 'hperiod' }, [r.period.isCurrent ? badge('이번 기간') : null, el('span', { text: UI.formatPeriod(r.period, at) })]),
        el('span', { class: 'hstat ' + v.cls }, [v.flag ? badge('놓침', 'badge-warn') : null, el('span', { text: v.text })])
      ]);
    });
    var body = [el('ul', { class: 'hrows' }, rows)];
    if (t.more) {
      body.push(el('button', { type: 'button', class: 'btn btn-sm', 'data-more': key, 'data-limit-key': t.key, 'data-shown': String(t.shown), text: STEP + '개 더 보기' }));
    } else if (t.truncated) {
      body.push(el('p', { class: 'muted hnote', text: '더 오래된 기간은 생략했어요 (최근 1000개까지 보여요).' }));
    }
    return body;
  }

  function taskBlock(gm, t, at) {
    var key = gm.game.id + '/' + t.key;
    state.index[key] = { gm: gm, t: t, at: at };
    var isOpen = key in state.open ? state.open[key] : t.missed > 0;
    var bodyEl = el('div', { class: 'htask-body' }, isOpen ? rowsBody(gm, t, at) : []);
    var d = el('details', { class: 'htask', 'data-key': key }, [
      el('summary', {}, [el('span', { class: 'htask-name', text: t.task.name }), t.task.low ? badge('낮음') : null, el('span', { class: 'htask-sum' + (t.missed > 0 ? ' has-missed' : ''), text: summaryText(t) })]),
      bodyEl
    ]);
    if (isOpen) d.open = true;
    return d;
  }

  function groupBlock(gm, g, at) {
    var head = el('div', { class: 'hgroup-head' }, [
      el('strong', { text: g.group.name }), badge(g.cycle ? g.cycle.name : '주기 없음'), g.group.low ? badge('낮음') : null
    ]);
    var body = g.tasks.length ? g.tasks.map(function (t) { return taskBlock(gm, t, at); }) : [el('p', { class: 'empty', text: '숙제가 없어요.' })];
    return el('div', { class: 'hgroup' }, [head].concat(body));
  }

  function gameCard(gm, at) {
    var body = [];
    gm.sections.forEach(function (s) {
      body.push(el('div', { class: 'hsec' }, [el('h3', { class: 'hsec-title', text: s.pathText })].concat(s.groups.map(function (g) { return groupBlock(gm, g, at); }))));
    });
    gm.noFolderGroups.forEach(function (g) {
      body.push(el('p', { class: 'empty', text: '"' + g.name + '" 묶음은 폴더가 아직 없어서 기록이 없어요. 설정에서 폴더를 추가해 보세요.' }));
    });
    if (!body.length) body.push(el('p', { class: 'empty', text: '기록할 숙제가 아직 없어요. 설정에서 묶음과 숙제를 만들어 보세요.' }));
    return el('section', { class: 'card game-card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: gm.game.name })]),
      el('div', { class: 'card-body' }, body)
    ]);
  }

  function render(model, at) {
    host.textContent = '';
    state.index = Object.create(null);
    if (!model.games.length) {
      var corrupted = Store.status().status === 'corrupted';
      host.appendChild(corrupted
        ? emptyCard('데이터를 읽지 못했어요', '저장된 데이터가 손상돼 있어서 지금은 보여 줄 수 없어요. 맨 위 안내를 확인해 주세요.', null)
        : emptyCard('아직 게임이 없어요', '설정에서 게임과 숙제를 만들면 지난 기간 기록이 여기에 쌓여요.', '게임 추가하러 가기'));
      return;
    }
    model.games.forEach(function (gm) { host.appendChild(gameCard(gm, at)); });
  }

  /* ---------- 갱신 ---------- */

  function pointerHeld() {
    if (!state.pressed) return false;
    if (Date.now() - state.pressedAt > 3000) { state.pressed = false; return false; }
    return true;
  }

  // 화면에 영향을 주는 값만 이어 붙인 글자 (결과 전체를 JSON으로 바꾸는 것보다 훨씬 싸다)
  function sigOf(model) {
    var parts = [];
    model.games.forEach(function (gm) {
      parts.push('G' + gm.game.id + ':' + gm.game.name, gm.noFolderGroups.map(function (g) { return g.id + g.name; }).join(','));
      gm.sections.forEach(function (s) {
        parts.push('S' + s.key + ':' + s.pathText);
        s.groups.forEach(function (g) {
          parts.push('P' + g.group.id + ':' + g.group.name + ':' + g.group.low + ':' + (g.cycle ? g.cycle.name : ''));
          g.tasks.forEach(function (t) {
            parts.push('T' + t.key + ':' + t.task.name + ':' + t.task.low + ':' + t.shown + ':' + t.more + ':' + t.truncated + ':' + t.missed + ':' +
              t.rows.map(function (r) { return (r.period.start ? r.period.start.getTime() : '') + '~' + (r.period.end ? r.period.end.getTime() : '') + r.status + (r.doneAt ? r.doneAt.getTime() : ''); }).join(','));
          });
        });
      });
    });
    return parts.join('|');
  }

  function refresh(force) {
    clearTimeout(state.timer);
    if (UI.isDialogOpen()) { UI.whenDialogsClosed(function () { refresh(true); }); return; }
    if (!force && pointerHeld()) { state.timer = setTimeout(function () { refresh(false); }, 250); return; }
    var d = Store.get();
    var at = Reset.now();
    var limits = {};
    Object.keys(state.limits).forEach(function (k) { limits[k] = state.limits[k]; });
    var model = Reset.buildHistory({ games: d.games, groups: d.groups, tasks: d.tasks, records: d.records, groupRecords: d.groupRecords, at: at, limits: limits });
    var sig = sigOf(model); // 펼침은 DOM이 이미 사용자가 바꾼 상태라 비교에 넣지 않는다
    if (sig !== state.sig) {
      state.sig = sig;
      state.model = model;
      render(model, at);
    }
    // 리셋 순간에 새 기간이 생기므로 가장 빠른 리셋 직후에 다시 계산한다 (길어도 60초)
    state.timer = setTimeout(function () { refresh(false); }, Reset.resetDelay(model.remainingMs));
  }

  /* ---------- 입력 ---------- */

  // "더 보기": 새로 계산하되 그 숙제의 칸만 바꿔 끼운다 (전체를 다시 그리지 않는다)
  function loadMore(key) {
    clearTimeout(state.timer);
    var d = Store.get();
    var at = Reset.now();
    var model = Reset.buildHistory({ games: d.games, groups: d.groups, tasks: d.tasks, records: d.records, groupRecords: d.groupRecords, at: at, limits: state.limits });
    var found = null;
    model.games.forEach(function (gm) {
      gm.sections.forEach(function (s) { s.groups.forEach(function (g) { g.tasks.forEach(function (t) { if (gm.game.id + '/' + t.key === key) found = { gm: gm, t: t }; }); }); });
    });
    var old = host.querySelector('details[data-key="' + key + '"]');
    var sig = sigOf(model);
    if (!found || !old) { state.sig = null; refresh(true); return; }
    var wasOpen = old.open;
    state.open[key] = true; // 더 보기를 눌렀으니 펼쳐 둔다
    var fresh = taskBlock(found.gm, found.t, at);
    old.parentNode.replaceChild(fresh, old);
    state.sig = sig; // 다른 숙제가 같이 바뀌었다면 다음 갱신(sig 불일치)이 맞춘다
    state.model = model;
    var btn = fresh.querySelector('button[data-more]');
    (btn || fresh.querySelector('summary')).focus();
    state.timer = setTimeout(function () { refresh(false); }, Reset.resetDelay(model.remainingMs));
    return wasOpen;
  }

  host.addEventListener('click', function (e) {
    var more = e.target.closest ? e.target.closest('button[data-more]') : null;
    if (more && host.contains(more)) {
      var lk = more.getAttribute('data-limit-key');
      state.limits[lk] = (+more.getAttribute('data-shown') || STEP) + STEP;
      loadMore(more.getAttribute('data-more'));
      return;
    }
    // 펼침은 사용자가 직접 바꾼 것만 기억한다 (클릭은 열림 상태가 바뀌기 전에 온다)
    var sum = e.target.closest ? e.target.closest('summary') : null;
    if (sum && host.contains(sum)) {
      var det = sum.parentNode, dkey = det.getAttribute('data-key');
      state.open[dkey] = !det.open;
      var info = state.index[dkey], bodyEl = det.querySelector('.htask-body');
      if (!det.open && info && bodyEl && !bodyEl.firstChild) rowsBody(info.gm, info.t, info.at).forEach(function (n) { bodyEl.appendChild(n); });
    }
  });

  document.addEventListener('pointerdown', function () { state.pressed = true; state.pressedAt = Date.now(); }, true);
  ['pointerup', 'pointercancel', 'dragend'].forEach(function (name) {
    document.addEventListener(name, function () { state.pressed = false; }, true);
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(false); });

  refresh(true);
})();
