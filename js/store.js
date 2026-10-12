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
    corrupted: '저장된 데이터가 손상돼 있어서 저장할 수 없어요. 손상된 원문을 내려받거나, 새로 시작하거나, JSON 파일을 가져와 복구해 주세요.',
    saveFail: '저장하지 못했어요. 저장 공간이 가득 찼을 수 있어요. 변경하지 않았어요. JSON으로 내보내 백업한 뒤 필요 없는 데이터를 지워 주세요.',
    stashFail: '손상된 데이터를 보관하지 못했어요. 먼저 손상된 원문을 내려받아 주세요.'
  };

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
  }

  // 폴더의 off가 가리키는 id가 실제 묶음·숙제인지 (validOff: id → true)
  function checkOff(folders, validOff, label, errs) {
    folders.forEach(function (f, i) {
      if (!isObj(f) || !Array.isArray(f.off)) return;
      f.off.forEach(function (id) {
        if (isId(id) && !validOff[id]) errs.add(label + '의 폴더 ' + (i + 1) + ': 끈 항목 "' + id + '"가 이 게임의 묶음이나 숙제가 아니에요.');
      });
    });
  }

  function validateData(data) {
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
      if (!(typeof t.groupId === 'string' && groupGame[t.groupId])) { errs.add(label + ': 묶음이 없어요.'); return; }
      checkTaskFields(t, label, errs, true);
      if (okId) { taskGame[t.id] = groupGame[t.groupId]; validOff[groupGame[t.groupId]][t.id] = true; }
    });

    data.games.forEach(function (g, i) {
      if (isObj(g) && validOff[g.id] && Array.isArray(g.folders)) checkOff(g.folders, validOff[g.id], '게임 ' + (i + 1), errs);
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
        if (checkIdUnique(t.id, ptasks, tl, errs)) ok[t.id] = true;
        if (!(typeof t.groupId === 'string' && pgroups[t.groupId])) errs.add(tl + ': 묶음이 없어요.');
        checkTaskFields(t, tl, errs, false);
      });
      if (Array.isArray(pg.folders)) checkOff(pg.folders, ok, label, errs);
    });

    return done();
  }

  /* ---------- 정규화: 알려진 필드만 남긴다 ---------- */

  function keep(src, allowed, ctx) {
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
      keep(c.every, ['days', 'hours', 'minutes'], ctx);
    }
    if (c.carry !== undefined) {
      out.carry = { since: c.carry.since };
      if (c.type !== 'once') out.carry.until = c.carry.until;
      keep(c.carry, ['since', 'until'], ctx);
    }
    keep(c, allowed, ctx);
    return out;
  }

  function normFolder(f, ctx) {
    keep(f, ['id', 'parentId', 'level', 'name', 'off'], ctx);
    return { id: f.id, parentId: f.parentId == null ? null : f.parentId, level: f.level, name: f.name, off: f.off.slice() };
  }

  function normGroup(g, withGameId, ctx) {
    keep(g, ['id', 'name', 'cycleId', 'scope', 'required', 'low'].concat(withGameId ? ['gameId'] : []), ctx);
    var out = { id: g.id };
    if (withGameId) out.gameId = g.gameId;
    out.name = g.name; out.cycleId = g.cycleId; out.scope = g.scope;
    out.required = g.required == null ? null : g.required;
    out.low = g.low === true;
    return out;
  }

  function normTask(t, withCreatedAt, ctx) {
    keep(t, ['id', 'groupId', 'name', 'low'].concat(withCreatedAt ? ['createdAt'] : []), ctx);
    var out = { id: t.id, groupId: t.groupId, name: t.name, low: t.low === true };
    if (withCreatedAt) out.createdAt = t.createdAt;
    return out;
  }

  // 검증을 통과한 데이터에서 알려진 필드만 복사해 새 객체를 만든다. { data, dropped }
  function normalize(data) {
    var ctx = { dropped: 0 };
    keep(data, ['app', 'exportedAt', 'version'].concat(DATA_KEYS), ctx); // app, exportedAt은 내보내기 메타라 버린 것으로 세지 않는다
    var out = {
      version: VERSION,
      games: data.games.map(function (g) {
        keep(g, ['id', 'name', 'cycles', 'levels', 'folders'], ctx);
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
        keep(r, ['taskId', 'folderId', 'doneAt'], ctx);
        return { taskId: r.taskId, folderId: r.folderId == null ? null : r.folderId, doneAt: r.doneAt };
      }),
      groupRecords: data.groupRecords.map(function (r) {
        keep(r, ['groupId', 'folderId', 'doneAt'], ctx);
        return { groupId: r.groupId, folderId: r.folderId == null ? null : r.folderId, doneAt: r.doneAt };
      }),
      presets: data.presets.map(function (p) {
        keep(p, ['id', 'name', 'savedAt', 'game'], ctx);
        keep(p.game, ['cycles', 'levels', 'folders', 'groups', 'tasks'], ctx);
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
      var v = validateData(parsed);
      if (!v.ok) {
        mem = deepFreeze(emptyData()); state.status = 'corrupted';
        state.error = '저장된 데이터가 올바르지 않아요. ' + v.error;
        return;
      }
      mem = deepFreeze(normalize(parsed).data);
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

    // 다른 탭이 저장소를 바꿨으면 따라간다.
    function sync() {
      if (!state.persistent) return;
      var r = readRaw();
      if (r.ok && r.value !== state.raw) applyRaw(r.value);
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

    // 변경 하나를 적용한다. fn(draft)는 draft(복사본)를 고치거나 새 데이터를 돌려준다.
    // 검증이나 저장에 실패하면 아무것도 바꾸지 않고 { ok:false, error }를 돌려준다.
    function update(fn) {
      sync();
      if (state.status === 'corrupted') return { ok: false, error: MSG.corrupted };
      var draft = clone(mem);
      var result;
      try { result = fn(draft); } catch (e) { return { ok: false, error: '변경하지 못했어요. 변경 중에 오류가 났어요.' }; }
      if (result === NOOP) return { ok: true, data: mem };
      if (result !== undefined) draft = result;
      var v = validateData(draft);
      if (!v.ok) return { ok: false, error: '변경하지 못했어요. ' + v.error, errors: v.errors };
      var clean = normalize(draft).data;
      var text = JSON.stringify(clean);
      if (state.persistent) {
        if (!writeRaw(text)) return { ok: false, error: MSG.saveFail };
        state.raw = text;
      }
      mem = deepFreeze(clean);
      if (state.status === 'empty') state.status = 'ok';
      return { ok: true, data: mem };
    }
    var NOOP = {};

    // 완료 기록을 쌓는다. 한 번 호출 = 한 번 저장 (전부 저장되거나 하나도 안 된다).
    function addRecords(records, groupRecords) {
      var rs = (records || []).map(function (r) {
        return { taskId: r.taskId, folderId: r.folderId == null ? null : r.folderId, doneAt: typeof r.doneAt === 'string' ? r.doneAt : global.Reset.formatIso(r.doneAt) };
      });
      var gs = (groupRecords || []).map(function (r) {
        return { groupId: r.groupId, folderId: r.folderId == null ? null : r.folderId, doneAt: typeof r.doneAt === 'string' ? r.doneAt : global.Reset.formatIso(r.doneAt) };
      });
      return update(function (d) {
        rs.forEach(function (r) { d.records.push(r); });
        gs.forEach(function (r) { d.groupRecords.push(r); });
      });
    }

    // 체크 해제용: period({start, end}) 안에 있는 기록만 지운다. 기간 밖 기록은 건드리지 않는다.
    // spec: { taskIds?: [id], groupId?: id, folderIds: [id | null], period }
    function removeRecordsInPeriod(spec) {
      var removed = 0;
      var folderIds = spec.folderIds || [];
      var taskIds = spec.taskIds || [];
      function match(folderId) { return folderIds.indexOf(folderId == null ? null : folderId) >= 0; }
      var res = update(function (d) {
        var keepRecords = d.records.filter(function (r) {
          var hit = taskIds.indexOf(r.taskId) >= 0 && match(r.folderId) && global.Reset.inPeriod(r.doneAt, spec.period);
          if (hit) removed++;
          return !hit;
        });
        var keepGroupRecords = d.groupRecords.filter(function (r) {
          var hit = spec.groupId != null && r.groupId === spec.groupId && match(r.folderId) && global.Reset.inPeriod(r.doneAt, spec.period);
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
      sync();
      if (typeof text !== 'string') return { ok: false, error: '파일 내용을 읽지 못했어요.' };
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (text.length > LIMIT.text) return { ok: false, error: '파일이 너무 커요. 약 6MB까지 가져올 수 있어요.' };
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: '올바른 JSON 파일이 아니에요.' }; }
      if (isObj(parsed) && parsed.app !== undefined && parsed.app !== APP) {
        return { ok: false, error: '이 앱에서 내보낸 파일이 아니에요.' };
      }
      var v = validateData(parsed);
      if (!v.ok) return { ok: false, error: v.error, errors: v.errors };
      var norm = normalize(parsed);
      var out = JSON.stringify(norm.data);
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
      var used = Object.create(null);
      function add(o) { if (o && typeof o.id === 'string') used[o.id] = true; }
      var d = get();
      d.games.forEach(function (g) { add(g); g.cycles.forEach(add); g.folders.forEach(add); });
      d.groups.forEach(add); d.tasks.forEach(add); d.presets.forEach(add);
      var id;
      do {
        id = (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      } while (used[id]);
      return id;
    }

    load();

    return {
      load: load, status: status, get: get, update: update,
      addRecords: addRecords, removeRecordsInPeriod: removeRecordsInPeriod,
      exportJson: exportJson, importJson: importJson,
      rawText: rawText, startFresh: startFresh, newId: newId
    };
  }

  var defaultStorage = null;
  try { defaultStorage = global.localStorage || null; } catch (e) { defaultStorage = null; }

  var api = create(defaultStorage);
  api.create = create;
  api.validateData = validateData;
  api.KEY = KEY;
  api.BROKEN_KEY = BROKEN_KEY;
  api.VERSION = VERSION;
  api.LIMIT = LIMIT;
  global.Store = api;
})(typeof window !== 'undefined' ? window : this);
