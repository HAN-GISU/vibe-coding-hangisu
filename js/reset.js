/*
 * 리셋 주기 계산, 완료 판정, 남은 기간, 화면 갱신 시점, 현재 시각(now).
 * 판정과 계산의 단일 기준(SoT)이다. 화면 코드는 이 파일의 함수를 호출만 한다. (CLAUDE.md 2-2, 3장)
 *
 * - 전역 객체 Reset 하나에 담는다. ES 모듈을 쓰지 않는다.
 * - now()와 nowInfo(), nowQuery()를 뺀 모든 함수는 시각을 인자(at)로 받는 순수 함수다.
 * - 받은 객체(주기, 기록, 폴더 등)는 바꾸지 않는다.
 * - 시각 문자열(doneAt, anchor, createdAt)은 시간대 표기가 없으면 브라우저 로컬(한국) 시간으로 읽는다.
 */
(function (global) {
  'use strict';

  var MINUTE = 60000;
  var HOUR = 3600000;
  var DAY = 86400000;
  var MAX_PERIODS = 1000; // listPeriods가 돌려주는 기간 수의 상한 (분 단위 주기에서 끝없이 늘어나는 것을 막는다)

  var MAX_EVERY_MS = 36500 * DAY; // 간격 주기의 상한 (100년). 이보다 크면 Date 범위를 벗어날 수 있다.

  var LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
  var ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):?(\d{2}))$/;
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  /* ---------- 시각 읽기·쓰기 ---------- */

  function pad(n, len) {
    var s = String(n);
    while (s.length < (len || 2)) s = '0' + s;
    return s;
  }

  // 날짜·시각 성분이 실제로 있는 값인지 (2월 30일, 25시 등을 거른다)
  function validParts(y, mo, d, h, mi, s) {
    if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
    return d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }

  // 시각 문자열(또는 Date)을 Date로 읽는다. 읽을 수 없거나 없는 날짜(2월 30일 등)면 null.
  // 시간대 표기(Z, +09:00)가 없으면 로컬 시각으로 읽는다.
  function parseTime(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(v.getTime());
    if (typeof v !== 'string') return null;
    var m = LOCAL_RE.exec(v);
    if (m) {
      if (!validParts(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)) return null;
      var ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, ms);
    }
    m = ZONED_RE.exec(v);
    if (m) {
      if (!validParts(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)) return null;
      if (m[8] !== undefined && (+m[8] > 23 || +m[9] > 59)) return null;
      var z = new Date(v);
      return isNaN(z.getTime()) ? null : z;
    }
    return null;
  }

  // Date를 로컬 시간 ISO 문자열로 쓴다. 예: "2026-10-15T05:00:00" (밀리초가 있으면 ".250"을 붙인다)
  function formatIso(d) {
    var s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    if (d.getMilliseconds()) s += '.' + pad(d.getMilliseconds(), 3);
    return s;
  }

  /* ---------- now() 와 ?now= ---------- */

  // "?now=2026-10-15T05:59" 형식의 주소 문자열에서 시작 시각을 읽는다. 없거나 잘못되면 null.
  function parseNowParam(search) {
    var raw = new URLSearchParams(search || '').get('now');
    if (raw === null || !LOCAL_RE.test(raw)) return null;
    return parseTime(raw);
  }

  // 시작 시각(start)이 실제 시각 realStartMs에 해당할 때, 실제 시각 realMs의 가상 시각을 돌려주는 함수를 만든다.
  function makeClock(start, realStartMs) {
    var startMs = start.getTime();
    return function (realMs) { return new Date(startMs + (realMs - realStartMs)); };
  }

  // 주소 문자열(search)과 페이지가 열린 실제 시각(realStartMs)으로 현재 시각의 원천을 만든다.
  // at(realMs): 실제 시각 realMs의 현재 시각. ?now=가 있으면 그 시각에서 시작해 실제처럼 흐른다.
  // query(realMs): 화면 이동 링크에 붙일 "?now=…"(테스트 시각일 때) 또는 "".
  function makeNowSource(search, realStartMs) {
    var start = parseNowParam(search);
    var clock = start ? makeClock(start, realStartMs) : null;
    var hasParam = new URLSearchParams(search || '').has('now');
    function at(realMs) { return clock ? clock(realMs) : new Date(realMs); }
    return {
      isTest: !!start,
      startedAt: start,
      error: hasParam && !start ? '?now= 값을 읽지 못해 현재 시각을 씁니다. 예: ?now=2026-10-15T05:59' : null,
      at: at,
      query: function (realMs) { return start ? '?now=' + formatIso(at(realMs)) : ''; }
    };
  }

  var source = makeNowSource((global.location && global.location.search) || '', Date.now());

  // 현재 시각. 현재 시각은 반드시 이 함수로만 얻는다.
  function now() { return source.at(Date.now()); }

  function nowInfo() {
    return {
      date: now(),
      isTest: source.isTest,
      startedAt: source.startedAt ? new Date(source.startedAt.getTime()) : null,
      error: source.error
    };
  }

  // 화면을 옮길 때 주소에 붙일 문자열. 테스트 시각이면 그 순간의 가상 시각("?now=…"), 아니면 "".
  function nowQuery() { return source.query(Date.now()); }

  /* ---------- 리셋 주기 ---------- */

  function isInt(x) { return typeof x === 'number' && x % 1 === 0; }

  function everyMs(e) {
    return (((e.days || 0) * 24 + (e.hours || 0)) * 60 + (e.minutes || 0)) * MINUTE;
  }

  // 주기 값이 올바른지 검사한다. 가져오기 검증(store.js)과 설정 화면이 쓴다.
  function validateCycle(c) {
    function bad(error) { return { ok: false, error: error }; }
    if (!c || typeof c !== 'object') return bad('리셋 주기가 올바르지 않아요.');
    if (['daily', 'weekly', 'monthly', 'interval', 'once'].indexOf(c.type) < 0) {
      return bad('리셋 주기 종류는 매일, 매주, 매월, 간격, 1회 중 하나여야 해요.');
    }
    if (c.type === 'daily' || c.type === 'weekly' || c.type === 'monthly') {
      if (typeof c.time !== 'string' || !TIME_RE.test(c.time)) return bad('시각은 05:00처럼 00:00~23:59로 적어 주세요.');
    }
    if (c.type === 'weekly' && !(isInt(c.day) && c.day >= 0 && c.day <= 6)) {
      return bad('요일은 0(일)~6(토) 중 하나여야 해요.');
    }
    if (c.type === 'monthly' && !(isInt(c.date) && c.date >= 1 && c.date <= 28)) {
      return bad('날짜는 모든 달에 있는 1~28일만 고를 수 있어요.');
    }
    if (c.type === 'interval') {
      if (!parseTime(c.anchor)) return bad('기준 시각을 읽을 수 없어요. 예: 2026-10-01T05:00');
      var e = c.every;
      if (!e || typeof e !== 'object') return bad('간격을 적어 주세요.');
      var keys = ['days', 'hours', 'minutes'];
      for (var i = 0; i < keys.length; i++) {
        var v = e[keys[i]];
        if (v !== undefined && !(isInt(v) && v >= 0)) return bad('간격의 일·시간·분은 0 이상의 정수여야 해요.');
      }
      var total = everyMs(e);
      if (!(total >= MINUTE)) return bad('간격은 1분 이상이어야 해요.');
      if (!(total <= MAX_EVERY_MS)) return bad('간격은 100년 이하여야 해요.');
    }
    if (c.carry !== undefined) {
      var carryBad = '주기 변경 기록(carry)이 올바르지 않아요.';
      var s = c.carry && parseTime(c.carry.since);
      if (!s) return bad(carryBad);
      if (c.type === 'once') {
        if (c.carry.until !== undefined) return bad(carryBad); // 1회는 끝나지 않으므로 until이 없다
      } else {
        var u = parseTime(c.carry.until);
        if (!u || s.getTime() >= u.getTime()) return bad(carryBad);
      }
    }
    return { ok: true };
  }

  function hm(time) {
    var p = time.split(':');
    return [+p[0], +p[1]];
  }

  // carry를 무시한, 주기 자체의 가장 최근 리셋 시각 (at 이하). 1회는 null.
  function plainLast(c, at) {
    var y = at.getFullYear(), mo = at.getMonth(), d = at.getDate(), cand, t;
    switch (c.type) {
      case 'daily':
        t = hm(c.time);
        cand = new Date(y, mo, d, t[0], t[1]);
        return cand > at ? new Date(y, mo, d - 1, t[0], t[1]) : cand;
      case 'weekly':
        t = hm(c.time);
        var back = (at.getDay() - c.day + 7) % 7;
        cand = new Date(y, mo, d - back, t[0], t[1]);
        return cand > at ? new Date(y, mo, d - back - 7, t[0], t[1]) : cand;
      case 'monthly':
        t = hm(c.time);
        cand = new Date(y, mo, c.date, t[0], t[1]);
        return cand > at ? new Date(y, mo - 1, c.date, t[0], t[1]) : cand;
      case 'interval':
        var anchor = parseTime(c.anchor).getTime();
        var every = everyMs(c.every);
        return new Date(anchor + Math.floor((at.getTime() - anchor) / every) * every);
      case 'once':
        return null;
      default:
        throw new Error('알 수 없는 리셋 주기 종류: ' + c.type);
    }
  }

  // carry를 무시한, 주기 자체의 다음 리셋 시각 (at 초과). 1회는 null.
  function plainNext(c, at) {
    var last = plainLast(c, at);
    if (!last) return null;
    var y = last.getFullYear(), mo = last.getMonth(), d = last.getDate(), t;
    switch (c.type) {
      case 'daily':
        t = hm(c.time);
        return new Date(y, mo, d + 1, t[0], t[1]);
      case 'weekly':
        t = hm(c.time);
        return new Date(y, mo, d + 7, t[0], t[1]);
      case 'monthly':
        t = hm(c.time);
        return new Date(y, mo + 1, c.date, t[0], t[1]);
      default: // interval
        return new Date(last.getTime() + everyMs(c.every));
    }
  }

  // 주기를 바꾼 직후라면 carry의 since를 기간 시작으로 쓴다. 아니면 null.
  // 1회 주기의 carry는 until이 없고, since 이후 계속 적용된다.
  function activeCarry(c, at) {
    if (!c.carry) return null;
    var s = parseTime(c.carry.since);
    if (!s || at < s) return null;
    if (c.type === 'once') return s;
    var u = parseTime(c.carry.until);
    return u && at < u ? s : null;
  }

  // at 이하의 가장 최근 리셋 시각. 1회는 null.
  function lastReset(c, at) {
    return activeCarry(c, at) || plainLast(c, at);
  }

  // at 초과의 첫 리셋 시각. 1회는 null.
  function nextReset(c, at) {
    return plainNext(c, at);
  }

  // 지금 기간 {start, end}. 1회는 둘 다 null.
  function currentPeriod(c, at) {
    return { start: lastReset(c, at), end: nextReset(c, at) };
  }

  // 숙제를 만든 시각(since)이 속한 기간부터 지금 기간까지, 최신순.
  // 돌려주는 값: { periods: [{start, end, isCurrent}], truncated }
  //   since가 at보다 뒤이면(?now=로 과거를 볼 때) periods는 빈 배열이다.
  //   주기 자체의 경계로만 나눈다(carry는 쓰지 않는다). 최대 MAX_PERIODS개이고, 더 오래된 기간이 있어서
  //   잘렸으면 truncated가 true다 (화면에서 "이전 기간 생략"을 알릴 때 쓴다).
  function listPeriods(c, since, at) {
    var from = parseTime(since);
    if (from && from.getTime() > at.getTime()) return { periods: [], truncated: false };
    if (c.type === 'once') return { periods: [{ start: null, end: null, isCurrent: true }], truncated: false };
    var list = [];
    var truncated = false;
    var start = plainLast(c, at);
    var end = plainNext(c, at);
    list.push({ start: start, end: end, isCurrent: true });
    while (from && start.getTime() > from.getTime()) {
      if (list.length >= MAX_PERIODS) { truncated = true; break; }
      end = start;
      start = plainLast(c, new Date(start.getTime() - 1));
      list.push({ start: start, end: end, isCurrent: false });
    }
    return { periods: list, truncated: truncated };
  }

  // 주기를 바꿀 때 새 주기에 carry를 붙여 돌려준다 (3장 "리셋 주기").
  // at은 바꾼 시각. 이미 한 체크가 사라지거나 되살아나지 않게 한다.
  //   새 주기가 반복이면 { since, until }: 바꾸기 직전의 최근 리셋부터 새 주기의 다음 리셋까지 since를 기간 시작으로 본다.
  //   새 주기가 1회이면 { since }: 바꾸기 직전 기간의 시작 이후 기록만 완료로 인정한다 (until이 없다).
  function changeCycle(oldCycle, newCycle, at) {
    var next = {};
    Object.keys(newCycle).forEach(function (k) { if (k !== 'carry') next[k] = newCycle[k]; });
    var oldLast = lastReset(oldCycle, at);
    if (next.type === 'once') {
      if (oldLast) next.carry = { since: formatIso(oldLast) };
      return next;
    }
    var since = oldLast || new Date(0);
    var until = plainNext(next, at);
    next.carry = { since: formatIso(since), until: formatIso(until) };
    return next;
  }

  /* ---------- 폴더 ---------- */

  // 폴더(또는 그 위 폴더)가 itemId(숙제 또는 묶음 id)를 끈 상태인지. 게임 공통(folderId가 null)은 항상 false.
  function isOff(folders, folderId, itemId) {
    var byId = {};
    folders.forEach(function (f) { byId[f.id] = f; });
    var seen = Object.create(null); // 이미 지나간 폴더. 부모가 서로를 가리키는 순환에서 멈춘다.
    var id = folderId;
    while (id != null && byId[id] && !seen[id]) {
      seen[id] = true;
      var f = byId[id];
      if (f.off && f.off.indexOf(itemId) >= 0) return true;
      id = f.parentId;
    }
    return false;
  }

  // 묶음이 적용되는 폴더들. 범위가 단계 번호이면 그 단계의 폴더 전부이고, 게임 공통이면 [].
  function foldersForGroup(group, folders) {
    if (typeof group.scope !== 'number') return [];
    return folders.filter(function (f) { return f.level === group.scope; });
  }

  /* ---------- 완료 판정 ---------- */

  function sameFolder(a, b) { return (a == null ? null : a) === (b == null ? null : b); }

  // doneAt이 기간 안인지. 기간이 없으면(1회) 시각과 상관없이 true. 끝은 포함하지 않는다.
  function inPeriod(doneAt, period) {
    var t = parseTime(doneAt);
    if (!t) return false;
    if (!period.start) return true;
    return t >= period.start && (!period.end || t < period.end);
  }

  // 기간 안에서 가장 늦은 doneAt (Date). 없으면 null.
  function latestIn(list, match, period) {
    var best = null;
    list.forEach(function (r) {
      if (!match(r) || !inPeriod(r.doneAt, period)) return;
      var t = parseTime(r.doneAt);
      if (!best || t > best) best = t;
    });
    return best;
  }

  // 숙제가 이번 기간에 완료인지. 폴더(캐릭터)마다 따로 본다.
  function isTaskDone(args) {
    var period = currentPeriod(args.cycle, args.at);
    return latestIn(args.records, function (r) {
      return r.taskId === args.taskId && sameFolder(r.folderId, args.folderId);
    }, period) !== null;
  }

  // 묶음의 완료 상태를 한 폴더(또는 게임 공통) 기준으로 계산한다.
  // args: { group, cycle, tasks, folders, folderId, records, groupRecords, at, period? }
  // period를 주면 그 기간으로 계산한다(지난 기간 기록용). 안 주면 at의 지금 기간이다.
  // 돌려주는 값: { off, empty, done, byGroupRecord, doneCount, need, total, tasks: [{taskId, state, doneAt}] }
  //   state: 'done' | 'todo' | 'skipped'(묶음이 완료돼 할 필요 없음) | 'off'(이 폴더가 끔)
  function evaluateGroup(args) {
    var group = args.group;
    var folderId = args.folderId == null ? null : args.folderId;
    var folders = args.folders || [];
    var records = args.records || [];
    var groupRecords = args.groupRecords || [];
    var period = args.period || currentPeriod(args.cycle, args.at);

    var empty = { off: false, empty: true, done: false, byGroupRecord: false, doneCount: 0, need: 0, total: 0, tasks: [] };

    if (folderId !== null && isOff(folders, folderId, group.id)) {
      empty.off = true;
      return empty;
    }

    // 이 기간이 끝나기 전에 만든 숙제만 센다.
    var groupTasks = args.tasks.filter(function (t) {
      if (t.groupId !== group.id) return false;
      var created = parseTime(t.createdAt);
      return !created || !period.end || created < period.end;
    });

    var total = 0;
    var doneCount = 0;
    var states = groupTasks.map(function (t) {
      if (folderId !== null && isOff(folders, folderId, t.id)) {
        return { taskId: t.id, state: 'off', doneAt: null };
      }
      total++;
      var doneAt = latestIn(records, function (r) {
        return r.taskId === t.id && sameFolder(r.folderId, folderId);
      }, period);
      if (doneAt) doneCount++;
      return { taskId: t.id, state: doneAt ? 'done' : 'todo', doneAt: doneAt };
    });

    var byGroupRecord = latestIn(groupRecords, function (r) {
      return r.groupId === group.id && sameFolder(r.folderId, folderId);
    }, period) !== null;

    if (total === 0) {
      // 묶음 완료 기록은 숙제 수와 상관없이 완료다 (숙제를 전부 끈 뒤에도 이번 기간 기록이 남아 있을 수 있다).
      if (byGroupRecord) {
        return { off: false, empty: false, done: true, byGroupRecord: true, doneCount: 0, need: 0, total: 0, tasks: states };
      }
      empty.tasks = states;
      return empty;
    }

    var required = group.required;
    var need = isInt(required) && required >= 1 ? Math.min(required, total) : total;
    var done = byGroupRecord || doneCount >= need;

    states.forEach(function (s) { if (s.state === 'todo' && done) s.state = 'skipped'; });

    return { off: false, empty: false, done: done, byGroupRecord: byGroupRecord,
      doneCount: doneCount, need: need, total: total, tasks: states };
  }

  // 지난 기간(period) 하나에서 숙제 하나의 결과.
  // args: evaluateGroup과 같은 값 + task, period. cycle·at은 필요 없다.
  // status: 'done'(함) | 'missed'(안함) | 'missed-group-met'(안함, 묶음 달성) | 'group-checked'(묶음 체크로 완료)
  //         | 'off'(그 폴더가 끈 숙제) | 'none'(그 기간에는 아직 없던 숙제)
  function periodStatus(args) {
    var ev = evaluateGroup(args);
    if (ev.off) return { status: 'off', doneAt: null };
    var s = null;
    ev.tasks.forEach(function (x) { if (x.taskId === args.task.id) s = x; });
    if (!s) return { status: 'none', doneAt: null };
    if (s.state === 'off') return { status: 'off', doneAt: null };
    if (s.state === 'done') return { status: 'done', doneAt: s.doneAt };
    if (ev.byGroupRecord) return { status: 'group-checked', doneAt: null };
    return { status: ev.done ? 'missed-group-met' : 'missed', doneAt: null };
  }

  /* ---------- 남은 기간 ---------- */

  // 다음 리셋까지 남은 시간(ms). 1회는 null.
  function remainingMs(c, at) {
    var next = nextReset(c, at);
    return next ? next.getTime() - at.getTime() : null;
  }

  // 남은 시간을 표시 형식으로. 24시간 단위로 내린 값 N이 2 이상이면 D-N, 아니면 시간·분·초.
  // 돌려주는 값: { kind, n, label, detail, text }
  //   예: { kind:'dday', n:2, label:'D-2', detail:'2일 20시간', text:'D-2 · 2일 20시간' }
  //       { kind:'hours', label:'35시간 10분', ... }, { kind:'minutes', label:'42분', ... }, { kind:'seconds', label:'42초', ... }
  function formatRemaining(ms) {
    var days = Math.floor(ms / DAY);
    var hours = Math.floor(ms / HOUR);
    var minutes = Math.floor(ms / MINUTE);
    var seconds = Math.floor(ms / 1000);
    var text;
    if (days >= 2) {
      var h = hours - days * 24;
      var detail = days + '일' + (h > 0 ? ' ' + h + '시간' : '');
      return { kind: 'dday', n: days, label: 'D-' + days, detail: detail, text: 'D-' + days + ' · ' + detail };
    }
    if (hours >= 1) {
      var m = minutes - hours * 60;
      text = hours + '시간' + (m > 0 ? ' ' + m + '분' : '');
      return { kind: 'hours', n: hours, label: text, detail: text, text: text };
    }
    if (minutes >= 1) {
      text = minutes + '분';
      return { kind: 'minutes', n: minutes, label: text, detail: text, text: text };
    }
    text = seconds + '초';
    return { kind: 'seconds', n: seconds, label: text, detail: text, text: text };
  }

  // 완료한 숙제에 붙이는 "리셋까지 3일" 형식. 2일 이상은 일, 그 아래는 시간, 분, 초.
  function formatUntilReset(ms) {
    var days = Math.floor(ms / DAY);
    var hours = Math.floor(ms / HOUR);
    var minutes = Math.floor(ms / MINUTE);
    if (days >= 2) return '리셋까지 ' + days + '일';
    if (hours >= 1) return '리셋까지 ' + hours + '시간';
    if (minutes >= 1) return '리셋까지 ' + minutes + '분';
    return '리셋까지 ' + Math.floor(ms / 1000) + '초';
  }

  // 사이드바에서 같은 묶음으로 보는 단위. 48시간 이상은 같은 D-값, 1시간 이상은 같은 시간,
  // 1분 이상은 같은 분, 그 아래는 같은 초. 모두 내림이다. sortMs가 작을수록 급하다.
  function bucketOf(ms) {
    var days = Math.floor(ms / DAY);
    var hours = Math.floor(ms / HOUR);
    var minutes = Math.floor(ms / MINUTE);
    var seconds = Math.floor(ms / 1000);
    if (days >= 2) return { key: 'D' + days, label: 'D-' + days, sortMs: days * DAY };
    if (hours >= 1) return { key: 'H' + hours, label: hours + '시간', sortMs: hours * HOUR };
    if (minutes >= 1) return { key: 'M' + minutes, label: minutes + '분', sortMs: minutes * MINUTE };
    return { key: 'S' + seconds, label: seconds + '초', sortMs: seconds * 1000 };
  }

  // 주기 하나의 남은 기간을 한 번에. 1회는 "기한 없음".
  function describeRemaining(c, at) {
    var ms = remainingMs(c, at);
    if (ms === null) {
      return { ms: null, kind: 'none', label: '기한 없음', detail: '기한 없음', text: '기한 없음',
        untilText: '기한 없음', bucket: { key: 'none', label: '기한 없음', sortMs: Infinity }, changeInMs: Infinity };
    }
    var f = formatRemaining(ms);
    return { ms: ms, kind: f.kind, label: f.label, detail: f.detail, text: f.text,
      untilText: formatUntilReset(ms), bucket: bucketOf(ms), changeInMs: msUntilTextChange(ms) };
  }

  /* ---------- 화면 갱신 시점 ---------- */

  // 남은 시간이 ms일 때, 화면의 글자가 다음에 바뀌기까지 걸리는 시간(ms).
  // 1분 미만이면 초가, 2일 미만이면 분이, 그 이상이면 시간이 바뀌는 순간이다. 리셋 시각(ms 뒤)을 넘지 않는다.
  function msUntilTextChange(ms) {
    if (ms === null || ms === undefined) return Infinity;
    if (ms <= 0) return 0;
    var unit = ms < MINUTE ? 1000 : (ms < 2 * DAY ? MINUTE : HOUR);
    return Math.min(ms % unit + 1, ms);
  }

  // 화면에 보이는 남은 시간 목록(ms, 1회는 null)에서, 다음에 다시 그릴 때까지 기다릴 시간(ms).
  // 가장 빨리 바뀌는 글자에 맞추되, 길어도 60초다 (3장 "화면 갱신").
  function redrawDelay(list) {
    var delay = MINUTE;
    list.forEach(function (ms) {
      var d = msUntilTextChange(ms);
      if (d < delay) delay = d;
    });
    return Math.max(1, delay);
  }

  global.Reset = {
    parseTime: parseTime,
    formatIso: formatIso,
    parseNowParam: parseNowParam,
    makeClock: makeClock,
    makeNowSource: makeNowSource,
    now: now,
    nowInfo: nowInfo,
    nowQuery: nowQuery,
    validateCycle: validateCycle,
    lastReset: lastReset,
    nextReset: nextReset,
    currentPeriod: currentPeriod,
    listPeriods: listPeriods,
    changeCycle: changeCycle,
    isOff: isOff,
    foldersForGroup: foldersForGroup,
    isTaskDone: isTaskDone,
    evaluateGroup: evaluateGroup,
    periodStatus: periodStatus,
    remainingMs: remainingMs,
    formatRemaining: formatRemaining,
    formatUntilReset: formatUntilReset,
    bucketOf: bucketOf,
    describeRemaining: describeRemaining,
    msUntilTextChange: msUntilTextChange,
    redrawDelay: redrawDelay
  };
})(typeof window !== 'undefined' ? window : this);
