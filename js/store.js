/*
 * 저장, 불러오기, 가져오기 검증, 완료 기록 누적. (CLAUDE.md 3장 "저장", 5장)
 *
 * - 전역 객체 Store 하나. 저장소는 주입한다: Store.create(storage)로 인스턴스를 만들고,
 *   기본 인스턴스 Store는 window.localStorage를 쓴다. (테스트는 가짜 저장소를 넘긴다.)
 * - 화면은 Store.get()이 주는 읽기 전용 스냅샷만 읽고, 바꿀 때는 update()나 아래 전용 함수만 쓴다.
 * - 모든 쓰기는 같은 길이다: 저장소에서 다시 읽기 → 변경 → 검증 → 저장. 하나라도 실패하면 아무것도 바꾸지 않는다.
 * - 계산(리셋, 완료 판정, 기간)은 reset.js(Reset)에만 둔다. 이 파일은 부르기만 한다.
 */
(function (global) {
  'use strict';

  var KEY = 'vibe-coding-hangisu:data:v1';
  var BROKEN_KEY = KEY + ':broken'; // 손상된 원문을 보관하는 키 (가장 최근 것 하나)
  var VERSION = 1;
  var APP = 'vibe-coding-hangisu';

  // 입력 상한 (가져오기 폭주와 저장 공간 초과를 막는다)
  var LIMIT = {
    text: 6000000,   // 가져올 수 있는 JSON 글자 수
    name: 100,       // 이름 길이
    memo: 300,       // 숙제 메모 길이
    games: 100,
    cycles: 50,      // 게임 하나당
    levels: 10,      // 게임 하나당
    folders: 2000,   // 게임 하나당
    groups: 2000,
    tasks: 20000,
    records: 200000,
    groupRecords: 50000,
    presets: 100,
    errors: 20       // 한 번에 알려 주는 오류 수
  };

  var MSG = {
    corrupted: '저장된 데이터가 손상돼 있어서 저장할 수 없어요. 손상된 원문을 내려받아 보관한 뒤 새로 시작해 주세요.',
    saveFail: '저장하지 못했어요. 저장 공간이 가득 찼을 수 있어요. 변경하지 않았어요. JSON으로 내보내 백업한 뒤 필요 없는 데이터를 지워 주세요.',
    stashFail: '손상된 데이터를 보관하지 못했어요. 먼저 손상된 원문을 내려받아 주세요.',
    readFail: '저장소를 읽지 못해서 변경하지 않았어요. 잠시 뒤 다시 시도해 주세요.',
    tooBig: '데이터가 너무 커서 저장할 수 없어요. 약 6MB까지 저장할 수 있어요. 필요 없는 게임이나 기록을 지워 주세요.',
    badRecords: '기록 형식이 올바르지 않아요. 숙제(또는 묶음) id와 완료 시각이 필요해요.',
    badRemove: '기록을 지우는 조건이 올바르지 않아요. 아무것도 지우지 않았어요.'
  };

  // 저장(쓰기)할 수 있는 글자 수 상한. 내보낸 파일(저장한 글자 + 내보내기 메타)이 가져오기 상한(LIMIT.text)을 넘지 않게 여유를 둔다.
  var WRITE_LIMIT = LIMIT.text - 1000;

  var DATA_KEYS = ['games', 'groups', 'tasks', 'records', 'groupRecords', 'presets'];

  /* ---------- 작은 도구 ---------- */

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isInt(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
  function isId(x) { return typeof x === 'string' && x.length >= 1 && x.length <= 100; }
  function isName(x) { return typeof x === 'string' && x.trim().length >= 1 && x.length <= LIMIT.name; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }

  function emptyData() {
    return { version: VERSION, games: [], groups: [], tasks: [], records: [], groupRecords: [], presets: [] };
  }

  function makeErrs() {
    var list = [];
    return { list: list, add: function (m) { if (list.length < LIMIT.errors) list.push(m); } };
  }

  /* ---------- 구조 검증 ---------- */

  // id가 올바르고 아직 안 나왔으면 true. seen에 기록한다.
  function checkIdUnique(id, seen, label, errs) {
    if (!isId(id)) { errs.add(label + ': id가 없거나 올바르지 않아요.'); return false; }
    if (seen[id]) { errs.add(label + ': id "' + id + '"가 겹쳐요.'); return false; }
    seen[id] = true;
    return true;
  }

  function checkCycles(cycles, label, errs) {
    var set = Object.create(null);
    if (!Array.isArray(cycles)) { errs.add(label + ': 리셋 주기 목록이 없어요.'); return set; }
    if (cycles.length > LIMIT.cycles) errs.add(label + ': 리셋 주기는 ' + LIMIT.cycles + '개까지예요.');
    cycles.forEach(function (c, i) {
      var cl = label + '의 리셋 주기 ' + (i + 1);
      if (!isObj(c)) { errs.add(cl + ': 올바르지 않아요.'); return; }
      checkIdUnique(c.id, set, cl, errs);
      if (!isName(c.name)) errs.add(cl + ': 이름이 필요해요.');
      var r = global.Reset.validateCycle(c);
      if (!r.ok) errs.add(cl + ': ' + r.error);
    });
    return set;
  }

  // 단계 이름 목록을 검사하고 단계 수를 돌려준다.
  function checkLevels(levels, label, errs) {
    if (!Array.isArray(levels)) { errs.add(label + ': 단계 목록이 없어요.'); return 0; }
    if (levels.length > LIMIT.levels) errs.add(label + ': 단계는 ' + LIMIT.levels + '개까지예요.');
    levels.forEach(function (n, i) {
      if (!isName(n)) errs.add(label + '의 단계 ' + (i + 1) + ': 이름이 필요해요.');
    });
    return levels.length;
  }

  // 폴더 목록을 검사하고 id → 폴더 맵을 돌려준다. seen은 폴더 id 중복을 거르는 데 쓴다.
  function checkFolders(folders, nLevels, label, errs, seen) {
    var byId = Object.create(null);
    if (!Array.isArray(folders)) { errs.add(label + ': 폴더 목록이 없어요.'); return byId; }
    if (folders.length > LIMIT.folders) errs.add(label + ': 폴더는 ' + LIMIT.folders + '개까지예요.');
    folders.forEach(function (f, i) {
      var fl = label + '의 폴더 ' + (i + 1);
      if (!isObj(f)) { errs.add(fl + ': 올바르지 않아요.'); return; }
      if (checkIdUnique(f.id, seen, fl, errs)) byId[f.id] = f;
    });
    folders.forEach(function (f, i) {
      if (!isObj(f)) return;
      var fl = label + '의 폴더 ' + (i + 1) + (typeof f.name === 'string' ? ' "' + f.name + '"' : '');
      if (!isName(f.name)) errs.add(fl + ': 이름이 필요해요.');
      if (!(isInt(f.level) && f.level >= 1 && f.level <= nLevels)) {
        errs.add(fl + ': 단계는 1~' + nLevels + ' 사이여야 해요.');
      } else if (f.level === 1) {
        if (f.parentId !== null && f.parentId !== undefined) errs.add(fl + ': 맨 위 단계 폴더는 상위 폴더가 없어야 해요.');
      } else {
        var p = typeof f.parentId === 'string' ? byId[f.parentId] : null;
        if (!p || p.level !== f.level - 1) errs.add(fl + ': 바로 위 단계의 폴더 안에 있어야 해요.');
      }
      if (!Array.isArray(f.off) || !f.off.every(isId)) errs.add(fl + ': 끈 항목 목록이 올바르지 않아요.');
    });
    return byId;
  }

  function checkGroupFields(g, cycleSet, nLevels, label, errs) {
    if (!isName(g.name)) errs.add(label + ': 이름이 필요해요.');
    if (!(typeof g.cycleId === 'string' && cycleSet[g.cycleId])) errs.add(label + ': 리셋 주기가 이 게임에 없어요.');
    if (!(g.scope === 'game' || (isInt(g.scope) && g.scope >= 1 && g.scope <= nLevels))) {
      errs.add(label + ': 범위는 "game"이거나 1~' + nLevels + ' 사이의 단계 번호여야 해요.');
    }
    if (!(g.required === null || g.required === undefined || (isInt(g.required) && g.required >= 1))) {
      errs.add(label + ': 필요 개수는 비우거나(전부) 1 이상의 정수여야 해요.');
    }
    if (!(g.low === undefined || typeof g.low === 'boolean')) errs.add(label + ': 중요도 낮음은 true 또는 false여야 해요.');
  }

  function checkTaskFields(t, label, errs, needCreatedAt) {
    if (!isName(t.name)) errs.add(label + ': 이름이 필요해요.');
    if (!(t.low === undefined || typeof t.low === 'boolean')) errs.add(label + ': 중요도 낮음은 true 또는 false여야 해요.');
    if (needCreatedAt && !global.Reset.parseTime(t.createdAt)) errs.add(label + ': 만든 시각을 읽을 수 없어요.');
    if (t.memo !== undefined) {
      if (typeof t.memo !== 'string') errs.add(label + ': 메모는 글이어야 해요.');
      else if (t.memo.length > LIMIT.memo) errs.add(label + ': 메모는 ' + LIMIT.memo + '자까지예요.');
    }
  }

  // 메모 글을 저장할 모양으로: 줄바꿈은 LF 하나로, 앞뒤 공백은 자른다. 비면 ''.
  function cleanMemo(text) { return typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : ''; }

  // 폴더의 off가 가리키는 id가 실제 묶음·숙제인지 (validOff: id → true)
  function checkOff(folders, validOff, label, errs) {
    folders.forEach(function (f, i) {
      if (!isObj(f) || !Array.isArray(f.off)) return;
      f.off.forEach(function (id) {
        if (isId(id) && !validOff[id]) errs.add(label + '의 폴더 ' + (i + 1) + ': 끈 항목 "' + id + '"가 이 게임의 묶음이나 숙제가 아니에요.');
      });
    });
  }

  // 어떤 값이 와도 예외를 던지지 않고 { ok:false, error }로 돌려준다 (이상한 id 같은 값이 와도 Store가 죽지 않게).
  function validateData(data) {
    try {
      return validateDataCore(data);
    } catch (e) {
      var msg = '데이터 구조를 확인하지 못했어요. 값의 형식이 올바르지 않아요.';
      return { ok: false, error: msg, errors: [msg] };
    }
  }

  function validateDataCore(data) {
    var errs = makeErrs();
    function done() { return { ok: errs.list.length === 0, error: errs.list[0] || null, errors: errs.list }; }

    if (!isObj(data)) { errs.add('데이터가 올바른 형식이 아니에요.'); return done(); }
    if (data.version !== VERSION) { errs.add('지원하지 않는 데이터 버전이에요. 이 앱은 버전 ' + VERSION + '을 읽어요.'); return done(); }
    for (var k = 0; k < DATA_KEYS.length; k++) {
      if (!Array.isArray(data[DATA_KEYS[k]])) { errs.add('"' + DATA_KEYS[k] + '" 목록이 없어요.'); return done(); }
    }
    DATA_KEYS.forEach(function (key) {
      if (data[key].length > LIMIT[key]) errs.add('"' + key + '"는 ' + LIMIT[key] + '개까지예요.');
    });
    if (errs.list.length) return done();

    var gameById = Object.create(null);
    var folderSeen = Object.create(null);
    var folderGame = Object.create(null); // 폴더 id → 게임 id
    var cycleSets = Object.create(null);
    var levelCounts = Object.create(null);
    var validOff = Object.create(null);   // 게임 id → { 묶음·숙제 id: true }

    data.games.forEach(function (g, i) {
      var label = '게임 ' + (i + 1) + (isObj(g) && typeof g.name === 'string' ? ' "' + g.name + '"' : '');
      if (!isObj(g)) { errs.add(label + ': 올바르지 않아요.'); return; }
      var okId = checkIdUnique(g.id, gameById, label, errs);
      if (!isName(g.name)) errs.add(label + ': 이름이 필요해요.');
      var cycleSet = checkCycles(g.cycles, label, errs);
      var nLevels = checkLevels(g.levels, label, errs);
      var folderMap = checkFolders(g.folders, nLevels, label, errs, folderSeen);
      if (okId) {
        cycleSets[g.id] = cycleSet;
        levelCounts[g.id] = nLevels;
        validOff[g.id] = Object.create(null);
        Object.keys(folderMap).forEach(function (fid) { folderGame[fid] = g.id; });
      }
    });

    var groupById = Object.create(null);
    var groupGame = Object.create(null);
    data.groups.forEach(function (g, i) {
      var label = '묶음 ' + (i + 1) + (isObj(g) && typeof g.name === 'string' ? ' "' + g.name + '"' : '');
      if (!isObj(g)) { errs.add(label + ': 올바르지 않아요.'); return; }
      var okId = checkIdUnique(g.id, groupById, label, errs);
      if (!(typeof g.gameId === 'string' && cycleSets[g.gameId])) { errs.add(label + ': 게임이 없어요.'); return; }
      checkGroupFields(g, cycleSets[g.gameId], levelCounts[g.gameId], label, errs);
      if (okId) { groupGame[g.id] = g.gameId; validOff[g.gameId][g.id] = true; }
    });

    var taskById = Object.create(null);
    var taskGame = Object.create(null);
    data.tasks.forEach(function (t, i) {
      var label = '숙제 ' + (i + 1) + (isObj(t) && typeof t.name === 'string' ? ' "' + t.name + '"' : '');
      if (!isObj(t)) { errs.add(label + ': 올바르지 않아요.'); return; }
      var okId = checkIdUnique(t.id, taskById, label, errs);
      if (okId && groupById[t.id]) { errs.add(label + ': id "' + t.id + '"가 묶음 id와 겹쳐요.'); okId = false; }
      if (!(typeof t.groupId === 'string' && groupGame[t.groupId])) { errs.add(label + ': 묶음이 없어요.'); return; }
      checkTaskFields(t, label, errs, true);
      if (okId) { taskGame[t.id] = groupGame[t.groupId]; validOff[groupGame[t.groupId]][t.id] = true; }
    });

    data.games.forEach(function (g, i) {
      if (isObj(g) && typeof g.id === 'string' && validOff[g.id] && Array.isArray(g.folders)) checkOff(g.folders, validOff[g.id], '게임 ' + (i + 1), errs);
    });

    function checkFolderRef(r, gameOfItem, label) {
      if (r.folderId === null || r.folderId === undefined) return;
      if (typeof r.folderId !== 'string' || !folderGame[r.folderId]) { errs.add(label + ': 폴더가 없어요.'); return; }
      if (folderGame[r.folderId] !== gameOfItem) errs.add(label + ': 다른 게임의 폴더예요.');
    }

    data.records.forEach(function (r, i) {
      var label = '완료 기록 ' + (i + 1);
      if (!isObj(r)) { errs.add(label + ': 올바르지 않아요.'); return; }
      if (!(typeof r.taskId === 'string' && taskGame[r.taskId])) { errs.add(label + ': 숙제가 없어요.'); return; }
      checkFolderRef(r, taskGame[r.taskId], label);
      if (!global.Reset.parseTime(r.doneAt)) errs.add(label + ': 완료 시각을 읽을 수 없어요.');
    });

    data.groupRecords.forEach(function (r, i) {
      var label = '묶음 완료 기록 ' + (i + 1);
      if (!isObj(r)) { errs.add(label + ': 올바르지 않아요.'); return; }
      if (!(typeof r.groupId === 'string' && groupGame[r.groupId])) { errs.add(label + ': 묶음이 없어요.'); return; }
      checkFolderRef(r, groupGame[r.groupId], label);
      if (!global.Reset.parseTime(r.doneAt)) errs.add(label + ': 완료 시각을 읽을 수 없어요.');
    });

    var presetSeen = Object.create(null);
    data.presets.forEach(function (p, i) {
      var label = '내 프리셋 ' + (i + 1) + (isObj(p) && typeof p.name === 'string' ? ' "' + p.name + '"' : '');
      if (!isObj(p)) { errs.add(label + ': 올바르지 않아요.'); return; }
      checkIdUnique(p.id, presetSeen, label, errs);
      if (!isName(p.name)) errs.add(label + ': 이름이 필요해요.');
      if (!global.Reset.parseTime(p.savedAt)) errs.add(label + ': 저장한 시각을 읽을 수 없어요.');
      if (!isObj(p.game)) { errs.add(label + ': 게임 내용이 없어요.'); return; }
      if ('records' in p || 'groupRecords' in p || 'records' in p.game || 'groupRecords' in p.game) {
        errs.add(label + ': 내 프리셋에는 완료 기록을 넣을 수 없어요.');
      }
      var pg = p.game;
      var cycleSet = checkCycles(pg.cycles, label, errs);
      var nLevels = checkLevels(pg.levels, label, errs);
      checkFolders(pg.folders, nLevels, label, errs, Object.create(null));
      var ok = Object.create(null);
      var pgroups = Object.create(null);
      if (!Array.isArray(pg.groups)) errs.add(label + ': 묶음 목록이 없어요.');
      else pg.groups.forEach(function (g, j) {
        var gl = label + '의 묶음 ' + (j + 1);
        if (!isObj(g)) { errs.add(gl + ': 올바르지 않아요.'); return; }
        if (checkIdUnique(g.id, pgroups, gl, errs)) ok[g.id] = true;
        checkGroupFields(g, cycleSet, nLevels, gl, errs);
      });
      var ptasks = Object.create(null);
      if (!Array.isArray(pg.tasks)) errs.add(label + ': 숙제 목록이 없어요.');
      else pg.tasks.forEach(function (t, j) {
        var tl = label + '의 숙제 ' + (j + 1);
        if (!isObj(t)) { errs.add(tl + ': 올바르지 않아요.'); return; }
        if (checkIdUnique(t.id, ptasks, tl, errs)) {
          if (pgroups[t.id]) errs.add(tl + ': id "' + t.id + '"가 묶음 id와 겹쳐요.');
          ok[t.id] = true;
        }
        if (!(typeof t.groupId === 'string' && pgroups[t.groupId])) errs.add(tl + ': 묶음이 없어요.');
        checkTaskFields(t, tl, errs, false);
      });
      if (Array.isArray(pg.folders)) checkOff(pg.folders, ok, label, errs);
    });

    return done();
  }

  /* ---------- 정규화: 알려진 필드만 남긴다 ---------- */

  // 알려진 필드(allowed)에 없는 필드가 몇 개인지 ctx.dropped에 더한다. (필드를 남기는 것이 아니라 버린 개수를 센다)
  function countUnknownFields(src, allowed, ctx) {
    Object.keys(src).forEach(function (k) { if (allowed.indexOf(k) < 0) ctx.dropped++; });
  }

  function normCycle(c, ctx) {
    var out = { id: c.id, name: c.name, type: c.type };
    var allowed = ['id', 'name', 'type', 'carry'];
    if (c.type === 'daily' || c.type === 'weekly' || c.type === 'monthly') {
      allowed.push('time');
      if (c.type === 'weekly') { allowed.push('day'); out.day = c.day; }
      if (c.type === 'monthly') { allowed.push('date'); out.date = c.date; }
      out.time = c.time;
    }
    if (c.type === 'interval') {
      allowed.push('anchor', 'every');
      out.anchor = c.anchor;
      out.every = { days: c.every.days || 0, hours: c.every.hours || 0, minutes: c.every.minutes || 0 };
      countUnknownFields(c.every, ['days', 'hours', 'minutes'], ctx);
    }
    if (c.carry !== undefined) {
      out.carry = { since: c.carry.since };
      if (c.type !== 'once') out.carry.until = c.carry.until;
      countUnknownFields(c.carry, ['since', 'until'], ctx);
    }
    countUnknownFields(c, allowed, ctx);
    return out;
  }

  function normFolder(f, ctx) {
    countUnknownFields(f, ['id', 'parentId', 'level', 'name', 'off'], ctx);
    return { id: f.id, parentId: f.parentId == null ? null : f.parentId, level: f.level, name: f.name, off: f.off.slice() };
  }

  function normGroup(g, withGameId, ctx) {
    countUnknownFields(g, ['id', 'name', 'cycleId', 'scope', 'required', 'low'].concat(withGameId ? ['gameId'] : []), ctx);
    var out = { id: g.id };
    if (withGameId) out.gameId = g.gameId;
    out.name = g.name; out.cycleId = g.cycleId; out.scope = g.scope;
    out.required = g.required == null ? null : g.required;
    out.low = g.low === true;
    return out;
  }

  function normTask(t, withCreatedAt, ctx) {
    countUnknownFields(t, ['id', 'groupId', 'name', 'low', 'memo'].concat(withCreatedAt ? ['createdAt'] : []), ctx);
    var out = { id: t.id, groupId: t.groupId, name: t.name, low: t.low === true };
    if (withCreatedAt) out.createdAt = t.createdAt;
    var memo = cleanMemo(t.memo);
    if (memo) out.memo = memo; // 비어 있으면 필드를 두지 않는다
    return out;
  }

  // 검증을 통과한 데이터에서 알려진 필드만 복사해 새 객체를 만든다. { data, dropped }
  function normalize(data) {
    var ctx = { dropped: 0 };
    countUnknownFields(data, ['app', 'exportedAt', 'version'].concat(DATA_KEYS), ctx); // app, exportedAt은 내보내기 메타라 버린 것으로 세지 않는다
    var out = {
      version: VERSION,
      games: data.games.map(function (g) {
        countUnknownFields(g, ['id', 'name', 'cycles', 'levels', 'folders'], ctx);
        return {
          id: g.id, name: g.name,
          cycles: g.cycles.map(function (c) { return normCycle(c, ctx); }),
          levels: g.levels.slice(),
          folders: g.folders.map(function (f) { return normFolder(f, ctx); })
        };
      }),
      groups: data.groups.map(function (g) { return normGroup(g, true, ctx); }),
      tasks: data.tasks.map(function (t) { return normTask(t, true, ctx); }),
      records: data.records.map(function (r) {
        countUnknownFields(r, ['taskId', 'folderId', 'doneAt'], ctx);
        return { taskId: r.taskId, folderId: r.folderId == null ? null : r.folderId, doneAt: r.doneAt };
      }),
      groupRecords: data.groupRecords.map(function (r) {
        countUnknownFields(r, ['groupId', 'folderId', 'doneAt'], ctx);
        return { groupId: r.groupId, folderId: r.folderId == null ? null : r.folderId, doneAt: r.doneAt };
      }),
      presets: data.presets.map(function (p) {
        countUnknownFields(p, ['id', 'name', 'savedAt', 'game'], ctx);
        countUnknownFields(p.game, ['cycles', 'levels', 'folders', 'groups', 'tasks'], ctx);
        return {
          id: p.id, name: p.name, savedAt: p.savedAt,
          game: {
            cycles: p.game.cycles.map(function (c) { return normCycle(c, ctx); }),
            levels: p.game.levels.slice(),
            folders: p.game.folders.map(function (f) { return normFolder(f, ctx); }),
            groups: p.game.groups.map(function (g) { return normGroup(g, false, ctx); }),
            tasks: p.game.tasks.map(function (t) { return normTask(t, false, ctx); })
          }
        };
      })
    };
    return { data: out, dropped: ctx.dropped };
  }

  /* ---------- 데이터 변경 규칙 (Store.ops) ---------- */
  // 저장소 초안(draft)을 받아 고치는 순수 함수들이다. 화면(settings.js)은 Store.apply(function (d) { return Store.ops.xxx(d, …); })로 부른다.
  // 실패하면 { ok:false, error:"한국어 안내" }를 돌려주고 draft를 바꾸지 않는다. 성공하면 { ok:true, … }다.

  var NOOP = {}; // update()의 변경 함수가 돌려주면 "바꿀 것이 없음"이라 저장하지 않는다.

  var OPS_LIMIT = { treeLines: 500, taskLines: 200 };

  function allIds(d) {
    var used = Object.create(null);
    function add(o) { if (o && typeof o.id === 'string') used[o.id] = true; }
    d.games.forEach(function (g) { add(g); g.cycles.forEach(add); g.folders.forEach(add); });
    d.groups.forEach(add);
    d.tasks.forEach(add);
    d.presets.forEach(function (p) {
      add(p);
      p.game.cycles.forEach(add); p.game.folders.forEach(add); p.game.groups.forEach(add); p.game.tasks.forEach(add);
    });
    return used;
  }

  // 새 id. 접두어 + 시간(36진수) + 난수. used에 있는 id와 겹치지 않고, 만든 id는 used에 기록한다.
  function makeId(prefix, used) {
    var id;
    do {
      id = (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    } while (used[id]);
    used[id] = true;
    return id;
  }

  var ops = (function () {
    function fail(error) { return { ok: false, error: error }; }

    function cleanName(name) {
      var s = typeof name === 'string' ? name.trim() : '';
      if (!s) return { error: '이름을 입력해 주세요.' };
      if (s.length > LIMIT.name) return { error: '이름은 ' + LIMIT.name + '자 이하로 적어 주세요.' };
      return { value: s };
    }

    function findGame(d, id) {
      for (var i = 0; i < d.games.length; i++) if (d.games[i].id === id) return d.games[i];
      return null;
    }
    function findGroup(d, id) {
      for (var i = 0; i < d.groups.length; i++) if (d.groups[i].id === id) return d.groups[i];
      return null;
    }
    function findTask(d, id) {
      for (var i = 0; i < d.tasks.length; i++) if (d.tasks[i].id === id) return d.tasks[i];
      return null;
    }
    function findFolder(d, id) {
      for (var i = 0; i < d.games.length; i++) {
        var fs = d.games[i].folders;
        for (var j = 0; j < fs.length; j++) if (fs[j].id === id) return { game: d.games[i], folder: fs[j], index: j };
      }
      return null;
    }

    function groupsOf(d, gameId) { return d.groups.filter(function (g) { return g.gameId === gameId; }); }
    function tasksOfGroups(d, groupIds) {
      var set = Object.create(null); groupIds.forEach(function (id) { set[id] = true; });
      return d.tasks.filter(function (t) { return set[t.groupId]; });
    }

    // 폴더와 그 아래 폴더 전부 (자기 자신 먼저, 형제 순서는 배열 순서)
    function subtree(game, rootId) {
      var out = [];
      function walk(id) {
        game.folders.forEach(function (f) {
          if (f.id === id) { out.push(f); }
        });
        game.folders.forEach(function (f) { if (f.parentId === id) walk(f.id); });
      }
      walk(rootId);
      return out;
    }

    function removeOffEntries(d, gameId, ids) {
      var set = Object.create(null); ids.forEach(function (id) { set[id] = true; });
      var g = findGame(d, gameId);
      if (!g) return;
      g.folders.forEach(function (f) { f.off = f.off.filter(function (x) { return !set[x]; }); });
    }

    function recordCount(d, taskIdSet, groupIdSet, folderIdSet) {
      var r = 0, gr = 0;
      d.records.forEach(function (x) {
        if ((taskIdSet && taskIdSet[x.taskId]) || (folderIdSet && x.folderId != null && folderIdSet[x.folderId])) r++;
      });
      d.groupRecords.forEach(function (x) {
        if ((groupIdSet && groupIdSet[x.groupId]) || (folderIdSet && x.folderId != null && folderIdSet[x.folderId])) gr++;
      });
      return { records: r, groupRecords: gr };
    }
    // id 집합. "constructor" 같은 id가 상속 속성에 걸리지 않게 프로토타입이 없는 객체를 쓴다.
    function toSet(list) { var s = Object.create(null); list.forEach(function (x) { s[x] = true; }); return s; }

    // 같은 무리(sameFn) 안에서 id를 위(-1)·아래(+1)로 한 칸 옮긴다. 끝이면 noop.
    function moveWithin(list, id, delta, sameFn) {
      var idxs = [];
      var pos = -1;
      list.forEach(function (x, i) {
        if (sameFn(x)) { if (x.id === id) pos = idxs.length; idxs.push(i); }
      });
      if (pos < 0) return fail('찾을 수 없어요.');
      var target = pos + delta;
      if (target < 0 || target >= idxs.length) return { ok: true, noop: true };
      var a = idxs[pos], b = idxs[target];
      var tmp = list[a]; list[a] = list[b]; list[b] = tmp;
      return { ok: true };
    }

    /* ----- 게임 ----- */
    function addGame(d, name) {
      var n = cleanName(name); if (n.error) return fail(n.error);
      var id = makeId('gm', allIds(d));
      d.games.push({ id: id, name: n.value, cycles: [], levels: [], folders: [] });
      return { ok: true, id: id };
    }
    function renameGame(d, gameId, name) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      g.name = n.value;
      return { ok: true };
    }
    function impactGame(d, gameId) {
      var g = findGame(d, gameId);
      if (!g) return { cycles: 0, levels: 0, folders: 0, groups: 0, tasks: 0, records: 0, groupRecords: 0 };
      var groups = groupsOf(d, gameId);
      var tasks = tasksOfGroups(d, groups.map(function (x) { return x.id; }));
      var c = recordCount(d, toSet(tasks.map(function (x) { return x.id; })), toSet(groups.map(function (x) { return x.id; })), null);
      return { cycles: g.cycles.length, levels: g.levels.length, folders: g.folders.length, groups: groups.length, tasks: tasks.length, records: c.records, groupRecords: c.groupRecords };
    }
    function deleteGame(d, gameId) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var groupIds = toSet(groupsOf(d, gameId).map(function (x) { return x.id; }));
      var taskIds = Object.create(null);
      d.tasks.forEach(function (t) { if (groupIds[t.groupId]) taskIds[t.id] = true; });
      d.records = d.records.filter(function (r) { return !taskIds[r.taskId]; });
      d.groupRecords = d.groupRecords.filter(function (r) { return !groupIds[r.groupId]; });
      d.tasks = d.tasks.filter(function (t) { return !taskIds[t.id]; });
      d.groups = d.groups.filter(function (x) { return x.gameId !== gameId; });
      d.games = d.games.filter(function (x) { return x.id !== gameId; });
      return { ok: true };
    }
    function moveGame(d, gameId, delta) {
      return moveWithin(d.games, gameId, delta, function () { return true; });
    }

    /* ----- 리셋 주기 ----- */
    function buildCycle(id, f) {
      var c = { id: id, name: f.name, type: f.type };
      if (f.type === 'daily' || f.type === 'weekly' || f.type === 'monthly') c.time = f.time;
      if (f.type === 'weekly') c.day = f.day;
      if (f.type === 'monthly') c.date = f.date;
      if (f.type === 'interval') {
        c.anchor = f.anchor;
        var e = f.every || {};
        c.every = { days: e.days || 0, hours: e.hours || 0, minutes: e.minutes || 0 };
      }
      return c;
    }
    // 주기의 정의(이름은 빼고)를 비교용 문자열로
    function defKey(c) {
      var anchor = null;
      if (c.anchor) { var a = global.Reset.parseTime(c.anchor); anchor = a ? global.Reset.formatIso(a) : String(c.anchor); }
      var e = c.every ? [c.every.days || 0, c.every.hours || 0, c.every.minutes || 0] : null;
      return JSON.stringify([c.type, c.time === undefined ? null : c.time, c.day === undefined ? null : c.day, c.date === undefined ? null : c.date, anchor, e]);
    }

    // fields: { name, type, time?, day?, date?, anchor?, every? }
    function addCycle(d, gameId, fields) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var n = cleanName(fields.name); if (n.error) return fail(n.error);
      var c = buildCycle(makeId('cy', allIds(d)), { name: n.value, type: fields.type, time: fields.time, day: fields.day, date: fields.date, anchor: fields.anchor, every: fields.every });
      var v = global.Reset.validateCycle(c); if (!v.ok) return fail(v.error);
      g.cycles.push(c);
      return { ok: true, id: c.id };
    }

    // 정의(종류·시각·요일·날짜·기준·간격)가 바뀌면 Reset.changeCycle을 거쳐 carry를 붙인다.
    // 이름만 바꾸면 기존 carry를 그대로 둔다. at은 바꾼 시각(Reset.now()).
    function updateCycle(d, gameId, cycleId, fields, at) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var idx = -1;
      g.cycles.forEach(function (c, i) { if (c.id === cycleId) idx = i; });
      if (idx < 0) return fail('리셋 주기를 찾을 수 없어요.');
      var old = g.cycles[idx];
      var n = cleanName(fields.name); if (n.error) return fail(n.error);
      var next = buildCycle(old.id, { name: n.value, type: fields.type, time: fields.time, day: fields.day, date: fields.date, anchor: fields.anchor, every: fields.every });
      var v = global.Reset.validateCycle(next); if (!v.ok) return fail(v.error);
      if (defKey(next) === defKey(old)) {
        old.name = n.value;
        return { ok: true, changed: false };
      }
      g.cycles[idx] = global.Reset.changeCycle(old, next, at);
      return { ok: true, changed: true };
    }

    // 주기를 지울 수 있는지 (데이터를 바꾸지 않는다). 쓰는 묶음이 있으면 { ok:false, error }.
    function canDeleteCycle(d, gameId, cycleId) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var used = groupsOf(d, gameId).filter(function (x) { return x.cycleId === cycleId; });
      if (used.length) {
        var names = used.slice(0, 3).map(function (x) { return '"' + x.name + '"'; }).join(', ');
        return fail(names + (used.length > 3 ? ' 외 ' + (used.length - 3) + '개' : '') + ' 묶음이 이 주기를 쓰고 있어요. 그 묶음을 지운 뒤에 지울 수 있어요.');
      }
      if (!g.cycles.some(function (c) { return c.id === cycleId; })) return fail('리셋 주기를 찾을 수 없어요.');
      return { ok: true };
    }
    function deleteCycle(d, gameId, cycleId) {
      var can = canDeleteCycle(d, gameId, cycleId); if (!can.ok) return can;
      var g = findGame(d, gameId);
      g.cycles = g.cycles.filter(function (c) { return c.id !== cycleId; });
      return { ok: true };
    }

    /* ----- 단계 ----- */
    function addLevelBelow(d, gameId, name) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      if (g.levels.length >= LIMIT.levels) return fail('단계는 ' + LIMIT.levels + '개까지예요.');
      g.levels.push(n.value);
      return { ok: true };
    }

    // 맨 위에 새 단계를 끼운다. 기존 폴더는 새 맨 위 폴더(topName) 하나 안으로 들어간다.
    function addLevelAbove(d, gameId, name, topName) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      var t = cleanName(topName === undefined ? '기본' : topName); if (t.error) return fail(t.error);
      if (g.levels.length >= LIMIT.levels) return fail('단계는 ' + LIMIT.levels + '개까지예요.');
      g.levels.unshift(n.value);
      var oldTops = [];
      g.folders.forEach(function (f) { if (f.level === 1) oldTops.push(f); f.level += 1; });
      groupsOf(d, gameId).forEach(function (x) { if (typeof x.scope === 'number') x.scope += 1; });
      if (g.folders.length) {
        var top = { id: makeId('fo', allIds(d)), parentId: null, level: 1, name: t.value, off: [] };
        oldTops.forEach(function (f) { f.parentId = top.id; });
        g.folders.unshift(top);
      }
      return { ok: true };
    }

    function renameLevel(d, gameId, level, name) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      if (!(level >= 1 && level <= g.levels.length)) return fail('단계를 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      g.levels[level - 1] = n.value;
      return { ok: true };
    }

    // 지우기를 막는 것들: 그 단계의 폴더 수와 그 단계를 쓰는 묶음
    function impactLevel(d, gameId, level) {
      var g = findGame(d, gameId);
      if (!g) return { folders: 0, groups: [] };
      return {
        folders: g.folders.filter(function (f) { return f.level === level; }).length,
        groups: groupsOf(d, gameId).filter(function (x) { return x.scope === level; })
      };
    }
    // 단계를 지울 수 있는지 (데이터를 바꾸지 않는다). 폴더나 그 단계를 범위로 쓰는 묶음이 있으면 { ok:false, error }.
    function canDeleteLevel(d, gameId, level) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      if (!(level >= 1 && level <= g.levels.length)) return fail('단계를 찾을 수 없어요.');
      var imp = impactLevel(d, gameId, level);
      var name = g.levels[level - 1];
      if (imp.folders > 0) return fail('"' + name + '" 단계에 폴더가 ' + imp.folders + '개 있어서 지울 수 없어요. 폴더를 먼저 지워 주세요.');
      if (imp.groups.length > 0) return fail('"' + name + '" 단계를 범위로 쓰는 묶음이 ' + imp.groups.length + '개 있어서 지울 수 없어요 (' + imp.groups.slice(0, 3).map(function (x) { return '"' + x.name + '"'; }).join(', ') + '). 그 묶음을 먼저 지워 주세요.');
      return { ok: true };
    }
    function deleteLevel(d, gameId, level) {
      var can = canDeleteLevel(d, gameId, level); if (!can.ok) return can;
      var g = findGame(d, gameId);
      g.levels.splice(level - 1, 1);
      g.folders.forEach(function (f) { if (f.level > level) f.level -= 1; });
      groupsOf(d, gameId).forEach(function (x) { if (typeof x.scope === 'number' && x.scope > level) x.scope -= 1; });
      return { ok: true };
    }

    /* ----- 폴더 ----- */
    // 들여쓰기로 쓴 폴더 목록을 읽는다. maxDepth는 쓸 수 있는 단계 수(가장 깊은 줄의 깊이 + 1이 이 값 이하여야 한다).
    // 돌려주는 값: { ok, nodes: [{ name, depth }] } (입력 순서)
    function parseFolderTree(text, maxDepth) {
      if (typeof text !== 'string') return fail('폴더 이름을 적어 주세요.');
      var lines = text.split(/\r\n|\r|\n/);
      var nodes = [];
      var unit = null;      // 한 단계의 들여쓰기 (공백 수 또는 탭)
      var unitKind = null;  // 'space' | 'tab'
      var prevDepth = -1;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.trim() === '') continue;
        if (nodes.length >= OPS_LIMIT.treeLines) return fail('한 번에 ' + OPS_LIMIT.treeLines + '줄까지 추가할 수 있어요.');
        var no = (i + 1) + '번째 줄';
        var m = /^[ \t]*/.exec(line)[0];
        var hasTab = m.indexOf('\t') >= 0, hasSpace = m.indexOf(' ') >= 0;
        if (hasTab && hasSpace) return fail(no + ': 들여쓰기에 탭과 공백을 섞어 쓸 수 없어요.');
        var depth = 0;
        if (m.length > 0) {
          var kind = hasTab ? 'tab' : 'space';
          if (unit === null) { unit = hasTab ? 1 : m.length; unitKind = kind; }
          if (kind !== unitKind) return fail(no + ': 들여쓰기에 탭과 공백을 섞어 쓸 수 없어요.');
          if (m.length % unit !== 0) return fail(no + ': 들여쓰기 칸 수가 맞지 않아요. 한 단계는 ' + (unitKind === 'tab' ? '탭 1개' : '공백 ' + unit + '칸') + '이에요.');
          depth = m.length / unit;
        }
        if (nodes.length === 0 && depth !== 0) return fail(no + ': 첫 줄은 들여쓰기 없이 시작해 주세요.');
        if (depth > prevDepth + 1) return fail(no + ': 들여쓰기가 한 번에 두 단계 이상 깊어졌어요.');
        if (depth >= maxDepth) return fail(no + ': 들여쓰기가 단계 수보다 깊어요. 여기에는 ' + maxDepth + '단계까지 쓸 수 있어요.');
        var n = cleanName(line.trim());
        if (n.error) return fail(no + ': ' + n.error);
        nodes.push({ name: n.value, depth: depth });
        prevDepth = depth;
      }
      if (nodes.length === 0) return fail('폴더 이름을 한 줄에 하나씩 적어 주세요.');
      return { ok: true, nodes: nodes };
    }

    // parentId가 null이면 1단계부터, 아니면 그 폴더 아래에 추가한다.
    function addFolders(d, gameId, parentId, text) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var levels = g.levels.length;
      if (levels === 0) return fail('먼저 단계를 추가해 주세요.');
      var parent = null;
      if (parentId) {
        g.folders.forEach(function (f) { if (f.id === parentId) parent = f; });
        if (!parent) return fail('폴더를 찾을 수 없어요.');
      }
      var startLevel = parent ? parent.level + 1 : 1;
      if (startLevel > levels) return fail('이 폴더는 마지막 단계라 아래에 폴더를 추가할 수 없어요.');
      var p = parseFolderTree(text, levels - startLevel + 1);
      if (!p.ok) return p;
      if (g.folders.length + p.nodes.length > LIMIT.folders) return fail('폴더는 한 게임에 ' + LIMIT.folders + '개까지예요.');
      var used = allIds(d);
      var stack = [];
      p.nodes.forEach(function (node) {
        var up = node.depth === 0 ? parent : stack[node.depth - 1];
        var f = { id: makeId('fo', used), parentId: up ? up.id : null, level: startLevel + node.depth, name: node.name, off: [] };
        g.folders.push(f);
        stack[node.depth] = f;
        stack.length = node.depth + 1;
      });
      return { ok: true, added: p.nodes.length };
    }

    function renameFolder(d, folderId, name) {
      var loc = findFolder(d, folderId); if (!loc) return fail('폴더를 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      loc.folder.name = n.value;
      return { ok: true };
    }

    // 폴더와 아래 폴더 전부를 복사한다 (끈 항목 포함, 완료 기록은 복사하지 않는다). 복사본은 원본 바로 뒤에 놓인다.
    function cloneFolder(d, folderId) {
      var loc = findFolder(d, folderId); if (!loc) return fail('폴더를 찾을 수 없어요.');
      var g = loc.game;
      var tree = subtree(g, folderId);
      if (g.folders.length + tree.length > LIMIT.folders) return fail('폴더는 한 게임에 ' + LIMIT.folders + '개까지예요.');
      var used = allIds(d);
      var map = Object.create(null);
      tree.forEach(function (f) { map[f.id] = makeId('fo', used); });
      var rootName = loc.folder.name.length > LIMIT.name - 3 ? loc.folder.name.slice(0, LIMIT.name - 3) : loc.folder.name;
      var copies = tree.map(function (f) {
        return {
          id: map[f.id],
          parentId: f.id === folderId ? f.parentId : map[f.parentId],
          level: f.level,
          name: f.id === folderId ? rootName + ' 복사' : f.name,
          off: f.off.slice()
        };
      });
      Array.prototype.splice.apply(g.folders, [loc.index + 1, 0].concat(copies));
      return { ok: true, id: map[folderId], copied: copies.length };
    }

    // 옮길 수 있는 새 상위 폴더들: 바로 위 단계의 폴더 (지금 상위 폴더 포함)
    function eligibleParents(d, folderId) {
      var loc = findFolder(d, folderId);
      if (!loc || loc.folder.level < 2) return [];
      return loc.game.folders.filter(function (f) { return f.level === loc.folder.level - 1; });
    }
    function moveFolderTo(d, folderId, newParentId) {
      var loc = findFolder(d, folderId); if (!loc) return fail('폴더를 찾을 수 없어요.');
      if (loc.folder.level < 2) return fail('맨 위 단계의 폴더는 옮길 상위 폴더가 없어요.');
      var ok = eligibleParents(d, folderId).some(function (f) { return f.id === newParentId; });
      if (!ok) return fail('바로 위 단계의 폴더 안으로만 옮길 수 있어요.');
      if (loc.folder.parentId === newParentId) return { ok: true, noop: true };
      loc.folder.parentId = newParentId;
      // 새 상위 폴더 안에서 맨 뒤에 놓는다
      loc.game.folders.splice(loc.index, 1);
      loc.game.folders.push(loc.folder);
      return { ok: true };
    }

    function impactFolder(d, folderId) {
      var loc = findFolder(d, folderId);
      if (!loc) return { folders: 0, records: 0, groupRecords: 0 };
      var tree = subtree(loc.game, folderId);
      var c = recordCount(d, null, null, toSet(tree.map(function (f) { return f.id; })));
      return { folders: tree.length, records: c.records, groupRecords: c.groupRecords };
    }
    function deleteFolder(d, folderId) {
      var loc = findFolder(d, folderId); if (!loc) return fail('폴더를 찾을 수 없어요.');
      var set = toSet(subtree(loc.game, folderId).map(function (f) { return f.id; }));
      loc.game.folders = loc.game.folders.filter(function (f) { return !set[f.id]; });
      d.records = d.records.filter(function (r) { return !(r.folderId != null && set[r.folderId]); });
      d.groupRecords = d.groupRecords.filter(function (r) { return !(r.folderId != null && set[r.folderId]); });
      return { ok: true };
    }
    function moveFolder(d, folderId, delta) {
      var loc = findFolder(d, folderId); if (!loc) return fail('폴더를 찾을 수 없어요.');
      var parentId = loc.folder.parentId;
      return moveWithin(loc.game.folders, folderId, delta, function (f) { return f.parentId === parentId; });
    }

    // 게임의 폴더를 트리 순서(위 단계 먼저, 형제는 배열 순서)로. [{ folder, depth }]
    function folderList(d, gameId) {
      var g = findGame(d, gameId);
      if (!g) return [];
      var out = [];
      function walk(parentId, depth) {
        g.folders.forEach(function (f) {
          if (f.parentId === parentId || (parentId === null && f.parentId == null)) {
            out.push({ folder: f, depth: depth });
            walk(f.id, depth + 1);
          }
        });
      }
      walk(null, 0);
      return out;
    }

    // 폴더에서 끌 수 있는 묶음·숙제 목록. 범위(scope)가 이 폴더의 단계 이상인 묶음과 그 숙제만.
    // [{ kind:'group'|'task', id, name, groupId, own, inheritedFrom }]  inheritedFrom: 위 폴더가 이미 끈 경우 그 폴더 이름
    function offList(d, folderId) {
      var loc = findFolder(d, folderId);
      if (!loc) return [];
      var byId = Object.create(null);
      loc.game.folders.forEach(function (f) { byId[f.id] = f; });
      function inherited(itemId) {
        var seen = Object.create(null);
        var id = loc.folder.parentId;
        while (id != null && byId[id] && !seen[id]) {
          seen[id] = true;
          if (byId[id].off.indexOf(itemId) >= 0) return byId[id].name;
          id = byId[id].parentId;
        }
        return null;
      }
      var rows = [];
      groupsOf(d, loc.game.id).forEach(function (g) {
        if (typeof g.scope !== 'number' || g.scope < loc.folder.level) return;
        rows.push({ kind: 'group', id: g.id, name: g.name, groupId: g.id, own: loc.folder.off.indexOf(g.id) >= 0, inheritedFrom: inherited(g.id) });
        d.tasks.forEach(function (t) {
          if (t.groupId === g.id) rows.push({ kind: 'task', id: t.id, name: t.name, groupId: g.id, own: loc.folder.off.indexOf(t.id) >= 0, inheritedFrom: inherited(t.id) });
        });
      });
      return rows;
    }
    // changes: { 항목id: true(끔) | false(켬) }. 한 번에 적용한다.
    function setOff(d, folderId, changes) {
      var loc = findFolder(d, folderId); if (!loc) return fail('폴더를 찾을 수 없어요.');
      var allowed = toSet(offList(d, folderId).map(function (r) { return r.id; }));
      var ids = Object.keys(changes);
      for (var i = 0; i < ids.length; i++) if (!allowed[ids[i]]) return fail('이 폴더에서 끌 수 없는 항목이에요.');
      var has = Object.prototype.hasOwnProperty;
      var off = loc.folder.off.filter(function (x) { return !(has.call(changes, x) && changes[x] === false); });
      ids.forEach(function (id) { if (changes[id] === true && off.indexOf(id) < 0) off.push(id); });
      loc.folder.off = off;
      return { ok: true };
    }

    /* ----- 묶음 ----- */
    function checkGroupFields(g, f) {
      var n = cleanName(f.name); if (n.error) return { error: n.error };
      if (!g.cycles.some(function (c) { return c.id === f.cycleId; })) {
        return { error: g.cycles.length ? '리셋 주기를 골라 주세요.' : '먼저 리셋 주기를 추가해 주세요.' };
      }
      if (!(f.scope === 'game' || (typeof f.scope === 'number' && f.scope >= 1 && f.scope <= g.levels.length && Math.floor(f.scope) === f.scope))) {
        return { error: '범위를 골라 주세요.' };
      }
      var req = f.required === undefined ? null : f.required;
      if (!(req === null || (typeof req === 'number' && isFinite(req) && Math.floor(req) === req && req >= 1))) {
        return { error: '필요 개수는 1 이상의 정수로 적어 주세요. 전부 해야 하면 "전부"를 고르세요.' };
      }
      return { value: { name: n.value, cycleId: f.cycleId, scope: f.scope, required: req, low: f.low === true } };
    }

    function addGroup(d, gameId, fields) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      var c = checkGroupFields(g, fields); if (c.error) return fail(c.error);
      var id = makeId('gr', allIds(d));
      d.groups.push({ id: id, gameId: gameId, name: c.value.name, cycleId: c.value.cycleId, scope: c.value.scope, required: c.value.required, low: c.value.low });
      return { ok: true, id: id };
    }

    // 이 묶음에 완료 기록이나 묶음 완료 기록이 하나라도 있는지
    function groupHasRecords(d, groupId) {
      var ids = Object.create(null);
      d.tasks.forEach(function (t) { if (t.groupId === groupId) ids[t.id] = true; });
      return d.records.some(function (r) { return ids[r.taskId]; }) || d.groupRecords.some(function (r) { return r.groupId === groupId; });
    }

    // 주기나 범위를 바꾸면 이미 한 체크가 사라지거나 되살아나므로, 기록이 있는 묶음은 막는다 (3장 "묶음").
    function updateGroup(d, groupId, fields) {
      var grp = findGroup(d, groupId); if (!grp) return fail('묶음을 찾을 수 없어요.');
      var g = findGame(d, grp.gameId);
      var c = checkGroupFields(g, fields); if (c.error) return fail(c.error);
      var hasRecords = groupHasRecords(d, groupId);
      if (c.value.cycleId !== grp.cycleId && hasRecords) return fail('이미 체크한 기록이 있어서 주기를 바꿀 수 없어요. 주기 자체를 고치거나 새 묶음을 만드세요.');
      if (c.value.scope !== grp.scope && hasRecords) return fail('이미 체크한 기록이 있어서 범위를 바꿀 수 없어요. 새 묶음을 만드세요.');
      grp.name = c.value.name; grp.cycleId = c.value.cycleId; grp.scope = c.value.scope;
      grp.required = c.value.required; grp.low = c.value.low;
      return { ok: true };
    }

    function impactGroup(d, groupId) {
      var tasks = d.tasks.filter(function (t) { return t.groupId === groupId; });
      var c = recordCount(d, toSet(tasks.map(function (t) { return t.id; })), toSet([groupId]), null);
      return { tasks: tasks.length, records: c.records, groupRecords: c.groupRecords };
    }
    function deleteGroup(d, groupId) {
      var grp = findGroup(d, groupId); if (!grp) return fail('묶음을 찾을 수 없어요.');
      var taskIds = d.tasks.filter(function (t) { return t.groupId === groupId; }).map(function (t) { return t.id; });
      var set = toSet(taskIds);
      d.records = d.records.filter(function (r) { return !set[r.taskId]; });
      d.groupRecords = d.groupRecords.filter(function (r) { return r.groupId !== groupId; });
      d.tasks = d.tasks.filter(function (t) { return t.groupId !== groupId; });
      removeOffEntries(d, grp.gameId, taskIds.concat([groupId]));
      d.groups = d.groups.filter(function (x) { return x.id !== groupId; });
      return { ok: true };
    }
    function moveGroup(d, groupId, delta) {
      var grp = findGroup(d, groupId); if (!grp) return fail('묶음을 찾을 수 없어요.');
      return moveWithin(d.groups, groupId, delta, function (x) { return x.gameId === grp.gameId; });
    }

    /* ----- 숙제 ----- */
    // 한 줄에 하나씩. 빈 줄은 무시하고 앞뒤 공백은 뗀다. at은 만든 시각(Reset.now()).
    function addTasks(d, groupId, text, at) {
      var grp = findGroup(d, groupId); if (!grp) return fail('묶음을 찾을 수 없어요.');
      if (typeof text !== 'string') return fail('숙제 이름을 한 줄에 하나씩 적어 주세요.');
      var lines = text.split(/\r\n|\r|\n/);
      var names = [];
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        if (names.length >= OPS_LIMIT.taskLines) return fail('한 번에 ' + OPS_LIMIT.taskLines + '줄까지 추가할 수 있어요.');
        var n = cleanName(lines[i]);
        if (n.error) return fail((i + 1) + '번째 줄: ' + n.error);
        names.push(n.value);
      }
      if (names.length === 0) return fail('숙제 이름을 한 줄에 하나씩 적어 주세요.');
      var created = global.Reset.formatIso(at);
      var used = allIds(d);
      names.forEach(function (name) {
        d.tasks.push({ id: makeId('tk', used), groupId: groupId, name: name, low: false, createdAt: created });
      });
      return { ok: true, added: names.length };
    }
    function renameTask(d, taskId, name) {
      var t = findTask(d, taskId); if (!t) return fail('숙제를 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      t.name = n.value;
      return { ok: true };
    }
    function setTaskLow(d, taskId, low) {
      var t = findTask(d, taskId); if (!t) return fail('숙제를 찾을 수 없어요.');
      t.low = low === true;
      return { ok: true };
    }
    // 숙제의 메모(고정 메모, 숙제마다 하나)를 바꾼다. 비면 지운다. 같은 값이면 noop.
    function setMemo(d, taskId, text) {
      var t = findTask(d, taskId); if (!t) return fail('숙제를 찾을 수 없어요.');
      if (typeof text !== 'string') return fail('메모는 글이어야 해요.');
      var m = cleanMemo(text);
      if (m.length > LIMIT.memo) return fail('메모는 ' + LIMIT.memo + '자까지예요.');
      if (m === (typeof t.memo === 'string' ? t.memo : '')) return { ok: true, noop: true };
      if (m) t.memo = m; else delete t.memo;
      return { ok: true };
    }
    function impactTask(d, taskId) {
      var c = recordCount(d, toSet([taskId]), null, null);
      return { records: c.records };
    }
    function deleteTask(d, taskId) {
      var t = findTask(d, taskId); if (!t) return fail('숙제를 찾을 수 없어요.');
      var grp = findGroup(d, t.groupId);
      d.records = d.records.filter(function (r) { return r.taskId !== taskId; });
      d.tasks = d.tasks.filter(function (x) { return x.id !== taskId; });
      if (grp) removeOffEntries(d, grp.gameId, [taskId]);
      return { ok: true };
    }
    function moveTask(d, taskId, delta) {
      var t = findTask(d, taskId); if (!t) return fail('숙제를 찾을 수 없어요.');
      return moveWithin(d.tasks, taskId, delta, function (x) { return x.groupId === t.groupId; });
    }

    /* ----- 체크 (메인 화면, 4단계) ----- */
    // at은 체크한 시각(Reset.now()). 판정은 모두 reset.js(Reset)에 맡기고, 여기서는 그 결과로 기록을 쌓거나 지우기만 한다.

    function groupContext(d, groupId) {
      var group = findGroup(d, groupId);
      if (!group) return null;
      var game = findGame(d, group.gameId);
      var cycle = null;
      game.cycles.forEach(function (c) { if (c.id === group.cycleId) cycle = c; });
      return { group: group, game: game, cycle: cycle };
    }
    function evalFolder(d, ctx, folderId, at) {
      return global.Reset.evaluateGroup({ group: ctx.group, cycle: ctx.cycle, tasks: d.tasks, folders: ctx.game.folders, folderId: folderId,
        records: d.records, groupRecords: d.groupRecords, at: at });
    }
    // 묶음의 범위 단계 폴더들. rootFolderId가 null이면 게임 전체, 아니면 그 폴더와 아래 폴더 중에서.
    function scopeFolders(ctx, rootFolderId) {
      var tree = rootFolderId === null ? ctx.game.folders : subtree(ctx.game, rootFolderId);
      return tree.filter(function (f) { return f.level === ctx.group.scope; });
    }
    function validAt(at) { return at instanceof Date && !isNaN(at.getTime()); }
    var BAD_AT = '시각이 올바르지 않아요.';

    // 폴더 체크 대상의 공통 검사: 범위 단계 이하의 폴더여야 한다.
    function folderContext(d, groupId, folderId) {
      var ctx = groupContext(d, groupId);
      if (!ctx) return { error: '묶음을 찾을 수 없어요.' };
      if (typeof ctx.group.scope !== 'number') return { error: '게임 공통 묶음에는 폴더 체크가 없어요.' };
      var loc = typeof folderId === 'string' ? findFolder(d, folderId) : null;
      if (!loc || loc.game.id !== ctx.game.id) return { error: '폴더를 찾을 수 없어요.' };
      if (loc.folder.level > ctx.group.scope) {
        return { error: '이 묶음은 "' + ctx.game.levels[ctx.group.scope - 1] + '" 단계의 폴더마다 체크해요. 그보다 아래 폴더는 체크할 수 없어요.' };
      }
      return { ctx: ctx };
    }

    // 칸 하나(숙제 + 폴더)의 공통 검사. 체크와 해제가 같은 규칙을 쓴다:
    //   숙제가 있어야 하고, 게임 공통이면 폴더가 없어야 하고, 단계 범위면 그 단계의 폴더여야 하며, 그 폴더가 끈 숙제·묶음이면 오류다.
    function cellContext(d, taskId, folderId) {
      var task = findTask(d, taskId); if (!task) return { error: '숙제를 찾을 수 없어요.' };
      var ctx = groupContext(d, task.groupId);
      var fid = folderId === undefined || folderId === null ? null : folderId;
      if (typeof ctx.group.scope !== 'number') {
        if (fid !== null) return { error: '게임 공통 숙제에는 폴더가 없어요.' };
      } else {
        var loc = typeof fid === 'string' ? findFolder(d, fid) : null;
        if (!loc || loc.game.id !== ctx.game.id || loc.folder.level !== ctx.group.scope) {
          return { error: '이 숙제는 "' + ctx.game.levels[ctx.group.scope - 1] + '" 단계의 폴더마다 체크해요.' };
        }
        if (global.Reset.isOff(ctx.game.folders, fid, task.id) || global.Reset.isOff(ctx.game.folders, fid, ctx.group.id)) {
          return { error: '이 폴더에서는 하지 않는 숙제예요.' };
        }
      }
      return { ctx: ctx, fid: fid };
    }

    // 칸 하나 체크: 그 칸이 이번 기간에 완료가 아니면 완료 기록 하나. 이미 완료면 noop.
    function checkTask(d, taskId, folderId, at) {
      if (!validAt(at)) return fail(BAD_AT);
      var c = cellContext(d, taskId, folderId); if (c.error) return fail(c.error);
      if (global.Reset.isTaskDone({ cycle: c.ctx.cycle, taskId: taskId, folderId: c.fid, records: d.records, at: at })) return { ok: true, noop: true };
      d.records.push({ taskId: taskId, folderId: c.fid, doneAt: global.Reset.formatIso(at) });
      return { ok: true, added: 1 };
    }

    // 칸 하나 해제: 그 숙제·그 폴더의 이번 기간 기록만 지운다. 지난 기간 기록은 건드리지 않는다. 끈 칸은 체크처럼 오류다.
    function uncheckTask(d, taskId, folderId, at) {
      if (!validAt(at)) return fail(BAD_AT);
      var c = cellContext(d, taskId, folderId); if (c.error) return fail(c.error);
      var period = global.Reset.currentPeriod(c.ctx.cycle, at);
      var removed = 0;
      d.records = d.records.filter(function (r) {
        var hit = r.taskId === taskId && (r.folderId == null ? null : r.folderId) === c.fid && global.Reset.inPeriod(r.doneAt, period);
        if (hit) removed++;
        return !hit;
      });
      return removed ? { ok: true, removed: removed } : { ok: true, noop: true };
    }

    // 폴더 체크 (위 단계 폴더도 된다): 그 폴더와 아래 폴더 중 묶음 범위 단계의 폴더마다 완료 처리한다.
    //   묶음을 끈 폴더, 활성 숙제가 없는 폴더, 이미 완료인 폴더는 건너뛴다.
    //   필요 개수가 있는 묶음은 폴더마다 묶음 완료 기록 하나, 없으면 끄지 않은 숙제 중 이번 기간에 안 한 것 전부에 완료 기록.
    function checkFolder(d, groupId, folderId, at) {
      if (!validAt(at)) return fail(BAD_AT);
      var fc = folderContext(d, groupId, folderId); if (fc.error) return fail(fc.error);
      var ctx = fc.ctx;
      var doneAt = global.Reset.formatIso(at);
      var folders = 0, records = 0, groupRecords = 0;
      scopeFolders(ctx, folderId).forEach(function (f) {
        var e = evalFolder(d, ctx, f.id, at);
        if (e.empty || e.done) return;
        folders++;
        if (ctx.group.required != null) {
          d.groupRecords.push({ groupId: groupId, folderId: f.id, doneAt: doneAt });
          groupRecords++;
        } else {
          e.tasks.forEach(function (s) {
            if (s.state !== 'todo') return;
            d.records.push({ taskId: s.taskId, folderId: f.id, doneAt: doneAt });
            records++;
          });
        }
      });
      return records || groupRecords ? { ok: true, folders: folders, records: records, groupRecords: groupRecords } : { ok: true, noop: true };
    }

    // 열 머리 체크: 그 숙제를 범위 단계의 모든 폴더에 완료 처리한다.
    //   그 숙제나 묶음을 끈 폴더, 이미 한 폴더, 묶음이 완료돼 회색인 폴더는 건너뛴다.
    function checkColumn(d, taskId, at) {
      if (!validAt(at)) return fail(BAD_AT);
      var task = findTask(d, taskId); if (!task) return fail('숙제를 찾을 수 없어요.');
      var ctx = groupContext(d, task.groupId);
      if (typeof ctx.group.scope !== 'number') return fail('게임 공통 숙제에는 열 머리 체크가 없어요.');
      var doneAt = global.Reset.formatIso(at);
      var records = 0;
      scopeFolders(ctx, null).forEach(function (f) {
        var e = evalFolder(d, ctx, f.id, at);
        if (e.empty) return;
        e.tasks.forEach(function (s) {
          if (s.taskId !== taskId || s.state !== 'todo') return;
          d.records.push({ taskId: taskId, folderId: f.id, doneAt: doneAt });
          records++;
        });
      });
      return records ? { ok: true, records: records } : { ok: true, noop: true };
    }

    // 폴더 체크 해제: 대상 폴더들에서 그 묶음 숙제들의 이번 기간 기록과 묶음 완료 기록만 지운다.
    function uncheckFolder(d, groupId, folderId, at) {
      if (!validAt(at)) return fail(BAD_AT);
      var fc = folderContext(d, groupId, folderId); if (fc.error) return fail(fc.error);
      var ctx = fc.ctx;
      var period = global.Reset.currentPeriod(ctx.cycle, at);
      var targets = toSet(scopeFolders(ctx, folderId).map(function (f) { return f.id; }));
      var taskIds = toSet(d.tasks.filter(function (t) { return t.groupId === groupId; }).map(function (t) { return t.id; }));
      var removed = 0;
      d.records = d.records.filter(function (r) {
        var hit = taskIds[r.taskId] && r.folderId != null && targets[r.folderId] && global.Reset.inPeriod(r.doneAt, period);
        if (hit) removed++;
        return !hit;
      });
      d.groupRecords = d.groupRecords.filter(function (r) {
        var hit = r.groupId === groupId && r.folderId != null && targets[r.folderId] && global.Reset.inPeriod(r.doneAt, period);
        if (hit) removed++;
        return !hit;
      });
      return removed ? { ok: true, removed: removed } : { ok: true, noop: true };
    }

    /* ----- 프리셋 (8단계) ----- */
    // 프리셋은 { id, name, savedAt?, game: { cycles, levels, folders, groups, tasks } } 모양이다 (기본 프리셋은 presets.js가 같은 모양으로 만든다).
    // 불러오기와 저장은 내용을 새 id로 복사하므로, 만들어진 쪽과 원본은 서로 영향을 주지 않는다.

    // 주기·폴더·묶음·숙제를 새 id로 복사한다. 주기의 carry(기록 이력에 딸린 값)는 버리고, 폴더의 끈 항목은 새 id로 다시 잇는다.
    // 돌려주는 값: { cycles, folders, groups(gameId 없음), tasks(createdAt 없음) }
    function cloneContent(cycles, folders, groups, tasks, used) {
      // 주기 id와 묶음·숙제 id는 종류가 다르니 맵을 따로 둔다 (같은 문자열이어도 섞이지 않게).
      // 묶음과 숙제의 id는 같은 게임 안에서 겹치지 않으므로 맵 하나를 같이 쓴다 (폴더의 끈 항목이 둘 다 가리킨다).
      var cycleMap = Object.create(null);
      var idMap = Object.create(null);
      function fresh(prefix, old, map) { var id = makeId(prefix, used); map[old] = id; return id; }
      var outCycles = cycles.map(function (c) {
        var o = JSON.parse(JSON.stringify(c));
        delete o.carry;
        o.id = fresh('cy', c.id, cycleMap);
        return o;
      });
      var outGroups = groups.map(function (g) {
        return { id: fresh('gr', g.id, idMap), name: g.name, cycleId: cycleMap[g.cycleId], scope: g.scope, required: g.required === undefined ? null : g.required, low: g.low === true };
      });
      var outTasks = tasks.map(function (x) {
        var o = { id: fresh('tk', x.id, idMap), groupId: idMap[x.groupId], name: x.name, low: x.low === true };
        if (typeof x.memo === 'string' && x.memo !== '') o.memo = x.memo; // 메모도 숙제 구성의 일부
        return o;
      });
      var folderMap = Object.create(null);
      var outFolders = folders.map(function (f) { var id = makeId('fo', used); folderMap[f.id] = id; return { id: id, f: f }; }).map(function (x) {
        var f = x.f;
        return { id: x.id, parentId: f.parentId == null ? null : folderMap[f.parentId], level: f.level, name: f.name,
          off: (f.off || []).map(function (o) { return idMap[o]; }).filter(function (o) { return o !== undefined; }) };
      });
      return { cycles: outCycles, folders: outFolders, groups: outGroups, tasks: outTasks };
    }

    // 프리셋으로 새 게임 하나를 추가한다. 기존 게임·기록·다른 프리셋은 건드리지 않는다.
    // o: { folderText?, sameName: 'ask' | 'add', at }
    //   같은 이름의 게임이 있고 sameName이 'ask'이면 아무것도 바꾸지 않고 { ok:false, needsConfirm:'sameName' }을 돌려준다.
    //   프리셋에 폴더가 있으면 그 구조와 끈 항목을 그대로 복사하고(folderText는 무시), 없으면 folderText(들여쓰기)로 폴더를 만든다.
    //   숙제의 만든 시각(createdAt)은 at이다.
    function addGameFromPreset(d, preset, o) {
      o = o || {};
      if (!isObj(preset) || !isObj(preset.game)) return fail('프리셋을 찾을 수 없어요.');
      if (!validAt(o.at)) return fail(BAD_AT);
      var n = cleanName(preset.name); if (n.error) return fail(n.error);
      if (d.games.length >= LIMIT.games) return fail('게임은 ' + LIMIT.games + '개까지예요.');
      var pg = preset.game;
      // 폴더 입력 검증을 같은 이름 확인보다 먼저 한다 (잘못된 입력은 첫 창에서 바로 오류로 나오고 입력이 남는다)
      var nodes = null;
      if (!pg.folders.length && pg.levels.length > 0 && typeof o.folderText === 'string' && o.folderText.trim() !== '') {
        var parsed = parseFolderTree(o.folderText, pg.levels.length);
        if (!parsed.ok) return parsed;
        nodes = parsed.nodes;
      }
      var same = d.games.some(function (g) { return g.name === n.value; });
      if (same && o.sameName !== 'add') return { ok: false, needsConfirm: 'sameName', error: '같은 이름의 게임이 이미 있어요.' };
      var used = allIds(d);
      var gid = makeId('gm', used);
      var c = cloneContent(pg.cycles, pg.folders, pg.groups, pg.tasks, used);
      if (nodes) {
        var stack = [];
        nodes.forEach(function (node) {
          var up = node.depth === 0 ? null : stack[node.depth - 1];
          var f = { id: makeId('fo', used), parentId: up ? up.id : null, level: node.depth + 1, name: node.name, off: [] };
          c.folders.push(f);
          stack[node.depth] = f;
          stack.length = node.depth + 1;
        });
      }
      if (c.folders.length > LIMIT.folders) return fail('폴더는 한 게임에 ' + LIMIT.folders + '개까지예요.');
      var created = global.Reset.formatIso(o.at);
      d.games.push({ id: gid, name: n.value, cycles: c.cycles, levels: pg.levels.slice(), folders: c.folders });
      c.groups.forEach(function (g) { d.groups.push({ id: g.id, gameId: gid, name: g.name, cycleId: g.cycleId, scope: g.scope, required: g.required, low: g.low }); });
      c.tasks.forEach(function (x) {
        var t = { id: x.id, groupId: x.groupId, name: x.name, low: x.low, createdAt: created };
        if (x.memo !== undefined) t.memo = x.memo;
        d.tasks.push(t);
      });
      return { ok: true, id: gid, summary: { cycles: c.cycles.length, groups: c.groups.length, tasks: c.tasks.length, folders: c.folders.length } };
    }

    // 게임 하나를 "내 프리셋"으로 저장한다 (이름·주기·단계·폴더와 끈 항목·묶음·숙제만. 완료 기록과 주기의 carry는 넣지 않는다).
    // 같은 이름의 프리셋이 있고 mode가 'overwrite'가 아니면 { ok:false, needsConfirm:'sameName', existingId }를 돌려준다.
    // 덮어쓰기('overwrite')는 existingId(첫 호출이 돌려준 것)가 가리키는 프리셋을 덮어쓴다. 그 id가 없으면 이름이 같은 것 중 첫 번째다.
    function savePreset(d, gameId, name, mode, at, existingId) {
      var g = findGame(d, gameId); if (!g) return fail('게임을 찾을 수 없어요.');
      if (!validAt(at)) return fail(BAD_AT);
      var n = cleanName(name); if (n.error) return fail(n.error);
      var same = null;
      if (mode === 'overwrite' && existingId !== undefined) {
        d.presets.forEach(function (p) { if (p.id === existingId) same = p; });
        if (!same) return fail('덮어쓸 프리셋을 찾을 수 없어요.');
      } else {
        for (var pi = 0; pi < d.presets.length && !same; pi++) if (d.presets[pi].name === n.value) same = d.presets[pi];
      }
      if (same && mode !== 'overwrite') return { ok: false, needsConfirm: 'sameName', existingId: same.id, error: '같은 이름의 프리셋이 이미 있어요.' };
      if (!same && d.presets.length >= LIMIT.presets) return fail('내 프리셋은 ' + LIMIT.presets + '개까지예요.');
      var used = allIds(d);
      var groups = groupsOf(d, gameId);
      var c = cloneContent(g.cycles, g.folders, groups, tasksOfGroups(d, groups.map(function (x) { return x.id; })), used);
      var preset = { id: same ? same.id : makeId('ps', used), name: n.value, savedAt: global.Reset.formatIso(at),
        game: { cycles: c.cycles, levels: g.levels.slice(), folders: c.folders, groups: c.groups, tasks: c.tasks } };
      if (same) d.presets[d.presets.indexOf(same)] = preset; else d.presets.push(preset);
      return { ok: true, id: preset.id, overwritten: !!same };
    }

    function renamePreset(d, presetId, name) {
      var p = null;
      d.presets.forEach(function (x) { if (x.id === presetId) p = x; });
      if (!p) return fail('프리셋을 찾을 수 없어요.');
      var n = cleanName(name); if (n.error) return fail(n.error);
      var dup = d.presets.some(function (x) { return x !== p && x.name === n.value; });
      if (dup) return fail('같은 이름의 프리셋이 이미 있어요.');
      p.name = n.value;
      return { ok: true };
    }

    // 내 프리셋만 지울 수 있다. 기본 프리셋은 저장소에 없고 코드에만 있으므로 지울 대상이 아니다.
    function deletePreset(d, presetId) {
      var before = d.presets.length;
      d.presets = d.presets.filter(function (x) { return x.id !== presetId; });
      if (d.presets.length === before) return fail('프리셋을 찾을 수 없어요. (기본 프리셋은 지울 수 없어요.)');
      return { ok: true };
    }

    return {
      checkTask: checkTask, uncheckTask: uncheckTask, checkFolder: checkFolder, checkColumn: checkColumn, uncheckFolder: uncheckFolder,
      addGameFromPreset: addGameFromPreset, savePreset: savePreset, renamePreset: renamePreset, deletePreset: deletePreset,
      addGame: addGame, renameGame: renameGame, impactGame: impactGame, deleteGame: deleteGame, moveGame: moveGame,
      addCycle: addCycle, updateCycle: updateCycle, canDeleteCycle: canDeleteCycle, deleteCycle: deleteCycle,
      addLevelBelow: addLevelBelow, addLevelAbove: addLevelAbove, renameLevel: renameLevel, impactLevel: impactLevel, canDeleteLevel: canDeleteLevel, deleteLevel: deleteLevel,
      parseFolderTree: parseFolderTree, addFolders: addFolders, renameFolder: renameFolder, cloneFolder: cloneFolder,
      eligibleParents: eligibleParents, moveFolderTo: moveFolderTo, impactFolder: impactFolder, deleteFolder: deleteFolder,
      moveFolder: moveFolder, folderList: folderList, offList: offList, setOff: setOff,
      addGroup: addGroup, updateGroup: updateGroup, groupHasRecords: groupHasRecords, impactGroup: impactGroup, deleteGroup: deleteGroup, moveGroup: moveGroup,
      addTasks: addTasks, renameTask: renameTask, setTaskLow: setTaskLow, setMemo: setMemo, impactTask: impactTask, deleteTask: deleteTask, moveTask: moveTask
    };
  })();

  /* ---------- 저장소 인스턴스 ---------- */

  function create(storage) {
    var mem = deepFreeze(emptyData());
    var state = { status: 'empty', error: null, persistent: false, raw: null };

    function readRaw() {
      try { return { ok: true, value: storage.getItem(KEY) }; } catch (e) { return { ok: false }; }
    }

    // 저장소의 원문(value)을 읽어 메모리 상태로 바꾼다.
    function applyRaw(value) {
      state.raw = value;
      if (value === null) { mem = deepFreeze(emptyData()); state.status = 'empty'; state.error = null; return; }
      var parsed;
      try { parsed = JSON.parse(value); } catch (e) {
        mem = deepFreeze(emptyData()); state.status = 'corrupted';
        state.error = '저장된 데이터를 읽지 못했어요. JSON 형식이 아니에요.';
        return;
      }
      var v, clean = null;
      try {
        v = validateData(parsed);
        if (v.ok) clean = normalize(parsed).data;
      } catch (e) {
        v = { ok: false, error: '데이터 형식이 올바르지 않아요.' };
      }
      if (!v.ok || !clean) {
        mem = deepFreeze(emptyData()); state.status = 'corrupted';
        state.error = '저장된 데이터가 올바르지 않아요. ' + v.error;
        return;
      }
      mem = deepFreeze(clean);
      state.status = 'ok';
      state.error = null;
    }

    function load() {
      if (!storage) { state.persistent = false; state.status = 'unavailable'; state.error = '이 브라우저에서는 저장할 수 없어요.'; return status(); }
      var r = readRaw();
      if (!r.ok) { state.persistent = false; state.status = 'unavailable'; state.error = '이 브라우저에서는 저장할 수 없어요.'; return status(); }
      state.persistent = true;
      applyRaw(r.value);
      return status();
    }

    // 다른 탭이 저장소를 바꿨으면 따라간다. 저장소가 있는 모드에서 읽지 못하면 false (메모리 모드는 읽을 것이 없으니 true).
    function sync() {
      if (!state.persistent) return true;
      var r = readRaw();
      if (!r.ok) return false;
      if (r.value !== state.raw) applyRaw(r.value);
      return true;
    }

    function status() {
      sync();
      return { status: state.status, error: state.error, persistent: state.persistent };
    }

    function get() {
      sync();
      return mem;
    }

    function writeRaw(text) {
      try { storage.setItem(KEY, text); return true; } catch (e) { return false; }
    }

    // 손상된 원문을 백업 키에 보관한다. 보관하지 못하면 false.
    function stash() {
      if (state.raw === null) return true;
      try { storage.setItem(BROKEN_KEY, state.raw); return true; } catch (e) { return false; }
    }

    // 후보 데이터를 "실제로 저장될 JSON" 기준으로 검증한다: 직렬화 → 다시 읽기 → 검증 → 정규화.
    // (빈칸이 null이 되거나 Date가 문자열이 되는 차이를 저장 전에 드러내고, 저장·스냅샷에 같은 값을 쓴다.)
    // 돌려주는 값: { ok:true, clean, text, dropped } 또는 { ok:false, error, errors? }
    function prepare(candidate, errPrefix) {
      var parsed, text;
      try {
        text = JSON.stringify(candidate);
        if (typeof text !== 'string') return { ok: false, error: errPrefix + '저장할 수 없는 값이에요.' };
        parsed = JSON.parse(text);
      } catch (e) { return { ok: false, error: errPrefix + '저장할 수 없는 값이 있어요.' }; }
      var v = validateData(parsed);
      if (!v.ok) return { ok: false, error: errPrefix + v.error, errors: v.errors };
      var norm;
      try { norm = normalize(parsed); text = JSON.stringify(norm.data); } catch (e) { return { ok: false, error: errPrefix + '데이터 형식이 올바르지 않아요.' }; }
      if (text.length > WRITE_LIMIT) return { ok: false, error: MSG.tooBig };
      return { ok: true, clean: norm.data, text: text, dropped: norm.dropped };
    }

    // 변경 하나를 적용한다. fn(draft)는 draft(복사본)를 고치거나 새 데이터를 돌려준다.
    // 검증이나 저장에 실패하면 아무것도 바꾸지 않고 { ok:false, error }를 돌려준다.
    function update(fn) {
      if (!sync()) return { ok: false, error: MSG.readFail };
      if (state.status === 'corrupted') return { ok: false, error: MSG.corrupted };
      var draft = clone(mem);
      var result;
      try { result = fn(draft); } catch (e) { return { ok: false, error: '변경하지 못했어요. 변경 중에 오류가 났어요.' }; }
      if (result === NOOP) return { ok: true, data: mem };
      if (result !== undefined) draft = result;
      var p = prepare(draft, '변경하지 못했어요. ');
      if (!p.ok) return { ok: false, error: p.error, errors: p.errors };
      if (state.persistent) {
        if (!writeRaw(p.text)) return { ok: false, error: MSG.saveFail };
        state.raw = p.text;
      }
      mem = deepFreeze(p.clean);
      if (state.status === 'empty') state.status = 'ok';
      return { ok: true, data: mem };
    }

    // Store.ops의 변경 하나를 적용한다: apply(function (d) { return Store.ops.xxx(d, …); }).
    // ops가 { ok:false }를 돌려주면 저장하지 않고 그 오류를 그대로 돌려준다. { noop:true }면 저장하지 않는다.
    function apply(fn) {
      var r = null;
      var u = update(function (d) {
        r = fn(d);
        if (!r || !r.ok || r.noop) return NOOP;
      });
      if (!u.ok) return { ok: false, error: u.error, errors: u.errors };
      if (!r || !r.ok) return r || { ok: false, error: '변경하지 못했어요.' };
      var out = {};
      Object.keys(r).forEach(function (k) { out[k] = r[k]; });
      out.data = u.data;
      return out;
    }

    // 완료 기록을 쌓는다. 한 번 호출 = 한 번 저장 (전부 저장되거나 하나도 안 된다).
    // 기록 하나의 모양을 검사하고 저장할 모양으로 바꾼다. 올바르지 않으면 null. (key: 'taskId' | 'groupId')
    function recordShape(r, key) {
      if (!isObj(r) || typeof r[key] !== 'string') return null;
      if (!(r.folderId === undefined || r.folderId === null || typeof r.folderId === 'string')) return null;
      var doneAt;
      if (typeof r.doneAt === 'string') doneAt = r.doneAt;
      else if (r.doneAt instanceof Date && !isNaN(r.doneAt.getTime())) doneAt = global.Reset.formatIso(r.doneAt);
      else return null;
      var out = {};
      out[key] = r[key];
      out.folderId = r.folderId === undefined ? null : r.folderId;
      out.doneAt = doneAt;
      return out;
    }

    function addRecords(records, groupRecords) {
      if ((records !== undefined && !Array.isArray(records)) || (groupRecords !== undefined && !Array.isArray(groupRecords))) return { ok: false, error: MSG.badRecords };
      var rs = (records || []).map(function (r) { return recordShape(r, 'taskId'); });
      var gs = (groupRecords || []).map(function (r) { return recordShape(r, 'groupId'); });
      if (rs.indexOf(null) >= 0 || gs.indexOf(null) >= 0) return { ok: false, error: MSG.badRecords };
      return update(function (d) {
        rs.forEach(function (r) { d.records.push(r); });
        gs.forEach(function (r) { d.groupRecords.push(r); });
      });
    }

    // 체크·해제 (메인 화면): { taskId?, groupId?, folderId?, at? }. at이 없으면 지금(Reset.now()). 한 번의 호출 = 한 번의 저장.
    function checkCall(opName, pick) {
      return function (a) {
        if (!isObj(a)) return { ok: false, error: '조건이 올바르지 않아요.' };
        var at = a.at === undefined ? global.Reset.now() : a.at;
        return apply(function (d) { return ops[opName].apply(null, [d].concat(pick(a)).concat([at])); });
      };
    }
    var checkTask = checkCall('checkTask', function (a) { return [a.taskId, a.folderId]; });
    var uncheckTask = checkCall('uncheckTask', function (a) { return [a.taskId, a.folderId]; });
    var checkFolder = checkCall('checkFolder', function (a) { return [a.groupId, a.folderId]; });
    var uncheckFolder = checkCall('uncheckFolder', function (a) { return [a.groupId, a.folderId]; });
    var checkColumn = checkCall('checkColumn', function (a) { return [a.taskId]; });

    function validDate(x) { return x instanceof Date && !isNaN(x.getTime()); }

    // 체크 해제용: 기간 안에 있는 기록만 지운다. 기간 밖 기록은 건드리지 않는다.
    // spec: { taskIds?: [id], groupId?: id, folderIds: [id | null], period }
    //   period는 start·end가 모두 Date({start, end}, 끝은 포함하지 않음)이거나, 1회 주기처럼 끝이 없을 때만 { once:true, start: Date | null }이다.
    //   조건이 올바르지 않으면 아무것도 지우지 않고 { ok:false, error }를 돌려준다.
    function removeRecordsInPeriod(spec) {
      var bad = { ok: false, error: MSG.badRemove };
      if (!isObj(spec)) return bad;
      var taskIds = spec.taskIds === undefined ? [] : spec.taskIds;
      var folderIds = spec.folderIds;
      if (!Array.isArray(taskIds) || !taskIds.every(function (x) { return typeof x === 'string'; })) return bad;
      if (!(spec.groupId === undefined || spec.groupId === null || typeof spec.groupId === 'string')) return bad;
      if (!Array.isArray(folderIds) || !folderIds.every(function (x) { return x === null || typeof x === 'string'; })) return bad;
      if (taskIds.length === 0 && (spec.groupId === undefined || spec.groupId === null)) return bad;
      var p = spec.period, period;
      if (!isObj(p)) return bad;
      if (p.once === true) {
        if (!(p.end === undefined || p.end === null)) return bad;
        if (!(p.start === undefined || p.start === null || validDate(p.start))) return bad;
        period = { start: p.start || null, end: null };
      } else {
        if (!validDate(p.start) || !validDate(p.end) || p.start.getTime() >= p.end.getTime()) return bad;
        period = { start: p.start, end: p.end };
      }
      var removed = 0;
      function match(folderId) { return folderIds.indexOf(folderId == null ? null : folderId) >= 0; }
      var res = update(function (d) {
        var keepRecords = d.records.filter(function (r) {
          var hit = taskIds.indexOf(r.taskId) >= 0 && match(r.folderId) && global.Reset.inPeriod(r.doneAt, period);
          if (hit) removed++;
          return !hit;
        });
        var keepGroupRecords = d.groupRecords.filter(function (r) {
          var hit = spec.groupId != null && r.groupId === spec.groupId && match(r.folderId) && global.Reset.inPeriod(r.doneAt, period);
          if (hit) removed++;
          return !hit;
        });
        if (removed === 0) return NOOP;
        d.records = keepRecords;
        d.groupRecords = keepGroupRecords;
      });
      return res.ok ? { ok: true, removed: removed } : res;
    }

    // 내보내기: { text, filename }. 완료 기록과 내 프리셋을 전부 포함한다.
    function exportJson(at) {
      var d = get();
      var when = at || global.Reset.now();
      function p(n) { return n < 10 ? '0' + n : String(n); }
      var out = {
        app: APP, version: VERSION, exportedAt: global.Reset.formatIso(when),
        games: d.games, groups: d.groups, tasks: d.tasks,
        records: d.records, groupRecords: d.groupRecords, presets: d.presets
      };
      return {
        text: JSON.stringify(out),
        filename: 'game-homework-' + when.getFullYear() + p(when.getMonth() + 1) + p(when.getDate()) + '-' + p(when.getHours()) + p(when.getMinutes()) + '.json'
      };
    }

    // 가져오기: 구조 검증을 통과했을 때만 기존 데이터를 교체한다. 실패하면 기존 데이터는 그대로다.
    function importJson(text) {
      if (!sync()) return { ok: false, error: MSG.readFail };
      if (typeof text !== 'string') return { ok: false, error: '파일 내용을 읽지 못했어요.' };
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (text.length > LIMIT.text) return { ok: false, error: '파일이 너무 커요. JSON 600만 글자까지 가져올 수 있어요.' };
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: '올바른 JSON 파일이 아니에요.' }; }
      if (isObj(parsed) && parsed.app !== undefined && parsed.app !== APP) {
        return { ok: false, error: '이 앱에서 내보낸 파일이 아니에요.' };
      }
      var p = prepare(parsed, '');
      if (!p.ok) return { ok: false, error: p.error === MSG.tooBig ? '파일이 너무 커요. JSON 600만 글자까지 가져올 수 있어요.' : p.error, errors: p.errors };
      var norm = { data: p.clean, dropped: p.dropped };
      var out = p.text;
      if (state.persistent) {
        if (state.status === 'corrupted' && !stash()) return { ok: false, error: MSG.stashFail };
        if (!writeRaw(out)) return { ok: false, error: MSG.saveFail };
        state.raw = out;
      }
      mem = deepFreeze(norm.data);
      state.status = state.persistent ? 'ok' : 'unavailable';
      state.error = state.persistent ? null : state.error;
      return {
        ok: true,
        summary: {
          games: mem.games.length, groups: mem.groups.length, tasks: mem.tasks.length,
          records: mem.records.length, groupRecords: mem.groupRecords.length, presets: mem.presets.length,
          dropped: norm.dropped
        }
      };
    }

    // 손상된 원문 (내려받기용). 손상이 없으면 현재 저장된 원문(없으면 null).
    function rawText() {
      sync();
      return state.raw;
    }

    // 새로 시작: 손상된 원문을 백업 키로 옮기고 빈 데이터로 시작한다.
    function startFresh() {
      sync();
      if (state.status !== 'corrupted') return { ok: false, error: '손상된 데이터가 없어요.' };
      if (!stash()) return { ok: false, error: MSG.stashFail };
      try { storage.removeItem(KEY); } catch (e) { return { ok: false, error: MSG.saveFail }; }
      state.raw = null;
      mem = deepFreeze(emptyData());
      state.status = 'empty';
      state.error = null;
      return { ok: true };
    }

    // 새 id. 접두어 + 시간(36진수) + 난수. 이미 있는 id와 겹치지 않는다.
    function newId(prefix) {
      return makeId(prefix, allIds(get()));
    }

    load();

    return {
      load: load, status: status, get: get, update: update, apply: apply,
      addRecords: addRecords, removeRecordsInPeriod: removeRecordsInPeriod,
      checkTask: checkTask, uncheckTask: uncheckTask, checkFolder: checkFolder, checkColumn: checkColumn, uncheckFolder: uncheckFolder,
      exportJson: exportJson, importJson: importJson,
      rawText: rawText, startFresh: startFresh, newId: newId
    };
  }

  var defaultStorage = null;
  try { defaultStorage = global.localStorage || null; } catch (e) { defaultStorage = null; }

  var api = create(defaultStorage);
  api.create = create;
  api.ops = ops;
  api.NOOP = NOOP;
  api.validateData = validateData;
  api.KEY = KEY;
  api.BROKEN_KEY = BROKEN_KEY;
  api.VERSION = VERSION;
  api.LIMIT = LIMIT;
  global.Store = api;
})(typeof window !== 'undefined' ? window : this);
