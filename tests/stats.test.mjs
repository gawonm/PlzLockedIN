import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/stats.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const at = (y, m, d, h, mi = 0) => new Date(y, m, d, h, mi).getTime();

const ev = (id, sessionId, ts, extra = {}) => ({
  id, sessionId, ts, tz: null, tzOffsetMin: null, source: 'one-tap', taskType: null, thought: '', activity: null,
  trigger: null, returned: 'unknown', note: '', keepForLater: false, laterDone: false, chainLink: null, createdAt: ts, updatedAt: ts, ...extra,
});
const sess = (id, startAt, endAt, extra = {}) => ({
  id, taskType: 'class', task: '수업', location: '', nextAction: '', startAt, endAt, endReason: endAt == null ? null : 'manual',
  tz: null, tzOffsetMin: null, createdAt: startAt, updatedAt: startAt, ...extra,
});

// 사례 B: 14:10 확장 프로그램 검색, 14:18 영어 단어 검색, 14:25 복귀
function caseB() {
  return {
    schemaVersion: 2, activeSessionId: null,
    sessions: [sess('s1', at(2026, 10, 2, 14), at(2026, 10, 2, 15))],
    events: [
      ev('a', 's1', at(2026, 10, 2, 14, 10), { activity: 'search', thought: 'VS Code에서 Notion?' }),
      ev('b', 's1', at(2026, 10, 2, 14, 18), { activity: 'search', thought: '영어 단어' }),
    ],
  };
}

test('사례 B: 기록된 이벤트만, 간격 구분, 지속시간/복귀는 만들지 않음', () => {
  const d = caseB();
  const gaps = S.eventGaps(d.events);
  assert.equal(gaps.get('a'), null);
  assert.equal(gaps.get('b'), 8 * MIN);
  const r = S.buildReport(d, at(2026, 10, 3, 0));
  assert.equal(r.total, 2);
  assert.equal(r.medianGapMs, 8 * MIN);
  assert.equal(r.shortGapShare, 0); // 8분은 5분 이내 아님
  assert.ok(!('medianSpanMs' in r) && !('lostMinutesEstimate' in r), '집중 지속시간·손실 시간 추정 없음');
  assert.ok(d.events.every((e) => e.returned === 'unknown'));
  assert.equal(r.sufficiency.canInsight, false);
  assert.deepEqual(r.insights, [], '데이터 부족 시 인사이트 없음');
});

test('eventGaps: 세션 없는 기록은 같은 로컬 날짜끼리만 비교', () => {
  const g = S.eventGaps([
    ev('x', null, at(2026, 10, 2, 23, 50)),
    ev('y', null, at(2026, 10, 3, 0, 5)),
    ev('z', null, at(2026, 10, 3, 0, 15)),
  ]);
  assert.equal(g.get('y'), null, '날짜가 바뀌면 새 그룹');
  assert.equal(g.get('z'), 10 * MIN);
});

test('gapHistogram 구간', () => {
  const h = S.gapHistogram([1 * MIN, 2 * MIN, 4 * MIN, 10 * MIN, 29 * MIN, 30 * MIN, 120 * MIN]);
  assert.deepEqual(h.map((b) => b.count), [1, 2, 1, 1, 2]);
});

test('신뢰 세션: 수동 종료 + 5분~6시간만', () => {
  assert.equal(S.isReliableSession(sess('a', 0, 60 * MIN)), true);
  assert.equal(S.isReliableSession(sess('b', 0, 3 * MIN)), false);
  assert.equal(S.isReliableSession(sess('c', 0, 7 * HOUR)), false);
  assert.equal(S.isReliableSession(sess('d', 0, null)), false);
  assert.equal(S.isReliableSession(sess('e', 0, 60 * MIN, { endReason: 'stale-closed' })), false);
});

test('시간당 비율은 신뢰 세션 노출 60분 이상일 때만', () => {
  const d = caseB();
  const r = S.buildReport(d);
  assert.equal(r.ratePerHour, 2);
  assert.equal(r.hours[14].rate, 2);
  assert.equal(r.hours[13].rate, null);
  // stale 세션이면 비율 계산 제외 (횟수는 유지)
  d.sessions[0].endReason = 'stale-closed';
  const r2 = S.buildReport(d);
  assert.equal(r2.ratePerHour, null);
  assert.equal(r2.hours[14].count, 2);
  assert.equal(r2.hours[14].rate, null);
});

test('countLevel: 좋음/나쁨이 아닌 기록 수 단계', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 20].map(S.countLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
});

test('monthHourMatrix: 월 경계 (1월 31일 23:59 vs 2월 1일 00:00)', () => {
  const evs = [ev('a', null, at(2026, 0, 31, 23, 59)), ev('b', null, at(2026, 1, 1, 0, 0))];
  const jan = S.monthHourMatrix(evs, 2026, 0);
  const feb = S.monthHourMatrix(evs, 2026, 1);
  assert.equal(jan.length, 31);
  assert.equal(feb.length, 28);
  assert.equal(jan[30][23], 1);
  assert.equal(feb[0][0], 1);
  assert.equal(jan.flat().reduce((x, y) => x + y), 1);
});

test('focusMsByDay: 자정을 넘는 세션 분배', () => {
  const r = S.focusMsByDay([sess('x', at(2026, 0, 1, 23), at(2026, 0, 2, 1))]);
  assert.equal(r['2026-01-01'], HOUR);
  assert.equal(r['2026-01-02'], HOUR);
});

