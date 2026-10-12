/*
 * 기본 프리셋 (CLAUDE.md 7장). 7장 표를 그대로 옮긴 데이터이고, 숙제를 더하거나 빼거나 이름을 바꾸지 않는다.
 * docs/tests.html이 HTTP로 열렸을 때 ../CLAUDE.md의 7장을 읽어서 이 데이터와 하나하나 비교한다.
 *
 * 모양: 표의 행 그대로다.
 *   { id, name, levels: [단계 이름…], cycles: [{ name, type, time, day?, date? }],
 *     groups: [{ name, scope: '공통' | 단계 이름, cycle: 주기 이름, required: null | 개수, tasks: [{ name, low? }] }] }
 * 숙제 이름 끝의 " (중요도 낮음)"만 이름에서 떼서 low: true로 둔다. "(레벨에 맞는 곳 1회)"처럼 이름의 일부인 괄호는 그대로 둔다.
 * 날짜·시각은 모두 한국 시간이다. 이 파일은 계산을 하지 않는다.
 */
(function (global) {
  'use strict';

  var DEFAULTS = [
    {
      id: 'builtin-maple', name: '메이플스토리',
      levels: ['계정', '캐릭터'],
      cycles: [
        { name: '일일', type: 'daily', time: '00:00' },
        { name: '주간', type: 'weekly', day: 4, time: '00:00' },
        { name: '월간', type: 'monthly', date: 1, time: '00:00' },
      ],
      groups: [
        { name: '아케인리버 일일 퀘스트', scope: '캐릭터', cycle: '일일', required: null,
          tasks: [{ name: '소멸의 여로' }, { name: '츄츄 아일랜드' }, { name: '레헬른' }, { name: '아르카나' }, { name: '모라스' }, { name: '에스페라' }] },
        { name: '그란디스 일일 퀘스트', scope: '캐릭터', cycle: '일일', required: null,
          tasks: [{ name: '세르니움' }, { name: '호텔 아르크스' }, { name: '오디움' }, { name: '도원경' }, { name: '아르테리아' }, { name: '카르시온' }, { name: '탈라하트' }, { name: '기어드락' }] },
        { name: '일일 보스', scope: '캐릭터', cycle: '일일', required: null,
          tasks: [{ name: '자쿰(노멀)' }, { name: '매그너스(노멀)' }, { name: '혼테일(카오스)' }, { name: '파풀라투스(노멀)' }, { name: '카웅' }, { name: '힐라(하드)' }, { name: '핑크빈(카오스)' }, { name: '시그너스(노멀)' }] },
        { name: '일일 콘텐츠', scope: '캐릭터', cycle: '일일', required: null,
          tasks: [{ name: '몬스터파크 7회' }] },
        { name: '계정 일일', scope: '계정', cycle: '일일', required: null,
          tasks: [{ name: '우르스 3회' }] },
        { name: '주간 보스', scope: '캐릭터', cycle: '주간', required: null,
          tasks: [{ name: '스우' }, { name: '데미안' }, { name: '루시드' }, { name: '윌' }, { name: '진 힐라' }, { name: '선택받은 세렌' }, { name: '감시자 칼로스' }, { name: '카링' }, { name: '최초의 대적자' }, { name: '림보' }, { name: '발드릭스' }, { name: '유피테르' }] },
        { name: '주간 퀘스트', scope: '캐릭터', cycle: '주간', required: null,
          tasks: [{ name: '에르다 스펙트럼' }, { name: '배고픈 무토' }, { name: '미드나잇 체이서' }, { name: '스피릿 세이비어' }, { name: '엔하임 디펜스' }, { name: '프로텍트 에스페라' }, { name: '크리티아스 주간 임무' }, { name: '헤이븐 주간 임무' }, { name: '타락한 세계수 주간 임무' }, { name: '익스트림 몬스터파커' }] },
        { name: '계정 주간', scope: '계정', cycle: '주간', required: null,
          tasks: [{ name: '유니온 주간 드래곤 퇴치' }] },
        { name: '에픽 던전', scope: '계정', cycle: '주간', required: 3,
          tasks: [{ name: '하이마운틴' }, { name: '앵글러 컴퍼니' }, { name: '악몽선경' }, { name: '아우룸 레기스' }] },
        { name: '길드 컨텐츠', scope: '캐릭터', cycle: '주간', required: null,
          tasks: [{ name: '샤레니안의 지하 수로' }, { name: '플래그 레이스' }, { name: '주간 길드 미션' }] },
        { name: '월간 보스', scope: '캐릭터', cycle: '월간', required: null,
          tasks: [{ name: '검은 마법사' }] },
      ]
    },
    {
      id: 'builtin-lostark', name: '로스트아크',
      levels: ['원정대', '캐릭터'],
      cycles: [
        { name: '일일', type: 'daily', time: '06:00' },
        { name: '주간', type: 'weekly', day: 3, time: '06:00' },
      ],
      groups: [
        { name: '일일 숙제', scope: '캐릭터', cycle: '일일', required: null,
          tasks: [{ name: '카오스 던전·쿠르잔 전선·혼돈의 균열 (레벨에 맞는 곳 1회)' }, { name: '가디언 토벌' }, { name: '에포나 의뢰 3개' }] },
        { name: '주간 레이드', scope: '캐릭터', cycle: '주간', required: 3,
          tasks: [{ name: '카제로스 서막' }, { name: '카제로스 1막' }, { name: '카제로스 2막' }, { name: '카제로스 3막' }, { name: '카제로스 4막' }, { name: '카제로스 종막' }, { name: '그림자 레이드 세르카' }, { name: '그림자 레이드 벨가르딘' }, { name: '에픽 레이드 베히모스' }, { name: '어비스 던전 지평의 성당' }] },
        { name: '주간 콘텐츠', scope: '캐릭터', cycle: '주간', required: null,
          tasks: [{ name: '할의 모래시계' }, { name: '낙원 천상 5회' }] },
        { name: '원정대 주간', scope: '원정대', cycle: '주간', required: null,
          tasks: [{ name: '이정표 주간 미션' }] },
        { name: '기간제 레이드', scope: '원정대', cycle: '주간', required: null,
          tasks: [{ name: '익스트림 레이드', low: true }] },
      ]
    },
    {
      id: 'builtin-mahjong', name: '작혼',
      levels: [],
      cycles: [
        { name: '일일', type: 'daily', time: '06:00' },
      ],
      groups: [
        { name: '일일 임무', scope: '공통', cycle: '일일', required: null,
          tasks: [{ name: '일일 임무 1개 완료' }] },
        { name: '작사 선물', scope: '공통', cycle: '일일', required: null,
          tasks: [{ name: '작사에게 선물 주기', low: true }] },
        { name: '이벤트 임무', scope: '공통', cycle: '일일', required: null,
          tasks: [{ name: '이벤트 일일 임무', low: true }] },
      ]
    }
  ];

  // 표의 행을 "내 프리셋"과 같은 모양({ id, name, game: { cycles, levels, folders, groups, tasks } })으로 바꾼다.
  // 프리셋 안에서만 쓰는 id(c1, g1, t1)를 붙인다. 게임에 넣을 때 Store.ops.addGameFromPreset이 새 id로 바꾼다.
  function build(def) {
    var cycleId = Object.create(null);
    var cycles = def.cycles.map(function (c, i) {
      var o = { id: 'c' + (i + 1), name: c.name, type: c.type };
      if (c.time !== undefined) o.time = c.time;
      if (c.day !== undefined) o.day = c.day;
      if (c.date !== undefined) o.date = c.date;
      cycleId[c.name] = o.id;
      return o;
    });
    var groups = [], tasks = [];
    def.groups.forEach(function (g, i) {
      var id = 'g' + (i + 1);
      var scope = g.scope === '공통' ? 'game' : def.levels.indexOf(g.scope) + 1;
      groups.push({ id: id, name: g.name, cycleId: cycleId[g.cycle], scope: scope, required: g.required, low: false });
      g.tasks.forEach(function (t) { tasks.push({ id: 't' + (tasks.length + 1), groupId: id, name: t.name, low: t.low === true }); });
    });
    return { id: def.id, name: def.name, game: { cycles: cycles, levels: def.levels.slice(), folders: [], groups: groups, tasks: tasks } };
  }

  var built = null;
  function all() {
    if (!built) built = DEFAULTS.map(build);
    return built;
  }

  // 프리셋 하나의 개수 요약 (기본·내 프리셋 공통)
  function summary(p) {
    var g = p.game;
    return { cycles: g.cycles.length, groups: g.groups.length, tasks: g.tasks.length, folders: g.folders.length };
  }

  // 프리셋에 담긴 폴더 구조를 들여쓰기 글로 (2칸이 한 단계). 폴더가 없으면 "".
  function folderText(p) {
    var kids = Object.create(null);
    p.game.folders.forEach(function (f) { var k = f.parentId == null ? '' : f.parentId; (kids[k] = kids[k] || []).push(f); });
    var lines = [];
    (function walk(key, depth) {
      (kids[key] || []).forEach(function (f) {
        var pad = ''; for (var i = 0; i < depth; i++) pad += '  ';
        lines.push(pad + f.name);
        walk(f.id, depth + 1);
      });
    })('', 0);
    return lines.join('\n');
  }

  global.Presets = { DEFAULTS: DEFAULTS, build: build, all: all, summary: summary, folderText: folderText };
})(typeof window !== 'undefined' ? window : this);
