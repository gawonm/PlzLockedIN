/*
 * stats.js — 순수 함수 통계 모듈 (DOM 의존성 없음 → Node 테스트 가능)
 *
 * 용어
 *  - park   : 🅿️ 주차. 딴생각이 떠올랐지만 따라가지 않고 적어 둠 (딴짓 '예방')
 *  - return : ↩️ 아차. 이미 딴짓을 다녀온 뒤 알아차림 (딴짓 '발생')
 *  - "흔들림" = park + return (주의가 끊긴 모든 순간)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FocusStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const CATEGORIES = [
    { id: 'curious', emoji: '🔍', label: '궁금증·검색' },
    { id: 'social', emoji: '💬', label: '메신저·SNS' },
    { id: 'todo', emoji: '📝', label: '할 일 떠오름' },
    { id: 'mind', emoji: '💭', label: '잡생각' },
    { id: 'tool', emoji: '🔧', label: '도구·세팅' },
    { id: 'body', emoji: '🥱', label: '피로·몸' },
    { id: 'etc', emoji: '•', label: '기타' },
  ];
  const DURATIONS = [
    { id: 'm1', label: '~1분', minutes: 1 },
    { id: 'm5', label: '~5분', minutes: 5 },
    { id: 'm15', label: '~15분', minutes: 15 },
    { id: 'm30', label: '30분+', minutes: 30 },
  ];
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const REPORT_MIN_EVENTS = 20;
  const REPORT_MIN_DAYS = 3;

  function categoryOf(id) {
    return CATEGORIES.find((c) => c.id === id) || null;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 로컬 시간 기준 YYYY-MM-DD */
  function dateKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function sessionDurationMs(session, now) {
    const end = session.endAt != null ? session.endAt : now != null ? now : Date.now();
    return Math.max(0, end - session.startAt);
  }

  function eventsBySession(events) {
    const map = new Map();
    for (const e of events) {
      if (!e.sessionId) continue;
      if (!map.has(e.sessionId)) map.set(e.sessionId, []);
      map.get(e.sessionId).push(e);
    }
    for (const list of map.values()) list.sort((a, b) => a.ts - b.ts);
    return map;
  }

  /**
   * 집중 구간 길이(ms) 목록.
   * 세션 시작 → 첫 흔들림, 흔들림 → 다음 흔들림 간격.
   * (마지막 흔들림 → 세션 종료 구간은 '끊기지 않고 끝난' 구간이라 중도절단(censored) 데이터이므로 제외)
   */
  function focusSpans(data) {
    const byS = eventsBySession(data.events);
    const spans = [];
    for (const s of data.sessions) {
      const evs = byS.get(s.id) || [];
      let prev = s.startAt;
      for (const e of evs) {
        if (e.ts >= prev) spans.push(e.ts - prev);
        prev = e.ts;
      }
    }
    return spans;
  }

  /** 세션 시작 후 첫 흔들림까지 걸린 시간(ms) 목록 */
  function firstDriftTimes(data) {
    const byS = eventsBySession(data.events);
    const out = [];
    for (const s of data.sessions) {
      const evs = byS.get(s.id);
      if (evs && evs.length) out.push(evs[0].ts - s.startAt);
    }
    return out;
  }

  /** 특정 연/월(month: 0~11)의 day(1~31) × hour(0~23) 흔들림 횟수 행렬 */
  function monthHourMatrix(events, year, month) {
    const days = new Date(year, month + 1, 0).getDate();
    const matrix = Array.from({ length: days }, () => new Array(24).fill(0));
    for (const e of events) {
      const d = new Date(e.ts);
      if (d.getFullYear() !== year || d.getMonth() !== month) continue;
      matrix[d.getDate() - 1][d.getHours()] += 1;
    }
    return matrix;
  }

  /** 세션 시간을 날짜별로 분배(자정을 넘는 세션 대비) → { 'YYYY-MM-DD': ms } */
  function focusMsByDay(sessions, now) {
    const out = {};
    for (const s of sessions) {
      let t = s.startAt;
      const end = s.startAt + sessionDurationMs(s, now);
      while (t < end) {
        const d = new Date(t);
        const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const chunkEnd = Math.min(end, nextMidnight);
        const k = dateKey(t);
        out[k] = (out[k] || 0) + (chunkEnd - t);
        t = chunkEnd;
      }
    }
    return out;
  }

  /**
   * 날짜별 요약 + 1~5 레벨 (1 = 매우 집중, 5 = 많이 흔들림)
   * 레벨 기준: 세션 1시간당 흔들림 횟수. 세션 기록이 없는 날은 흔들림 횟수 기준.
   */
  function dailySummary(data, now) {
    const focusMs = focusMsByDay(data.sessions, now);
    const days = {};
    const touch = (k) => (days[k] = days[k] || { key: k, count: 0, park: 0, ret: 0, focusMs: 0 });
    for (const [k, ms] of Object.entries(focusMs)) touch(k).focusMs = ms;
    for (const e of data.events) {
      const d = touch(dateKey(e.ts));
      d.count += 1;
      if (e.type === 'park') d.park += 1;
      else d.ret += 1;
    }
    for (const d of Object.values(days)) {
      d.rate = d.focusMs >= 10 * MIN ? d.count / (d.focusMs / HOUR) : null;
      d.level = levelFor(d);
    }
    return days;
  }

  function levelFor(d) {
    if (d.count === 0 && d.focusMs === 0) return 0;
    if (d.rate != null) {
      if (d.rate <= 1) return 1;
      if (d.rate <= 2) return 2;
      if (d.rate <= 4) return 3;
      if (d.rate <= 6) return 4;
      return 5;
    }
    // 세션 없이 기록만 있는 날: 횟수 기준 대략치
    if (d.count <= 2) return 2;
    if (d.count <= 5) return 3;
    if (d.count <= 9) return 4;
    return 5;
  }

  const LEVELS = [
    { level: 1, label: '매우 집중', hint: '시간당 1회 이하' },
    { level: 2, label: '좋음', hint: '시간당 2회 이하' },
    { level: 3, label: '보통', hint: '시간당 4회 이하' },
    { level: 4, label: '흔들림', hint: '시간당 6회 이하' },
    { level: 5, label: '많이 흔들림', hint: '시간당 6회 초과' },
  ];

  function readiness(data) {
    const days = new Set(data.events.map((e) => dateKey(e.ts))).size;
    const events = data.events.length;
    return {
      events,
      days,
      needEvents: REPORT_MIN_EVENTS,
      needDays: REPORT_MIN_DAYS,
      ready: events >= REPORT_MIN_EVENTS && days >= REPORT_MIN_DAYS,
      progress: Math.min(1, (Math.min(events / REPORT_MIN_EVENTS, 1) + Math.min(days / REPORT_MIN_DAYS, 1)) / 2),
    };
  }

  /** 시간대별 흔들림 '빈도'(세션 시간 1시간당). 세션 노출 시간 30분 미만인 시간대는 신뢰도 낮아 제외 */
  function hourlyRates(data, now) {
    const exposure = new Array(24).fill(0);
    for (const s of data.sessions) {
      let t = s.startAt;
      const end = s.startAt + sessionDurationMs(s, now);
      while (t < end) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const chunkEnd = Math.min(end, nextHour);
        exposure[d.getHours()] += chunkEnd - t;
        t = chunkEnd;
      }
    }
    const counts = new Array(24).fill(0);
    for (const e of data.events) if (e.sessionId) counts[new Date(e.ts).getHours()] += 1;
    return counts.map((c, h) => ({
      hour: h,
      count: c,
      exposureMs: exposure[h],
      rate: exposure[h] >= 30 * MIN ? c / (exposure[h] / HOUR) : null,
    }));
  }

  function buildReport(data, now) {
    now = now != null ? now : Date.now();
    const ev = data.events;
    const total = ev.length;
    const parks = ev.filter((e) => e.type === 'park').length;
    const rets = total - parks;
    const totalFocusMs = data.sessions.reduce((a, s) => a + sessionDurationMs(s, now), 0);
    const sessionEvents = ev.filter((e) => e.sessionId).length;

    const spans = focusSpans(data);
    const firsts = firstDriftTimes(data);

    const catCounts = {};
    for (const e of ev) {
      const k = e.category || 'none';
      catCounts[k] = (catCounts[k] || 0) + 1;
    }
    const categorized = total - (catCounts.none || 0);
    const categories = Object.entries(catCounts)
      .filter(([k]) => k !== 'none')
      .map(([id, count]) => ({ id, count, share: categorized ? count / categorized : 0, meta: categoryOf(id) }))
      .sort((a, b) => b.count - a.count);

    const hours = hourlyRates(data, now);
    const ratedHours = hours.filter((h) => h.rate != null);
    const worstHours = [...ratedHours].sort((a, b) => b.rate - a.rate).slice(0, 3);
    const bestHours = [...ratedHours].sort((a, b) => a.rate - b.rate).slice(0, 3);

    const weekday = new Array(7).fill(0);
    for (const e of ev) weekday[new Date(e.ts).getDay()] += 1;

    const returnMinutes = ev
      .filter((e) => e.type === 'return' && e.durationBucket)
      .map((e) => (DURATIONS.find((d) => d.id === e.durationBucket) || {}).minutes)
      .filter((m) => m != null);

    const report = {
      total,
      parks,
      rets,
      parkRate: total ? parks / total : null,
      totalFocusMs,
      sessionCount: data.sessions.length,
      ratePerHour: totalFocusMs >= 10 * MIN ? sessionEvents / (totalFocusMs / HOUR) : null,
      medianSpanMs: median(spans),
      medianFirstDriftMs: median(firsts),
      categories,
      uncategorized: catCounts.none || 0,
      hours,
      worstHours,
      bestHours,
      weekday,
      lostMinutesEstimate: returnMinutes.reduce((a, b) => a + b, 0),
      avgReturnMinutes: mean(returnMinutes),
      readiness: readiness(data),
    };
    report.insights = insights(report);
    return report;
  }

  function fmtMin(ms) {
    if (ms == null) return '-';
    const m = ms / MIN;
    if (m < 1) return `${Math.round(ms / 1000)}초`;
    if (m < 60) return `${Math.round(m)}분`;
    return `${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분`;
  }

  /** 규칙 기반 인사이트. 각 항목: { id, tone: 'tip'|'good'|'warn', title, body } */
  function insights(r) {
    const out = [];
    const top = r.categories[0];

    if (r.parkRate != null && r.total >= 5) {
      if (r.parkRate < 0.3) {
        out.push({
          id: 'park-low', tone: 'warn',
          title: `주차 성공률 ${Math.round(r.parkRate * 100)}% — 먼저 다녀오고 나서 알아차리는 경우가 많아요`,
          body: '딴생각이 떠오른 순간 "가기 전에" 🅿️ 주차부터 누르는 연습을 해 보세요. 생각을 적어 두기만 해도 "지금 당장 해야 한다"는 충동이 약해집니다. (성인 ADHD 인지행동치료의 distractibility delay 기법)',
        });
      } else if (r.parkRate >= 0.6) {
        out.push({
          id: 'park-high', tone: 'good',
          title: `주차 성공률 ${Math.round(r.parkRate * 100)}% — 떠나기 전에 잘 붙잡고 있어요`,
          body: '주차장에 쌓인 생각은 쉬는 시간에 한 번에 처리하는 시간을 정해 두면, 다음에도 안심하고 주차할 수 있습니다.',
        });
      }
    }

    if (top && top.share >= 0.4) {
      const tips = {
        curious: '궁금한 단어나 개념은 바로 검색하지 말고 주차해 두고, 쉬는 시간 5분을 "궁금증 몰아서 검색" 시간으로 정해 보세요.',
        social: '세션 중에는 메신저 알림을 끄거나 폰을 손이 닿지 않는 곳에 두는 등, 물리적 거리를 만드는 게 의지보다 효과적입니다.',
        todo: '할 일이 자꾸 떠오른다면 세션 시작 전에 2분 동안 "머릿속 비우기(brain dump)"를 먼저 해 보세요.',
        mind: '잡생각이 많다면 집중 블록을 짧게 나누고, 사이사이 1~2분 몸을 움직이는 휴식을 넣어 보세요.',
        tool: '도구·세팅 탐색(익스텐션, 앱 설정 등)이 잦습니다. "도구 고민은 금요일 30분"처럼 시간을 따로 잡아 두면 수업 중 충동이 줄어듭니다.',
        body: '피로·졸림이 주된 원인이라면 수면, 식사, 복약 시간과 집중 시간대의 관계를 같이 기록해 보세요.',
        etc: '"기타"가 많다면 정리함에서 메모를 보고 새 패턴이 있는지 확인해 보세요.',
      };
      out.push({
        id: 'top-category', tone: 'tip',
        title: `흔들림의 ${Math.round(top.share * 100)}%가 ${top.meta ? top.meta.emoji + ' ' + top.meta.label : top.id}`,
        body: tips[top.id] || tips.etc,
      });
    }

    if (r.medianFirstDriftMs != null) {
      const m = r.medianFirstDriftMs / MIN;
      if (m < 15) {
        const block = Math.max(5, Math.ceil(m / 5) * 5);
        out.push({
          id: 'first-drift', tone: 'tip',
          title: `세션 시작 후 첫 흔들림까지 보통 ${fmtMin(r.medianFirstDriftMs)}`,
          body: `처음부터 긴 집중을 목표로 하기보다 ${block}분 단위 블록으로 나누고, 한 블록을 끝낼 때마다 작은 체크를 해 보세요. 성공 경험이 쌓이면 블록을 늘려 갈 수 있습니다.`,
        });
      }
    }

    if (r.medianSpanMs != null) {
      out.push({
        id: 'span', tone: 'tip',
        title: `한 번 집중하면 보통 ${fmtMin(r.medianSpanMs)} 유지돼요 (중앙값)`,
        body: '이 시간이 지금의 "집중 단위"입니다. 이 숫자보다 조금 긴 목표(+20%)를 잡고 조금씩 늘려 가는 것이 현실적입니다.',
      });
    }

    if (r.worstHours.length && r.bestHours.length && r.worstHours[0].hour !== r.bestHours[0].hour) {
      const w = r.worstHours[0];
      const b = r.bestHours[0];
      out.push({
        id: 'hours', tone: 'tip',
        title: `${w.hour}시대가 가장 흔들리고, ${b.hour}시대가 가장 안정적이에요`,
        body: `${w.hour}시대에는 시간당 ${w.rate.toFixed(1)}회, ${b.hour}시대에는 ${b.rate.toFixed(1)}회 흔들렸습니다. 어려운 작업은 ${b.hour}시대에, 단순 작업이나 휴식은 ${w.hour}시대에 배치해 보세요.`,
      });
    }

    if (r.avgReturnMinutes != null && r.avgReturnMinutes >= 10) {
      out.push({
        id: 'long-detour', tone: 'warn',
        title: `한 번 다녀오면 평균 ${Math.round(r.avgReturnMinutes)}분`,
        body: '딴짓이 길어지는 편입니다. 다녀온 뒤에는 복귀 앵커(어디까지 했는지 메모)를 활용해 "놓친 부분 → 따라잡기 → 또 이탈" 루프를 끊어 보세요.',
      });
    }

    if (r.uncategorized / Math.max(1, r.total) > 0.5) {
      out.push({
        id: 'uncategorized', tone: 'tip',
        title: '절반 이상이 분류되지 않았어요',
        body: '버튼만 누르는 것도 충분히 의미 있습니다. 여유가 있을 때 세션이 끝난 뒤 정리함에서 몇 개만 분류해 두면 리포트가 더 정확해집니다.',
      });
    }

    return out;
  }

  /** 미리보기용 데모 데이터 (저장하지 않음). seed 고정 → 테스트 재현 가능 */
  function generateDemoData(now, days) {
    now = now != null ? now : Date.now();
    days = days || 21;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const sessions = [];
    const events = [];
    const base = new Date(now);
    for (let i = days; i >= 1; i--) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      if (day.getDay() === 0) continue;
      const blocks = [[9, 'curious'], [14, 'social'], [20, 'tool']];
      for (const [h, bias] of blocks) {
        if (rand() < 0.25) continue;
        const startAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, Math.floor(rand() * 30)).getTime();
        const len = (60 + Math.floor(rand() * 90)) * MIN;
        const id = `demo-s-${sessions.length}`;
        sessions.push({ id, label: pick(['수업', '공부', '업무']), anchorNote: '', startAt, endAt: startAt + len });
        const drift = h === 14 ? 9 : h === 20 ? 14 : 20; // 오후에 더 자주 흔들리게
        let t = startAt + (drift * 0.5 + rand() * drift) * MIN;
        while (t < startAt + len) {
          const type = rand() < 0.45 ? 'park' : 'return';
          events.push({
            id: `demo-e-${events.length}`, sessionId: id, ts: Math.floor(t), type,
            category: rand() < 0.5 ? bias : pick(CATEGORIES).id,
            note: '', durationBucket: type === 'return' ? pick(DURATIONS).id : null, resolved: rand() < 0.5,
          });
          t += (drift * 0.5 + rand() * drift) * MIN;
        }
      }
    }
    return { version: 1, sessions, events };
  }

  return {
    MIN, HOUR, CATEGORIES, DURATIONS, WEEKDAYS, LEVELS,
    REPORT_MIN_EVENTS, REPORT_MIN_DAYS,
    categoryOf, dateKey, median, mean, fmtMin,
    sessionDurationMs, focusSpans, firstDriftTimes,
    monthHourMatrix, focusMsByDay, dailySummary, levelFor,
    readiness, hourlyRates, buildReport, insights, generateDemoData,
  };
});