test('DST 경계에서도 노출 시간 합이 실제 경과 시간과 같고 무한루프 없음', () => {
  // 미국 DST: 2026-03-08 (spring forward), 2026-11-01 (fall back). 다른 TZ에서는 일반 날짜로 동작.
  for (const [s, e] of [[at(2026, 2, 8, 0), at(2026, 2, 8, 5)], [at(2026, 10, 1, 0), at(2026, 10, 1, 4)]]) {
    const exp = S.hourlyExposure([sess('x', s, e)]);
    assert.equal(exp.reduce((a, b) => a + b, 0), e - s);
    const byDay = S.focusMsByDay([sess('x', s, e)]);
    assert.equal(Object.values(byDay).reduce((a, b) => a + b, 0), e - s);
  }
});

test('weeklyTrend: 월요일 시작 주, 8주', () => {
  const w = S.weeklyTrend(caseB(), at(2026, 10, 4, 12), 8);
  assert.equal(w.length, 8);
  assert.equal(new Date(w[7].weekStart).getDay(), 1);
  assert.equal(w[7].count, 2);
  assert.equal(w[7].rate, 2);
});

test('sufficiency 단계', () => {
  assert.equal(S.sufficiency({ sessions: [], events: [] }).level, 'none');
  assert.equal(S.sufficiency(caseB()).level, 'early');
  const demo = S.generateDemoData(at(2026, 10, 2, 12), 28);
  assert.ok(['some', 'enough'].includes(S.sufficiency(demo).level));
});

test('insights: 모든 항목이 사실 → 한계 → 시도 형식이고 진단/치료/인과 단정 표현 없음', () => {
  const demo = S.generateDemoData(at(2026, 10, 2, 12), 28);
  const r = S.buildReport(demo, at(2026, 10, 2, 12));
  assert.ok(r.insights.length >= 2, `인사이트 ${r.insights.length}개`);
  for (const i of r.insights) {
    assert.ok(i.fact && i.limit && i.try, i.id);
    assert.doesNotMatch(i.fact + i.limit + i.try, /치료|진단|효과가 있|때문입니다|집중했/);
  }
});

test('insights: 짧은 간격 연속 기록은 "가능성"으로만', () => {
  const s = sess('s', at(2026, 10, 2, 9), at(2026, 10, 2, 11));
  const events = [];
  for (let i = 0; i < 16; i++) events.push(ev(`e${i}`, 's', at(2026, 10, 2, 9, 3 + i * 3)));
  // 3일 조건 충족용
  events.push(ev('d1', null, at(2026, 10, 3, 9)), ev('d2', null, at(2026, 10, 4, 9)));
  const r = S.buildReport({ sessions: [s], events });
  const i = r.insights.find((x) => x.id === 'short-gaps');
  assert.ok(i);
  assert.match(i.limit, /알 수 없어요/);
});

test('generateDemoData: 결정적(seed 고정), v2 형식', () => {
  const now = at(2026, 10, 2, 12);
  const a = S.generateDemoData(now);
  assert.deepEqual(a, S.generateDemoData(now));
  assert.equal(a.schemaVersion, 2);
});

test('pickInsight: 하나만, 실천 가능한 것 우선, 근거 부족하면 null', () => {
  assert.equal(S.pickInsight(S.buildReport(caseB())), null);
  const demo = S.generateDemoData(at(2026, 10, 2, 12), 28);
  const r = S.buildReport(demo, at(2026, 10, 2, 12));
  const one = S.pickInsight(r);
  assert.ok(one);
  const order = ['top-activity', 'top-trigger', 'short-gaps', 'next-action', 'hour-rate', 'task-type', 'hour-count'];
  const best = Math.min(...r.insights.map((i) => order.indexOf(i.id)));
  assert.equal(one.id, order[best]);
});

test('모든 인사이트에 다음 세션용 실험(id·짧은 문구)이 있음', () => {
  const demo = S.generateDemoData(at(2026, 10, 2, 12), 28);
  for (const i of S.buildReport(demo, at(2026, 10, 2, 12)).insights) {
    assert.ok(i.experiment && i.experiment.id && i.experiment.text, i.id);
    assert.ok(i.experiment.text.length <= 40, `${i.id}: ${i.experiment.text}`);
  }
});

test('top-activity 사실은 실제 횟수로 표현하고 원인 단정 없음', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push(ev(`e${i}`, null, at(2026, 10, 1 + (i % 4), 10, i), { activity: i < 6 ? 'search' : 'messenger' }));
  for (let i = 10; i < 16; i++) events.push(ev(`e${i}`, null, at(2026, 10, 2, 15, i)));
  const r = S.buildReport({ sessions: [], events });
  const i = r.insights.find((x) => x.id === 'top-activity');
  assert.ok(i);
  assert.match(i.fact, /"검색"\(이\)라고 남긴 기록이 6번/);
  assert.match(i.limit, /원인을 알 수는 없/);
  assert.equal(i.experiment.id, 'top-activity:search');
});

test('recentDays: 기록 없는 날도 포함(0), 월 경계', () => {
  const evs = [ev('a', null, at(2026, 10, 1, 9)), ev('b', null, at(2026, 10, 1, 10)), ev('c', null, at(2026, 9, 31, 9))];
  const d = S.recentDays(evs, at(2026, 10, 2, 12), 7);
  assert.equal(d.length, 7);
  assert.deepEqual(d.slice(-3).map((x) => [x.month, x.day, x.count]), [[10, 31, 1], [11, 1, 2], [11, 2, 0]]);
});
