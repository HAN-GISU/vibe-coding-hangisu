/*
 * 메인 화면 (index.html): 게임 → 묶음 → 숙제를 보여 주고, 체크하고, 한 번에 체크한다. (CLAUDE.md 4장)
 * 판정은 모두 Reset.evaluateGame이 하고, 이 파일은 그 결과를 그리는 일과 체크 호출만 한다.
 *
 * 다시 그리기: 구조(게임·묶음·숙제·폴더의 id·순서·이름)가 바뀔 때만 DOM을 새로 만들고, 그 밖의 갱신은
 * 같은 요소의 글자·체크 상태만 바꾼다. 요소가 교체되지 않으니 누르는 도중에 다시 그려도 클릭이 사라지지 않는다.
 * 포인터가 눌려 있거나 대화상자가 열려 있는 동안은 갱신을 미룬다.
 */
(function () {
  'use strict';

  var UI = window.UI, Store = window.Store, Reset = window.Reset, el = UI.el;
  var host = document.getElementById('games');

  var state = {
    key: null,          // 마지막으로 만든 구조의 키
    model: null,        // 마지막 판정 결과
    refs: null,         // 구조 요소 모음 (묶음 id → 요소들)
    timer: null,
    pressed: false,     // 포인터가 눌려 있는 동안 true
    pressedAt: 0,
    collapsed: Object.create(null) // "묶음id/폴더id" → true (이 페이지가 열려 있는 동안만 기억)
  };

  /* ---------- 판정 ---------- */

  function buildModel() {
    var d = Store.get();
    var at = Reset.now();
    return {
      d: d, at: at,
      games: d.games.map(function (g) {
        return Reset.evaluateGame({ game: g, groups: d.groups, tasks: d.tasks, records: d.records, groupRecords: d.groupRecords, at: at });
      })
    };
  }

  // 화면 구조가 바뀌었는지 보는 키 (글자·체크 상태는 넣지 않는다)
  function structKey(model) {
    return JSON.stringify(model.games.map(function (gm) {
      return [gm.game.id, gm.game.name, gm.game.levels, gm.groups.map(function (g) {
        return [g.group.id, g.group.name, g.group.scope, g.group.required, g.group.low, g.cycle ? g.cycle.name : null,
          g.tasks.map(function (t) { return [t.id, t.name, t.low]; }),
          g.nodes ? g.nodes.map(function (n) { return [n.folder.id, n.folder.name, n.depth, n.isRow]; }) : null];
      })];
    }));
  }

  /* ---------- 글자 ---------- */

  function badge(text) { return el('span', { class: 'badge', text: text }); }

  function progressText(ev) {
    if (ev.empty) return '숙제가 없어요';
    if (ev.byGroupRecord) return '✓ 묶음 체크로 완료';
    return (ev.done ? '✓ ' : '') + ev.need + '개 중 ' + Math.min(ev.doneCount, ev.need) + '개';
  }

  // 남은 기간 글자. mode 'pending'은 D-N·시간·분·초, 'until'은 "리셋까지 …". 바뀔 때만 DOM을 건드린다.
  function setRemaining(span, rem, mode) {
    var key = mode + '|' + rem.kind + '|' + rem.text + '|' + rem.untilText;
    if (span.getAttribute('data-k') === key) return;
    span.setAttribute('data-k', key);
    span.textContent = '';
    if (rem.kind === 'none') { span.textContent = '기한 없음'; span.setAttribute('aria-label', '기한 없음'); return; }
    if (mode === 'until') { span.textContent = rem.untilText; span.setAttribute('aria-label', rem.untilText); return; }
    if (rem.kind === 'dday') {
      span.appendChild(el('span', { class: 'dn', text: rem.label }));
      span.appendChild(el('span', { class: 'dn-detail', text: ' · ' + rem.detail }));
      span.setAttribute('aria-label', rem.label + ', ' + rem.detail + ' 남음');
      return;
    }
    span.textContent = rem.text;
    span.setAttribute('aria-label', rem.text + ' 남음');
  }

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  /* ---------- 구조 만들기 ---------- */

  function emptyCard(title, text, linkText) {
    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: title })]),
      el('div', { class: 'card-body' }, [el('p', { class: 'empty', text: text })]),
      el('div', { class: 'card-foot' }, [linkText ? UI.navLink(linkText, 'settings.html', 'btn btn-primary') : null])
    ]);
  }

  function scopeText(game, group) { return group.scope === 'game' ? '게임 공통' : game.levels[group.scope - 1] + ' 마다'; }

  function buildAll(model) {
    host.textContent = '';
    state.refs = Object.create(null);
    if (!model.games.length) {
      var corrupted = Store.status().status === 'corrupted';
      host.appendChild(corrupted
        ? emptyCard('데이터를 읽지 못했어요', '저장된 데이터가 손상돼 있어서 지금은 보여 줄 수 없어요. 맨 위 안내를 확인해 주세요.', null)
        : emptyCard('아직 게임이 없어요', '설정에서 게임과 숙제를 만들면 여기에 모아서 보여 줘요.', '게임 추가하러 가기'));
      return;
    }
    model.games.forEach(function (gm) { host.appendChild(gameCard(gm)); });
  }

  function gameCard(gm) {
    var body;
    if (!gm.groups.length) {
      body = [el('p', { class: 'empty', text: '아직 묶음이 없어요. 설정에서 묶음과 숙제를 만들어 보세요.' }), UI.navLink('설정으로 가기', 'settings.html', 'btn btn-sm')];
    } else {
      body = gm.groups.map(function (gg) { return groupBlock(gm, gg); });
    }
    return el('section', { class: 'card game-card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: gm.game.name })]),
      el('div', { class: 'card-body' }, body)
    ]);
  }

  function groupBlock(gm, gg) {
    var g = gg.group;
    var ref = { gg: gg, mark: el('span', { class: 'gb-mark', hidden: true, role: 'img', 'aria-label': '완료', text: '✓' }),
      progress: el('span', { class: 'gb-progress' }), remaining: el('span', { class: 'gb-remaining' }), rows: Object.create(null), nodes: Object.create(null), tasks: Object.create(null), cols: Object.create(null) };
    state.refs[g.id] = ref;
    var head = el('div', { class: 'gb-head' }, [
      ref.mark, el('strong', { class: 'gb-name', text: g.name }),
      badge(gg.cycle ? gg.cycle.name : '주기 없음'), badge(scopeText(gm.game, g)), badge(g.required === null ? '전부' : g.required + '개 필요'),
      g.low ? badge('낮음') : null, ref.progress, ref.remaining
    ]);
    var body;
    if (!gg.tasks.length) body = el('p', { class: 'empty', text: '숙제가 없어요.' });
    else if (gg.kind === 'folders' && !gg.nodes.length) body = el('p', { class: 'empty', text: '폴더가 없어요. 설정에서 "' + gm.game.levels[g.scope - 1] + '" 폴더를 추가하면 여기에 표가 나와요.' });
    else if (gg.kind === 'game') body = taskList(gg, ref);
    else body = board(gm, gg, ref);
    return el('div', { class: 'gb', 'data-group': g.id }, [head, body]);
  }

  // 게임 공통 묶음: 숙제 목록
  function taskList(gg, ref) {
    ref.list = el('ul', { class: 'tasklist' });
    gg.tasks.forEach(function (t) {
      var box = el('input', { type: 'checkbox', 'data-cell': '1', 'data-task': t.id });
      var rem = el('span', { class: 'trow-remaining' });
      var li = el('li', { class: 'trow', 'data-task': t.id }, [
        el('label', { class: 'check' }, [box, el('span', { class: 'row-name', text: t.name }), t.low ? badge('낮음') : null]), rem
      ]);
      ref.tasks[t.id] = { li: li, box: box, rem: rem };
      ref.list.appendChild(li);
    });
    return ref.list;
  }

  // 단계 범위 묶음: 표 (행 = 범위 단계 폴더, 열 = 숙제)
  function board(gm, gg, ref) {
    var g = gg.group;
    var headRow = el('tr', {}, [el('th', { class: 'fcol', scope: 'col', text: '폴더' })]);
    gg.tasks.forEach(function (t) {
      var b = el('button', { type: 'button', class: 'col-head', 'data-col': t.id, 'data-group': g.id, text: t.name, title: '이 숙제를 표의 모든 폴더에 한 번에 완료 처리' });
      ref.cols[t.id] = b;
      headRow.appendChild(el('th', { scope: 'col' }, [b, t.low ? badge('낮음') : null]));
    });
    headRow.appendChild(el('th', { class: 'pcol', scope: 'col', text: '진행' }));
    var tbody = el('tbody');
    var colSpan = gg.tasks.length + 2;
    gg.nodes.forEach(function (n) {
      var f = n.folder;
      var anc = [], up = n.parentId, seen = Object.create(null);
      while (up != null && gg.byId[up] && !seen[up]) { seen[up] = true; anc.push(up); up = gg.byId[up].parentId; }
      var fbox = el('input', { type: 'checkbox', 'data-fcheck': '1', 'data-group': g.id, 'data-folder': f.id, 'aria-label': f.name + ' 전체 체크' });
      var toggle = el('button', { type: 'button', class: 'toggle' + (n.isRow ? ' toggle-leaf' : ''), 'data-toggle': g.id + '/' + f.id, 'aria-label': f.name + ' 접고 펼치기', 'aria-expanded': 'true', text: '▾' });
      var indent = el('span', { class: 'indent', style: 'width:' + Math.min(n.depth, 4) * 14 + 'px' });
      var tr;
      if (!n.isRow) {
        var count = el('span', { class: 'node-count' });
        tr = el('tr', { class: 'node', 'data-anc': anc.join(',') }, [
          el('td', { class: 'fcol', colspan: colSpan }, [indent, toggle, el('label', { class: 'check' }, [fbox, el('strong', { class: 'row-name', text: f.name })]), count])
        ]);
        ref.nodes[f.id] = { tr: tr, fbox: fbox, count: count, toggle: toggle, anc: anc };
      } else {
        var prog = el('td', { class: 'pcol' });
        var cells = gg.tasks.map(function (t) {
          var box = el('input', { type: 'checkbox', 'data-cell': '1', 'data-task': t.id, 'data-folder': f.id, 'aria-label': f.name + ' ' + t.name });
          var td = el('td', { class: 'cell', 'data-label': t.name }, [box]);
          return { td: td, box: box };
        });
        tr = el('tr', { class: 'frow', 'data-anc': anc.join(',') }, [
          el('td', { class: 'fcol' }, [indent, toggle, el('label', { class: 'check' }, [fbox, el('span', { class: 'row-name', text: f.name })])])
        ].concat(cells.map(function (c) { return c.td; })).concat([prog]));
        ref.rows[f.id] = { tr: tr, fbox: fbox, cells: cells, prog: prog, toggle: toggle, anc: anc };
      }
      tbody.appendChild(tr);
    });
    var table = el('table', { class: 'board', 'aria-label': g.name + ' 표' }, [el('thead', {}, [headRow]), tbody]);
    ref.table = table;
    return el('div', { class: 'board-wrap' }, [table]);
  }

  /* ---------- 갱신 (제자리 바꾸기) ---------- */

  function patch(model) {
    model.games.forEach(function (gm) {
      gm.groups.forEach(function (gg) {
        var ref = state.refs[gg.group.id];
        if (!ref) return;
        ref.gg = gg;
        patchHead(ref, gg);
        if (gg.kind === 'game') patchList(ref, gg);
        else if (gg.tasks.length && ref.table) patchBoard(ref, gg);
      });
    });
  }

  function patchHead(ref, gg) {
    var s = gg.summary;
    ref.mark.hidden = !s.allDone;
    // 남은 기간: 안 한 것이 있으면 D-N·시간·분·초, 전부 했으면 "리셋까지 …" (표는 묶음 머리에 한 번만)
    if (s.empty) { ref.remaining.removeAttribute('data-k'); ref.remaining.removeAttribute('aria-label'); setText(ref.remaining, ''); }
    else if (s.anyPending) setRemaining(ref.remaining, gg.remaining, 'pending');
    else setRemaining(ref.remaining, gg.remaining, 'until');
    ref.progress.hidden = gg.kind !== 'game';
    if (gg.kind === 'game' && gg.tasks.length) setText(ref.progress, progressText(gg.ev));
  }

  function patchList(ref, gg) {
    if (!ref.list) return;
    var ev = gg.ev;
    var order = [];
    ev.tasks.forEach(function (s, i) {
      var t = gg.tasks[i], r = ref.tasks[t.id];
      if (!r) return;
      r.box.checked = s.state === 'done';
      r.box.disabled = s.state === 'skipped';
      r.li.classList.toggle('is-done', s.state === 'done');
      r.li.classList.toggle('is-skipped', s.state === 'skipped');
      if (s.state === 'todo') setRemaining(r.rem, gg.remaining, 'pending');
      else if (s.state === 'skipped') { r.rem.removeAttribute('data-k'); setText(r.rem, '할 필요 없음'); r.rem.removeAttribute('aria-label'); }
      else setRemaining(r.rem, gg.remaining, 'until');
      order.push({ id: t.id, rank: s.state === 'todo' ? 0 : 1, i: i });
    });
    // 안 한 숙제를 위에, 완료한 숙제는 아래쪽에 (각각 설정한 순서)
    order.sort(function (a, b) { return a.rank - b.rank || a.i - b.i; });
    var cur = Array.prototype.map.call(ref.list.children, function (li) { return li.getAttribute('data-task'); });
    var want = order.map(function (o) { return o.id; });
    if (cur.join('|') !== want.join('|')) want.forEach(function (id) { ref.list.appendChild(ref.tasks[id].li); });
  }

  function patchBoard(ref, gg) {
    var g = gg.group;
    gg.columns.forEach(function (c) {
      var b = ref.cols[c.task.id];
      if (b) { b.disabled = c.pending === 0; b.title = c.pending === 0 ? '완료 처리할 폴더가 없어요' : '이 숙제를 안 한 ' + c.pending + '곳에 한 번에 완료 처리'; }
    });
    gg.nodes.forEach(function (n) {
      var f = n.folder, cb = n.checkbox;
      var r = n.isRow ? ref.rows[f.id] : ref.nodes[f.id];
      if (!r) return;
      r.fbox.checked = cb.state === 'all';
      r.fbox.indeterminate = cb.state === 'some';
      r.fbox.hidden = cb.state === 'hidden';
      var collapsedByAncestor = r.anc.some(function (a) { return state.collapsed[g.id + '/' + a]; });
      r.tr.hidden = collapsedByAncestor;
      var closed = !!state.collapsed[g.id + '/' + f.id];
      r.toggle.setAttribute('aria-expanded', closed ? 'false' : 'true');
      setText(r.toggle, closed ? '▸' : '▾');
      if (n.isRow) {
        r.tr.classList.toggle('is-collapsed', closed);
        r.tr.classList.toggle('is-off', n.ev.off || n.ev.empty);
        r.tr.classList.toggle('is-done', n.ev.done);
        setText(r.prog, n.ev.off ? '안 함' : progressText(n.ev));
        r.cells.forEach(function (c, i) {
          var s = n.ev.tasks[i]; // 묶음을 끈 폴더는 숙제 상태가 없다
          c.td.classList.toggle('is-off', !s || s.state === 'off');
          c.td.classList.toggle('is-skipped', !!s && s.state === 'skipped');
          c.box.checked = !!s && s.state === 'done';
          c.box.disabled = !s || s.state === 'skipped';
        });
      } else {
        setText(r.count, cb.state === 'hidden' ? '' : cb.done + '/' + cb.targets + '곳');
      }
    });
  }

  /* ---------- 표가 넘치면 목록으로 ---------- */

  function fitBoards(full) {
    Array.prototype.forEach.call(host.querySelectorAll('table.board'), function (t) {
      var wrap = t.parentNode;
      if (!wrap.clientWidth) return;
      if (full) t.classList.remove('as-list'); // 표 상태에서 재야 하니 먼저 표로 돌린다
      if (t.classList.contains('as-list')) return;
      // 넘치거나, 폴더 이름 칸이 줄바꿈될 만큼 좁아지면 목록으로 바꾼다
      var first = t.querySelector('tr.frow td.fcol');
      var narrow = first ? first.offsetWidth < 130 : false;
      t.classList.toggle('as-list', t.offsetWidth > wrap.clientWidth + 1 || narrow);
    });
  }

  /* ---------- 갱신 시점 ---------- */

  function schedule(model) {
    clearTimeout(state.timer);
    var list = [];
    model.games.forEach(function (gm) { gm.groups.forEach(function (gg) { gg.remainingMs.forEach(function (ms) { list.push(ms); }); }); });
    state.timer = setTimeout(function () { refresh(false); }, Reset.redrawDelay(list));
  }

  function pointerHeld() {
    if (!state.pressed) return false;
    if (Date.now() - state.pressedAt > 3000) { state.pressed = false; return false; } // pointerup을 놓쳤을 때를 대비
    return true;
  }

  // force가 true이면 포인터가 눌려 있어도 바로 한다 (체크 직후처럼 방금 놓은 경우).
  function refreshAfterDialogs() { refresh(true); }

  function refresh(force) {
    clearTimeout(state.timer);
    if (UI.isDialogOpen()) { UI.whenDialogsClosed(refreshAfterDialogs); return; }
    if (!force && pointerHeld()) { state.timer = setTimeout(function () { refresh(false); }, 250); return; }
    var model = buildModel();
    var key = structKey(model);
    var rebuilt = key !== state.key;
    if (rebuilt) { buildAll(model); state.key = key; }
    state.model = model;
    patch(model);
    fitBoards(rebuilt);
    schedule(model);
  }

  /* ---------- 체크 ---------- */

  function findGroup(groupId) {
    var found = null;
    if (state.model) state.model.games.forEach(function (gm) { gm.groups.forEach(function (gg) { if (gg.group.id === groupId) found = gg; }); });
    return found;
  }

  // 실패하면 페이지 안 안내로 알리고 false
  function report(r) {
    if (!r.ok) { UI.notice(r.error); return false; }
    UI.notice('');
    return true;
  }

  function onCell(box) {
    var args = { taskId: box.getAttribute('data-task'), folderId: box.getAttribute('data-folder') || null, at: Reset.now() };
    report(box.checked ? Store.checkTask(args) : Store.uncheckTask(args));
    refresh(true);
  }

  function onFolderCheck(box) {
    var groupId = box.getAttribute('data-group'), folderId = box.getAttribute('data-folder');
    var gg = findGroup(groupId), node = gg && gg.byId ? gg.byId[folderId] : null;
    if (!node) { refresh(true); return; }
    var name = node.folder.name, cb = node.checkbox, args = { groupId: groupId, folderId: folderId };
    if (cb.state === 'all') {
      // 완료한 폴더의 체크를 풀면 확인 창을 거쳐 이번 기간 기록만 지운다
      UI.confirm({
        title: '"' + name + '" 체크를 해제할까요?',
        message: '이 폴더' + (cb.targets > 1 ? '(와 아래 폴더) ' + cb.targets + '곳' : '') + '의 이번 기간 완료 기록을 지워요. 지난 기간 기록은 그대로예요.',
        confirmLabel: '해제', danger: true,
        onConfirm: function () { var r = Store.uncheckFolder(Object.assign({ at: Reset.now() }, args)); return r.ok ? { ok: true } : r; }
      }).then(function () { refresh(true); });
    } else if (cb.pending >= 2) {
      // 상위 폴더처럼 여러 곳이 한 번에 바뀔 때는 확인 창
      UI.confirm({
        title: '"' + name + '" 아래 ' + cb.pending + '곳을 완료 처리할까요?',
        message: '안 한 폴더마다 이번 기간 완료 기록을 남겨요. 이미 한 것과 끈 것은 건너뛰어요.',
        confirmLabel: '완료 처리',
        onConfirm: function () { var r = Store.checkFolder(Object.assign({ at: Reset.now() }, args)); return r.ok ? { ok: true } : r; }
      }).then(function () { refresh(true); });
    } else {
      report(Store.checkFolder(Object.assign({ at: Reset.now() }, args)));
      refresh(true);
    }
  }

  function onColumn(btn) {
    var groupId = btn.getAttribute('data-group'), taskId = btn.getAttribute('data-col');
    var gg = findGroup(groupId);
    if (!gg) return;
    var col = gg.columns.filter(function (c) { return c.task.id === taskId; })[0];
    if (!col || col.pending === 0) return;
    UI.confirm({
      title: '"' + col.task.name + '" 숙제를 완료 처리할까요?',
      message: '이 표에서 아직 안 한 ' + col.pending + '곳에 이번 기간 완료 기록을 남겨요. 이미 한 것과 끈 것은 건너뛰어요.',
      confirmLabel: '완료 처리',
      onConfirm: function () { var r = Store.checkColumn({ taskId: taskId, at: Reset.now() }); return r.ok ? { ok: true } : r; }
    }).then(function () { refresh(true); });
  }

  function onToggle(btn) {
    var key = btn.getAttribute('data-toggle');
    state.collapsed[key] = !state.collapsed[key];
    if (state.model) patch(state.model);
  }

  /* ---------- 시작 ---------- */

  host.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('input[data-cell]')) onCell(t);
    else if (t.matches('input[data-fcheck]')) onFolderCheck(t);
  });
  host.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b || !host.contains(b)) return;
    if (b.hasAttribute('data-col')) onColumn(b);
    else if (b.hasAttribute('data-toggle')) onToggle(b);
  });

  // 눌려 있는 동안에는 다시 그리지 않는다 (누른 칸이 바뀌어 클릭이 사라지는 것을 막는다)
  document.addEventListener('pointerdown', function () { state.pressed = true; state.pressedAt = Date.now(); }, true);
  ['pointerup', 'pointercancel', 'dragend'].forEach(function (name) {
    document.addEventListener(name, function () { state.pressed = false; }, true);
  });

  // 탭이 다시 보이면 바로 다시 그린다. 다른 탭에서 바뀐 내용도 이때 따라온다 (Store.get이 저장소를 다시 읽는다).
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(false); });

  // 폭이 바뀌면 표가 넘치는지 다시 본다
  var lastWidth = host.clientWidth;
  function onResize() {
    if (host.clientWidth === lastWidth) return;
    lastWidth = host.clientWidth;
    fitBoards(true);
  }
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(host);
  else window.addEventListener('resize', onResize);

  refresh(true);
})();
