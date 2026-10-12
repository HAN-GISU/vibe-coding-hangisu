/*
 * 설정 화면 (settings.html): 게임, 리셋 주기, 단계, 폴더, 묶음, 숙제를 만들고 고치고 지운다. (CLAUDE.md 4장)
 * 데이터를 바꾸는 규칙은 Store.ops에 있고, 이 파일은 그리기와 Store.apply 호출만 한다.
 * 모든 확인·입력·오류는 <dialog>와 페이지 안 안내로 보여 준다 (alert·confirm·prompt를 쓰지 않는다).
 */
(function () {
  'use strict';

  var UI = window.UI, Store = window.Store, Reset = window.Reset, O = Store.ops, el = UI.el;
  var app = document.getElementById('app');
  var state = { gameId: null };
  var DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  var FIXED_DELETE = '완료 기록도 함께 지워져요';

  /* ---------- 작은 도구 ---------- */

  function two(n) { return n < 10 ? '0' + n : String(n); }

  function currentGame(d) {
    var found = null;
    d.games.forEach(function (g) { if (g.id === state.gameId) found = g; });
    if (!found && d.games.length) found = d.games[0];
    state.gameId = found ? found.id : null;
    return found;
  }

  function cycleSummary(c) {
    function every(e) {
      var p = [];
      if (e.days) p.push(e.days + '일');
      if (e.hours) p.push(e.hours + '시간');
      if (e.minutes) p.push(e.minutes + '분');
      return p.join(' ');
    }
    if (c.type === 'daily') return '매일 ' + c.time;
    if (c.type === 'weekly') return '매주 ' + DAYS[c.day] + ' ' + c.time;
    if (c.type === 'monthly') return '매월 ' + c.date + '일 ' + c.time;
    if (c.type === 'interval') {
      var a = Reset.parseTime(c.anchor);
      return (a ? two(a.getMonth() + 1) + '/' + two(a.getDate()) + ' ' + two(a.getHours()) + ':' + two(a.getMinutes()) : '?') + '부터 ' + every(c.every) + '마다';
    }
    return '1회 (리셋 없음)';
  }

  function badge(text) { return el('span', { class: 'badge', text: text }); }
  function actionBtn(label, onclick) { return el('button', { type: 'button', class: 'btn btn-sm', text: '작업', 'aria-label': label + ' 작업', onclick: onclick }); }
  function card(title, desc, body, foot) {
    return el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: title }), desc ? el('p', { class: 'card-desc', text: desc }) : null]),
      el('div', { class: 'card-body' }, body),
      foot && foot.length ? el('div', { class: 'card-foot' }, foot) : null
    ]);
  }
  function btn(text, onclick, kind, disabled) {
    return el('button', { type: 'button', class: 'btn' + (kind ? ' btn-' + kind : ''), text: text, onclick: onclick, disabled: disabled === true });
  }

  function folderPath(g, f) {
    var byId = Object.create(null);
    g.folders.forEach(function (x) { byId[x.id] = x; });
    var names = [], seen = Object.create(null), cur = f;
    while (cur && !seen[cur.id]) { seen[cur.id] = true; names.unshift(cur.name); cur = cur.parentId ? byId[cur.parentId] : null; }
    return names.join(' › ');
  }

  // 열린 대화상자가 닫힌 뒤, 초점이 사라졌으면 본문으로 돌린다
  function afterModal(p) {
    return p.then(function () {
      if (document.activeElement === document.body || !document.body.contains(document.activeElement)) app.focus({ preventScroll: true });
    });
  }

  // 대화상자 밖 작업(위로·아래로 등): 실패하면 페이지 안 안내로 알린다
  function quick(fn) {
    var r = Store.apply(fn);
    if (!r.ok) { UI.notice(r.error); return false; }
    UI.notice('');
    render();
    return true;
  }

  // 대화상자 안 작업: 성공하면 다시 그리고, 실패하면 그 오류를 대화상자 안에 보여 준다
  function commit(fn, after) {
    var r = Store.apply(fn);
    if (!r.ok) return r;
    if (after) after(r);
    render();
    return { ok: true };
  }

  function countText(parts) {
    return '지워질 것: ' + parts.map(function (p) { return p[0] + ' ' + p[1] + '개'; }).join(', ');
  }

  // 지우기 확인 창 (게임·폴더·묶음·숙제). 고정 문장과 개수 줄을 꼭 보여 준다.
  function confirmDelete(title, message, countParts, run) {
    afterModal(UI.confirm({
      title: title,
      message: message,
      lines: [{ text: FIXED_DELETE, strong: true }, countText(countParts)],
      confirmLabel: '삭제', danger: true,
      onConfirm: run
    }));
  }

  /* ---------- 입력 대화상자 ---------- */

  function nameDialog(o) {
    var id = UI.nextId('f');
    var input = el('input', { class: 'input', type: 'text', id: id, value: o.initial || '', maxlength: 100, autocomplete: 'off' });
    return afterModal(UI.modal({
      title: o.title, description: o.description,
      body: UI.field(o.label || '이름', input, o.hint),
      submitLabel: o.submitLabel,
      onSubmit: function () { return o.onSubmit(input.value); }
    }));
  }

  function linesDialog(o) {
    var id = UI.nextId('f');
    var area = el('textarea', { class: 'textarea', id: id, rows: 8, placeholder: o.placeholder || '', spellcheck: 'false' });
    return afterModal(UI.modal({
      title: o.title, description: o.description,
      body: UI.field(o.label, area, o.hint),
      submitLabel: o.submitLabel || '추가',
      onSubmit: function () { return o.onSubmit(area.value); }
    }));
  }

  /* ---------- 그리기 ---------- */

  function render() {
    var d = Store.get();
    var g = currentGame(d);
    app.textContent = '';
    app.appendChild(el('h1', { class: 'page-title', text: '설정' }));
    app.appendChild(el('p', { class: 'page-desc', text: '게임, 리셋 주기, 단계, 폴더, 묶음, 숙제를 만들고 고칩니다. 바꾼 내용은 이 브라우저에 바로 저장돼요.' }));
    app.appendChild(el('div', { class: 'layout' }, [gamesCard(d, g), g ? editor(d, g) : emptyEditor()]));
    UI.refreshStorageBanner();
  }

  function gamesCard(d, g) {
    var list = d.games.length
      ? el('ul', { class: 'list' }, d.games.map(function (x) {
        return el('li', {}, el('button', { type: 'button', class: 'game-item', 'aria-current': g && x.id === g.id ? 'true' : null, onclick: function () { state.gameId = x.id; render(); } }, [
          el('span', { class: 'row-name', text: x.name })
        ]));
      }))
      : el('p', { class: 'empty', text: '아직 게임이 없어요.' });
    return card('게임', '관리할 게임을 고르세요.', list, [btn('+ 게임 추가', addGame, 'primary')]);
  }

  function emptyEditor() {
    var corrupted = Store.status().status === 'corrupted';
    return card('시작하기', null, [el('p', { class: 'empty', text: corrupted
      ? '저장된 데이터가 손상돼 있어서 지금은 변경할 수 없어요. 맨 위 안내를 확인해 주세요.'
      : '게임을 추가하면 여기에서 리셋 주기, 단계, 폴더, 묶음, 숙제를 만들 수 있어요.' })]);
  }

  function editor(d, g) {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'editor-head' }, [el('h2', { text: g.name }), btn('게임 작업', function () { gameSheet(g); })]),
      cyclesCard(g), levelsCard(g), foldersCard(d, g), groupsCard(d, g)
    ]);
  }

  /* ---------- 게임 ---------- */

  function addGame() {
    nameDialog({
      title: '게임 추가', label: '게임 이름', submitLabel: '추가',
      onSubmit: function (name) { return commit(function (d) { return O.addGame(d, name); }, function (r) { state.gameId = r.id; }); }
    });
  }

  function gameSheet(g) {
    afterModal(UI.sheet({
      title: g.name,
      actions: [
        { label: '이름 바꾸기', onClick: function () { renameGame(g); } },
        { label: '위로', onClick: function () { quick(function (d) { return O.moveGame(d, g.id, -1); }); } },
        { label: '아래로', onClick: function () { quick(function (d) { return O.moveGame(d, g.id, 1); }); } },
        { label: '삭제', danger: true, onClick: function () { deleteGame(g); } }
      ]
    }));
  }

  function renameGame(g) {
    nameDialog({
      title: '게임 이름 바꾸기', label: '게임 이름', initial: g.name,
      onSubmit: function (name) { return commit(function (d) { return O.renameGame(d, g.id, name); }); }
    });
  }

  function deleteGame(g) {
    var i = O.impactGame(Store.get(), g.id);
    confirmDelete('게임을 지울까요?', '"' + g.name + '" 게임을 지워요.',
      [['리셋 주기', i.cycles], ['단계', i.levels], ['폴더', i.folders], ['묶음', i.groups], ['숙제', i.tasks], ['완료 기록', i.records], ['묶음 완료 기록', i.groupRecords]],
      function () { return commit(function (d) { return O.deleteGame(d, g.id); }); });
  }

  /* ---------- 리셋 주기 ---------- */

  function cyclesCard(g) {
    var body = g.cycles.length
      ? el('ul', { class: 'list' }, g.cycles.map(function (c) {
        return el('li', { class: 'row' }, [
          el('div', { class: 'row-main' }, [el('span', { class: 'row-name', text: c.name }), badge(cycleSummary(c))]),
          actionBtn(c.name, function () { cycleSheet(g, c); })
        ]);
      }))
      : el('p', { class: 'empty', text: '아직 리셋 주기가 없어요. + 버튼으로 추가하세요.' });
    return card('리셋 주기', '묶음이 어느 시각에 새로 시작할지 정해요. 시각은 분 단위까지 고를 수 있어요.', body, [btn('+ 리셋 주기 추가', function () { cycleDialog(g, null); })]);
  }

  function cycleSheet(g, c) {
    afterModal(UI.sheet({
      title: c.name, description: cycleSummary(c),
      actions: [
        { label: '수정', onClick: function () { cycleDialog(g, c); } },
        { label: '삭제', danger: true, onClick: function () { deleteCycle(g, c); } }
      ]
    }));
  }

  function deleteCycle(g, c) {
    var r = O.canDeleteCycle(Store.get(), g.id, c.id);
    if (!r.ok) { afterModal(UI.info({ title: '지울 수 없어요', message: r.error })); return; }
    afterModal(UI.confirm({
      title: '리셋 주기를 지울까요?', message: '"' + c.name + '" 주기를 지워요.', confirmLabel: '삭제', danger: true,
      onConfirm: function () { return commit(function (d) { return O.deleteCycle(d, g.id, c.id); }); }
    }));
  }

  // 리셋 주기 추가·수정 창. cycle이 null이면 추가.
  function cycleDialog(g, cycle) {
    var c = cycle || { name: '', type: 'daily', time: '05:00' };
    var vals = {
      time: c.time || '05:00',
      day: c.day === undefined ? 1 : c.day,
      date: c.date === undefined ? 1 : c.date,
      anchor: c.anchor ? Reset.formatIso(Reset.parseTime(c.anchor)).slice(0, 16) : '',
      days: c.every ? c.every.days || 0 : 0, hours: c.every ? c.every.hours || 0 : 0, minutes: c.every ? c.every.minutes || 0 : 0
    };
    var ctl = {};
    var nameId = UI.nextId('f'), typeId = UI.nextId('f');
    var nameIn = el('input', { class: 'input', type: 'text', id: nameId, value: c.name, maxlength: 100, autocomplete: 'off' });
    var typeSel = el('select', { class: 'select', id: typeId, value: c.type }, [
      el('option', { value: 'daily', text: '매일' }), el('option', { value: 'weekly', text: '매주' }), el('option', { value: 'monthly', text: '매월' }),
      el('option', { value: 'interval', text: '간격 (N일 N시간 N분마다)' }), el('option', { value: 'once', text: '1회 (리셋 없음)' })
    ]);
    var box = el('div');

    function sync() {
      if (ctl.time) vals.time = ctl.time.value;
      if (ctl.day) vals.day = ctl.day.value;
      if (ctl.date) vals.date = ctl.date.value;
      if (ctl.anchor) vals.anchor = ctl.anchor.value;
      if (ctl.days) { vals.days = ctl.days.value; vals.hours = ctl.hours.value; vals.minutes = ctl.minutes.value; }
    }
    function timeField() {
      var id = UI.nextId('f');
      ctl.time = el('input', { class: 'input', type: 'time', step: '60', id: id, value: vals.time });
      return UI.field('시각', ctl.time, '분 단위까지 정할 수 있어요.');
    }
    function build() {
      sync();
      ctl = {};
      box.textContent = '';
      var t = typeSel.value;
      if (t === 'daily') box.appendChild(timeField());
      if (t === 'weekly') {
        var did = UI.nextId('f');
        ctl.day = el('select', { class: 'select', id: did, value: String(vals.day) }, DAYS.map(function (n, i) { return el('option', { value: String(i), text: n + '요일' }); }));
        box.appendChild(UI.field('요일', ctl.day));
        box.appendChild(timeField());
      }
      if (t === 'monthly') {
        var mid = UI.nextId('f'), opts = [];
        for (var i = 1; i <= 28; i++) opts.push(el('option', { value: String(i), text: i + '일' }));
        ctl.date = el('select', { class: 'select', id: mid, value: String(vals.date) }, opts);
        box.appendChild(UI.field('날짜', ctl.date, '모든 달에 있는 1~28일만 고를 수 있어요.'));
        box.appendChild(timeField());
      }
      if (t === 'interval') {
        var aid = UI.nextId('f');
        ctl.anchor = el('input', { class: 'input', type: 'datetime-local', step: '60', id: aid, value: vals.anchor });
        box.appendChild(UI.field('기준 시각', ctl.anchor, '이 시각부터 아래 간격마다 새로 시작해요. 기준 시각 이전에도 같은 간격이 이어져요.'));
        var ids = [UI.nextId('f'), UI.nextId('f'), UI.nextId('f')];
        ctl.days = el('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', id: ids[0], value: String(vals.days) });
        ctl.hours = el('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', id: ids[1], value: String(vals.hours) });
        ctl.minutes = el('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', id: ids[2], value: String(vals.minutes) });
        box.appendChild(el('div', { class: 'field' }, [
          el('span', { class: 'label', text: '간격' }),
          el('div', { class: 'inline-fields' }, [
            el('label', { class: 'check', for: ids[0] }, ['일', ctl.days]), el('label', { class: 'check', for: ids[1] }, ['시간', ctl.hours]), el('label', { class: 'check', for: ids[2] }, ['분', ctl.minutes])
          ])
        ]));
      }
      if (t === 'once') box.appendChild(el('p', { class: 'hint', text: '리셋 없이 한 번만 하는 숙제에 써요. 한 번이라도 체크하면 계속 완료예요.' }));
    }
    typeSel.addEventListener('change', build);
    build();

    function num(v) { return v === '' || v === undefined ? 0 : Number(v); }
    function collect() {
      sync();
      return {
        name: nameIn.value, type: typeSel.value, time: vals.time, day: Number(vals.day), date: Number(vals.date), anchor: vals.anchor,
        every: { days: num(vals.days), hours: num(vals.hours), minutes: num(vals.minutes) }
      };
    }

    afterModal(UI.modal({
      title: cycle ? '리셋 주기 수정' : '리셋 주기 추가',
      description: cycle ? '시각이나 종류를 바꿔도 이미 한 체크는 그대로 유지돼요.' : null,
      body: el('div', {}, [UI.field('이름', nameIn, '예: 일일, 주간'), UI.field('종류', typeSel), box]),
      submitLabel: cycle ? '저장' : '추가',
      onSubmit: function () {
        var f = collect();
        return commit(function (d) { return cycle ? O.updateCycle(d, g.id, cycle.id, f, Reset.now()) : O.addCycle(d, g.id, f); });
      }
    }));
  }

  /* ---------- 단계 ---------- */

  function levelsCard(g) {
    var body = g.levels.length
      ? el('ul', { class: 'list' }, g.levels.map(function (name, i) {
        return el('li', { class: 'row' }, [
          el('div', { class: 'row-main' }, [badge((i + 1) + '단계'), el('span', { class: 'row-name', text: name })]),
          actionBtn(name, function () { levelSheet(g, i + 1); })
        ]);
      }))
      : el('p', { class: 'empty', text: '단계가 없어요. 계정·캐릭터처럼 나눌 것이 없으면 그대로 두세요.' });
    var foot = g.levels.length
      ? [btn('+ 위로 단계 추가', function () { addLevel(g, true); }), btn('+ 아래로 단계 추가', function () { addLevel(g, false); })]
      : [btn('+ 단계 추가', function () { addLevel(g, false); })];
    return card('단계', '게임 안을 계정 › 캐릭터처럼 단계로 나눠요. 단계마다 폴더를 만들 수 있어요.', body, foot);
  }

  function addLevel(g, above) {
    nameDialog({
      title: above ? '위로 단계 추가' : '아래로 단계 추가', label: '단계 이름', submitLabel: '추가',
      description: above ? '맨 위에 새 단계를 끼워요. 지금 있는 폴더는 새로 생기는 맨 위 폴더 "기본" 안으로 들어가요. 이름은 나중에 바꿀 수 있어요.' : '맨 아래에 새 단계를 붙여요.',
      hint: '예: 계정, 캐릭터',
      onSubmit: function (name) { return commit(function (d) { return above ? O.addLevelAbove(d, g.id, name) : O.addLevelBelow(d, g.id, name); }); }
    });
  }

  function levelSheet(g, level) {
    afterModal(UI.sheet({
      title: (level) + '단계: ' + g.levels[level - 1],
      actions: [
        { label: '이름 바꾸기', onClick: function () {
          nameDialog({ title: '단계 이름 바꾸기', label: '단계 이름', initial: g.levels[level - 1], onSubmit: function (name) { return commit(function (d) { return O.renameLevel(d, g.id, level, name); }); } });
        } },
        { label: '삭제', danger: true, onClick: function () { deleteLevel(g, level); } }
      ]
    }));
  }

  // 단계는 폴더도 묶음도 없을 때만 지울 수 있다. 지워지는 기록이 없으므로 "완료 기록도…" 문장은 넣지 않는다.
  function deleteLevel(g, level) {
    var r = O.canDeleteLevel(Store.get(), g.id, level);
    if (!r.ok) { afterModal(UI.info({ title: '지울 수 없어요', message: r.error })); return; }
    afterModal(UI.confirm({
      title: '단계를 지울까요?', message: '"' + g.levels[level - 1] + '" 단계를 지워요. 이 단계에는 폴더와 묶음이 없어요.', confirmLabel: '삭제', danger: true,
      onConfirm: function () { return commit(function (d) { return O.deleteLevel(d, g.id, level); }); }
    }));
  }

  /* ---------- 폴더 ---------- */

  function foldersCard(d, g) {
    var list = O.folderList(d, g.id);
    var body;
    if (!g.levels.length) body = el('p', { class: 'empty', text: '폴더를 만들려면 먼저 단계를 추가하세요.' });
    else if (!list.length) body = el('p', { class: 'empty', text: '아직 폴더가 없어요. 폴더가 없으면 단계 범위 묶음은 체크할 곳이 없어요.' });
    else {
      body = el('ul', { class: 'list' }, list.map(function (x) {
        var f = x.folder;
        return el('li', { class: 'row' }, [
          el('span', { class: 'row-indent', style: 'width:' + Math.min(x.depth, 5) * 16 + 'px' }),
          el('div', { class: 'row-main' }, [
            el('span', { class: 'row-name', text: f.name }), badge(g.levels[f.level - 1]),
            f.off.length ? badge('안 하는 것 ' + f.off.length + '개') : null
          ]),
          actionBtn(f.name, function () { folderSheet(g, f); })
        ]);
      }));
    }
    return card('폴더', '단계마다 계정·캐릭터 같은 폴더를 만들어요. 폴더는 기본으로 모든 묶음을 하고, 안 하는 것만 꺼요.', body,
      [btn('+ 폴더 여러 개 추가', function () { addFolders(g, null); }, null, !g.levels.length)]);
  }

  function addFolders(g, parent) {
    var startLevel = parent ? parent.level + 1 : 1;
    if (startLevel > g.levels.length) { afterModal(UI.info({ title: '추가할 수 없어요', message: '이 폴더는 마지막 단계라 아래에 폴더를 추가할 수 없어요.' })); return; }
    linesDialog({
      title: parent ? '"' + parent.name + '" 아래에 폴더 추가' : '폴더 여러 개 추가',
      description: g.levels[startLevel - 1] + ' 폴더를 한 줄에 하나씩 적어요. 아래 단계는 들여써서 적어요. 처음 들여쓴 줄의 공백 수(또는 탭 1개)가 한 단계가 되고, 아래 줄도 같은 칸 수로 맞춰요. 예: 공백 2칸.',
      label: '폴더 이름', placeholder: '본계정\n  캐릭터1\n  캐릭터2\n부계정\n  캐릭터3',
      hint: '빈 줄은 무시해요. 한 번에 500줄까지 추가할 수 있어요.',
      onSubmit: function (text) { return commit(function (d) { return O.addFolders(d, g.id, parent ? parent.id : null, text); }); }
    });
  }

  function folderSheet(g, f) {
    afterModal(UI.sheet({
      title: f.name, description: g.levels[f.level - 1] + ' 폴더',
      actions: [
        { label: '이름 바꾸기', onClick: function () {
          nameDialog({ title: '폴더 이름 바꾸기', label: '폴더 이름', initial: f.name, onSubmit: function (name) { return commit(function (dd) { return O.renameFolder(dd, f.id, name); }); } });
        } },
        f.level < g.levels.length ? { label: '아래에 폴더 추가', onClick: function () { addFolders(g, f); } } : null,
        { label: '안 하는 것 정하기', onClick: function () { offDialog(f); } },
        { label: '복제 (아래 폴더와 안 하는 것까지)', onClick: function () { quick(function (dd) { return O.cloneFolder(dd, f.id); }); } },
        f.level >= 2 ? { label: '다른 상위 폴더로 옮기기', onClick: function () { moveDialog(g, f); } } : null,
        { label: '위로', onClick: function () { quick(function (dd) { return O.moveFolder(dd, f.id, -1); }); } },
        { label: '아래로', onClick: function () { quick(function (dd) { return O.moveFolder(dd, f.id, 1); }); } },
        { label: '삭제', danger: true, onClick: function () { deleteFolder(f); } }
      ]
    }));
  }

  function moveDialog(g, f) {
    var d = Store.get();
    var parents = O.eligibleParents(d, f.id);
    var id = UI.nextId('f');
    var sel = el('select', { class: 'select', id: id, value: f.parentId }, parents.map(function (p) { return el('option', { value: p.id, text: folderPath(g, p) }); }));
    afterModal(UI.modal({
      title: '"' + f.name + '" 옮기기',
      description: '바로 위 단계(' + g.levels[f.level - 2] + ')의 폴더 안으로만 옮길 수 있어요. 아래 폴더와 완료 기록은 그대로 따라가요.',
      body: UI.field('새 상위 폴더', sel, parents.length < 2 ? '옮길 수 있는 다른 폴더가 아직 없어요.' : null),
      submitLabel: '옮기기',
      onSubmit: function () { return commit(function (dd) { return O.moveFolderTo(dd, f.id, sel.value); }); }
    }));
  }

  // 폴더에서 안 하는 묶음·숙제를 끄는 체크 목록
  function offDialog(f) {
    var d = Store.get();
    var rows = O.offList(d, f.id);
    var boxes = [];
    var body;
    if (!rows.length) {
      body = el('p', { class: 'empty', text: '끌 수 있는 묶음이 없어요. 이 단계 이상을 범위로 쓰는 묶음이 아직 없어요.' });
    } else {
      body = el('div', { class: 'choice-list' }, rows.map(function (r) {
        var cb = el('input', { type: 'checkbox', checked: r.own || r.inheritedFrom !== null, disabled: r.inheritedFrom !== null });
        if (r.inheritedFrom === null) boxes.push({ row: r, cb: cb });
        return el('label', { class: 'check' + (r.inheritedFrom !== null ? ' disabled' : ''), style: r.kind === 'task' ? 'margin-left:24px' : 'font-weight:600' }, [
          cb, el('span', { text: r.name }), r.inheritedFrom !== null ? el('span', { class: 'muted', text: '· 위 폴더 "' + r.inheritedFrom + '"에서 꺼짐' }) : null
        ]);
      }));
    }
    afterModal(UI.modal({
      title: '"' + f.name + '"에서 안 하는 것',
      description: '체크한 묶음·숙제는 이 폴더와 아래 폴더에서 하지 않아요.',
      body: body, submitLabel: '저장', hideSubmit: !rows.length, cancelLabel: rows.length ? '취소' : '닫기',
      onSubmit: function () {
        var changes = {}, any = false;
        boxes.forEach(function (b) { if (b.cb.checked !== b.row.own) { changes[b.row.id] = b.cb.checked; any = true; } });
        if (!any) return { ok: true };
        return commit(function (dd) { return O.setOff(dd, f.id, changes); });
      }
    }));
  }

  function deleteFolder(f) {
    var i = O.impactFolder(Store.get(), f.id);
    confirmDelete('폴더를 지울까요?', '"' + f.name + '" 폴더를 지워요. 아래 폴더도 함께 지워져요.',
      [['폴더', i.folders], ['완료 기록', i.records], ['묶음 완료 기록', i.groupRecords]],
      function () { return commit(function (d) { return O.deleteFolder(d, f.id); }); });
  }

  /* ---------- 묶음과 숙제 ---------- */

  function groupsCard(d, g) {
    var groups = d.groups.filter(function (x) { return x.gameId === g.id; });
    var body = groups.length ? groups.map(function (grp) { return groupBlock(d, g, grp); }) : el('p', { class: 'empty', text: '아직 묶음이 없어요. 묶음을 만들고 그 안에 숙제를 넣으세요.' });
    return card('묶음과 숙제', '같은 주기로 리셋되는 숙제를 묶음으로 모아요.', body, [btn('+ 묶음 추가', function () { groupDialog(g, null); })]);
  }

  function groupBlock(d, g, grp) {
    var cyc = g.cycles.filter(function (c) { return c.id === grp.cycleId; })[0];
    var tasks = d.tasks.filter(function (t) { return t.groupId === grp.id; });
    return el('div', { class: 'group-block' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'row-main' }, [
          el('strong', { class: 'row-name', text: grp.name }),
          badge(cyc ? cyc.name : '주기 없음'),
          badge(grp.scope === 'game' ? '게임 공통' : g.levels[grp.scope - 1] + ' 마다'),
          badge(grp.required === null ? '전부' : grp.required + '개 필요'),
          grp.low ? badge('낮음') : null
        ]),
        actionBtn(grp.name, function () { groupSheet(g, grp); })
      ]),
      tasks.length
        ? el('ul', { class: 'list' }, tasks.map(function (t) {
          return el('li', { class: 'row' }, [
            el('div', { class: 'row-main' }, [el('span', { class: 'row-name', text: t.name })]),
            el('label', { class: 'check' }, [
              el('input', { type: 'checkbox', checked: t.low, onchange: function (e) {
                var box = e.target, on = box.checked;
                if (!quick(function (dd) { return O.setTaskLow(dd, t.id, on); })) {
                  var saved = Store.get().tasks.filter(function (x) { return x.id === t.id; })[0];
                  box.checked = saved ? saved.low === true : !on; // 저장되지 않았으니 화면도 저장된 값으로
                }
              } }), '낮음'
            ]),
            actionBtn(t.name, function () { taskSheet(t); })
          ]);
        }))
        : el('p', { class: 'empty', text: '숙제가 없어요.' }),
      el('div', { class: 'card-foot', style: 'padding:8px 0 0' }, [btn('+ 숙제 여러 개 추가', function () { addTasks(grp); })])
    ]);
  }

  function groupSheet(g, grp) {
    afterModal(UI.sheet({
      title: grp.name,
      actions: [
        { label: '수정', onClick: function () { groupDialog(g, grp); } },
        { label: '숙제 여러 개 추가', onClick: function () { addTasks(grp); } },
        { label: '위로', onClick: function () { quick(function (d) { return O.moveGroup(d, grp.id, -1); }); } },
        { label: '아래로', onClick: function () { quick(function (d) { return O.moveGroup(d, grp.id, 1); }); } },
        { label: '삭제', danger: true, onClick: function () { deleteGroup(grp); } }
      ]
    }));
  }

  function deleteGroup(grp) {
    var i = O.impactGroup(Store.get(), grp.id);
    confirmDelete('묶음을 지울까요?', '"' + grp.name + '" 묶음을 지워요. 안의 숙제도 함께 지워져요.',
      [['숙제', i.tasks], ['완료 기록', i.records], ['묶음 완료 기록', i.groupRecords]],
      function () { return commit(function (d) { return O.deleteGroup(d, grp.id); }); });
  }

  // 묶음 추가·수정 창. grp가 null이면 추가.
  function groupDialog(g, grp) {
    if (!grp && !g.cycles.length) { afterModal(UI.info({ title: '묶음을 만들 수 없어요', message: '먼저 리셋 주기를 추가해 주세요. 묶음은 리셋 주기를 하나 골라야 해요.' })); return; }
    var locked = grp ? O.groupHasRecords(Store.get(), grp.id) : false;
    var v = grp || { name: '', cycleId: g.cycles[0].id, scope: 'game', required: null, low: false };
    var nameIn = el('input', { class: 'input', type: 'text', id: UI.nextId('f'), value: v.name, maxlength: 100, autocomplete: 'off' });
    var cycSel = el('select', { class: 'select', id: UI.nextId('f'), value: v.cycleId, disabled: locked }, g.cycles.map(function (c) { return el('option', { value: c.id, text: c.name + ' (' + cycleSummary(c) + ')' }); }));
    var scopeOpts = [el('option', { value: 'game', text: '게임 공통 (게임에 한 번만)' })].concat(g.levels.map(function (n, i) { return el('option', { value: String(i + 1), text: n + ' 마다' }); }));
    var scopeSel = el('select', { class: 'select', id: UI.nextId('f'), value: String(v.scope), disabled: locked }, scopeOpts);
    var reqName = UI.nextId('req');
    var radioAll = el('input', { type: 'radio', name: reqName, checked: v.required === null });
    var radioN = el('input', { type: 'radio', name: reqName, checked: v.required !== null });
    var reqNum = el('input', { class: 'input', type: 'number', min: '1', step: '1', inputmode: 'numeric', 'aria-label': '필요 개수', disabled: v.required === null, value: v.required === null ? '' : String(v.required) });
    radioAll.addEventListener('change', function () { reqNum.disabled = true; });
    radioN.addEventListener('change', function () { reqNum.disabled = false; reqNum.focus(); });
    var lowCb = el('input', { type: 'checkbox', checked: v.low });
    var lockHint = locked ? '이미 체크한 기록이 있어서 주기와 범위는 바꿀 수 없어요. 주기 자체를 고치거나 새 묶음을 만드세요.' : null;

    afterModal(UI.modal({
      title: grp ? '묶음 수정' : '묶음 추가',
      body: el('div', {}, [
        UI.field('이름', nameIn, '예: 일일 퀘스트, 주간 보스'),
        UI.field('리셋 주기', cycSel, lockHint),
        UI.field('범위', scopeSel, locked ? null : '게임 공통은 게임에 한 번만 하는 숙제예요. 단계를 고르면 그 단계의 폴더마다 따로 해요.'),
        el('div', { class: 'field' }, [
          el('span', { class: 'label', text: '필요 개수' }),
          el('label', { class: 'check' }, [radioAll, '숙제를 전부 해야 완료']),
          el('div', { class: 'inline-fields' }, [el('label', { class: 'check nowrap' }, [radioN, '이만큼만 하면 완료']), reqNum]),
          el('p', { class: 'hint', text: '예: 던전 5개 중 2개만 하면 오늘 완료' })
        ]),
        el('div', { class: 'field' }, [el('label', { class: 'check' }, [lowCb, '중요도 낮음 (사이드바에 나오지 않아요)'])])
      ]),
      submitLabel: grp ? '저장' : '추가',
      onSubmit: function () {
        var f = {
          name: nameIn.value, cycleId: cycSel.value, scope: scopeSel.value === 'game' ? 'game' : Number(scopeSel.value),
          required: radioAll.checked ? null : (reqNum.value === '' ? NaN : Number(reqNum.value)), low: lowCb.checked
        };
        return commit(function (d) { return grp ? O.updateGroup(d, grp.id, f) : O.addGroup(d, g.id, f); });
      }
    }));
  }

  /* ---------- 숙제 ---------- */

  function addTasks(grp) {
    linesDialog({
      title: '"' + grp.name + '"에 숙제 추가', description: '숙제 이름을 한 줄에 하나씩 적어요.',
      label: '숙제 이름', placeholder: '아르카나\n모라스\n에스페라', hint: '빈 줄은 무시해요. 한 번에 200줄까지 추가할 수 있어요.',
      onSubmit: function (text) { return commit(function (d) { return O.addTasks(d, grp.id, text, Reset.now()); }); }
    });
  }

  function taskSheet(t) {
    afterModal(UI.sheet({
      title: t.name,
      actions: [
        { label: '이름 바꾸기', onClick: function () {
          nameDialog({ title: '숙제 이름 바꾸기', label: '숙제 이름', initial: t.name, onSubmit: function (name) { return commit(function (d) { return O.renameTask(d, t.id, name); }); } });
        } },
        { label: '위로', onClick: function () { quick(function (d) { return O.moveTask(d, t.id, -1); }); } },
        { label: '아래로', onClick: function () { quick(function (d) { return O.moveTask(d, t.id, 1); }); } },
        { label: '삭제', danger: true, onClick: function () { deleteTask(t); } }
      ]
    }));
  }

  function deleteTask(t) {
    var i = O.impactTask(Store.get(), t.id);
    confirmDelete('숙제를 지울까요?', '"' + t.name + '" 숙제를 지워요.', [['숙제', 1], ['완료 기록', i.records]],
      function () { return commit(function (d) { return O.deleteTask(d, t.id); }); });
  }

  /* ---------- 시작 ---------- */

  UI.mountChrome({ active: 'settings' });
  render();

  // 탭이 다시 보이면 다시 그린다 (다른 탭에서 바뀐 내용 반영). 열려 있는 창이 있으면 닫힌 뒤에 그린다.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    UI.whenDialogsClosed(render); // 창이 열려 있으면 닫힌 뒤에
  });
})();
