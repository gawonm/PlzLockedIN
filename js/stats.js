/*
 * stats.js — 순수 함수 통계 모듈 (DOM 의존성 없음 → Node 테스트 가능)
 *
 * 해석 원칙 (UI 문구와 인사이트가 이 원칙을 따른다)
 *  1. 기록 = "사용자가 주의 이탈을 알아차리고 버튼을 누른 시점". 실제 이탈 횟수가 아니다.
 *  2. 기록이 없다는 것은 집중했다는 증거가 아니다 → "집중 지속 시간"을 만들어 내지 않는다.
 *  3. 길이가 다른 세션의 횟수를 그대로 비교하지 않는다 → 신뢰할 수 있는 세션에서만 시간당 비율 계산.
 *  4. 이탈 지속시간은 관측하지 않았으므로 추정하지 않는다.
 *  5. 짧은 간격의 연속 기록을 '같은 이탈'로 확정하지 않는다(연쇄 '가능성'으로만 표현).
 *  6. 데이터가 적으면 해석하지 않는다. 상관을 인과로 말하지 않는다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FocusStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const TASK_TYPES = [
    { id: 'class', emoji: '🎓', label: '수업' },
    { id: 'coding', emoji: '💻', label: '코딩' },
    { id: 'work', emoji: '🗂', label: '업무' },
    { id: 'reading', emoji: '📖', label: '독서' },
    { id: 'other', emoji: '•', label: '기타' },
  ];
  const ACTIVITIES = [
    { id: 'search', emoji: '🔍', label: '검색' },
    { id: 'messenger', emoji: '💬', label: '메신저·SNS' },
    { id: 'other-task', emoji: '🔀', label: '다른 작업' },
    { id: 'moving', emoji: '🚶', label: '이동' },
    { id: 'other', emoji: '•', label: '기타' },
  ];
  const TRIGGERS = [
    { id: 'thought', emoji: '💭', label: '떠오른 생각' },
    { id: 'notification', emoji: '🔔', label: '알림' },
    { id: 'person', emoji: '🙋', label: '사람' },
    { id: 'noise', emoji: '🔊', label: '소음·환경' },
    { id: 'fatigue', emoji: '🥱', label: '피로' },
    { id: 'other', emoji: '•', label: '기타' },
  ];
  const RETURNED = [
    { id: 'yes', label: '돌아옴' },
    { id: 'no', label: '못 돌아감' },
    { id: 'unknown', label: '모름' },
  ];

  // 신뢰 가능한 세션 기준
  const RELIABLE_MIN_MS = 5 * MIN;
  const RELIABLE_MAX_MS = 6 * HOUR;
  // 해석 최소 표본
  const INSIGHT_MIN_EVENTS = 15;
  const INSIGHT_MIN_DAYS = 3;
  const SHORT_GAP_MS = 5 * MIN;
  const GAP_BUCKETS = [
    { id: 'lt2', label: '2분 미만', max: 2 * MIN },
    { id: '2to5', label: '2–5분', max: 5 * MIN },
    { id: '5to15', label: '5–15분', max: 15 * MIN },
    { id: '15to30', label: '15–30분', max: 30 * MIN },
    { id: 'gte30', label: '30분 이상', max: Infinity },
  ];

  const metaOf = (list, id) => list.find((x) => x.id === id) || null;
  const tagLabel = (list, id) => {
    const m = metaOf(list, id);
    return m ? `${m.emoji} ${m.label}` : String(id);
  };

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 현재 런타임의 로컬 시간 기준 YYYY-MM-DD */
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

  function fmtDur(ms) {
    if (ms == null) return '-';
    const m = ms / MIN;
    if (m < 1) return `${Math.round(ms / 1000)}초`;
    if (m < 60) return `${Math.round(m)}분`;
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return r ? `${h}시간 ${r}분` : `${h}시간`;
  }

  function sessionDurationMs(s, now) {
    const end = s.endAt != null ? s.endAt : now != null ? now : Date.now();
    return Math.max(0, end - s.startAt);
  }

  /** 종료 시각을 사용자가 직접 남겼고, 길이가 상식적인 범위인 세션만 '신뢰 가능' */
  function isReliableSession(s) {
    if (s.endAt == null || s.endReason !== 'manual') return false;
    const d = s.endAt - s.startAt;
    return d >= RELIABLE_MIN_MS && d <= RELIABLE_MAX_MS;
  }

  function reliableSessions(data) {
    return data.sessions.filter(isReliableSession);
  }

  /**
   * 같은 그룹(같은 세션, 세션 없으면 같은 날짜) 안에서 직전 기록과의 간격.
   * @returns Map<eventId, ms|null>  (그룹의 첫 기록은 null)
   */
  function eventGaps(events) {
    const groups = new Map();
    for (const e of events) {
      const g = e.sessionId ? `s:${e.sessionId}` : `d:${dateKey(e.ts)}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    const out = new Map();
    for (const list of groups.values()) {
      list.sort((a, b) => a.ts - b.ts);
      list.forEach((e, i) => out.set(e.id, i === 0 ? null : e.ts - list[i - 1].ts));
    }
    return out;
  }

  function gapHistogram(gapsMs) {
    const counts = GAP_BUCKETS.map((b) => ({ ...b, count: 0 }));
    for (const g of gapsMs) {
      const b = counts.find((x) => g < x.max);
      if (b) b.count += 1;
    }
    return counts;
  }

  /** 특정 연/월(month: 0~11)의 day × hour(0~23) 기록 수 */
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

  function dailyCounts(events) {
    const out = {};
    for (const e of events) {
      const k = dateKey(e.ts);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  /** 기록 '수' 단계(0~4). 좋음/나쁨 의미 없음 — 색 농도에만 사용 */
  function countLevel(n) {
    if (!n) return 0;
    if (n === 1) return 1;
    if (n <= 3) return 2;
    if (n <= 6) return 3;
    return 4;
  }

  /** 세션 시간을 로컬 날짜별로 분배(자정·DST를 넘는 세션 대비) */
  function focusMsByDay(sessions, now) {
    const out = {};
    for (const s of sessions) {
      let t = s.startAt;
      const end = s.startAt + sessionDurationMs(s, now);
      while (t < end) {
        const d = new Date(t);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const chunkEnd = Math.min(end, next > t ? next : t + HOUR);
        const k = dateKey(t);
        out[k] = (out[k] || 0) + (chunkEnd - t);
        t = chunkEnd;
      }
    }
    return out;
  }

  /** 신뢰 가능한 세션의 로컬 시간대별 노출 시간(ms) */
  function hourlyExposure(sessions) {
    const exp = new Array(24).fill(0);
    for (const s of sessions) {
      let t = s.startAt;
      while (t < s.endAt) {
        const d = new Date(t);
        let next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        if (next <= t) next = t + HOUR; // DST 경계 방어
        const chunkEnd = Math.min(s.endAt, next);
        exp[d.getHours()] += chunkEnd - t;
        t = chunkEnd;
      }
    }
    return exp;
  }

  /**
   * 시간대별 분포.
   *  count: 모든 기록 수 (세션 여부 무관)
   *  rate : 신뢰 세션 내 기록 / 신뢰 세션 노출 시간 (노출 60분 이상일 때만)
   */
  function hourlyDistribution(data) {
    const rel = reliableSessions(data);
    const relIds = new Set(rel.map((s) => s.id));
    const exp = hourlyExposure(rel);
    const counts = new Array(24).fill(0);
    const relCounts = new Array(24).fill(0);
    for (const e of data.events) {
      const h = new Date(e.ts).getHours();
      counts[h] += 1;
      if (e.sessionId && relIds.has(e.sessionId)) relCounts[h] += 1;
    }
    return counts.map((c, h) => ({
      hour: h,
      count: c,
      exposureMs: exp[h],
      rate: exp[h] >= HOUR ? relCounts[h] / (exp[h] / HOUR) : null,
    }));
  }

  function sessionStats(data, now) {
    const byS = new Map();
    for (const e of data.events) if (e.sessionId) byS.set(e.sessionId, (byS.get(e.sessionId) || 0) + 1);
    return [...data.sessions]
      .sort((a, b) => b.startAt - a.startAt)
      .map((s) => {
        const reliable = isReliableSession(s);
        const durMs = sessionDurationMs(s, now);
        const count = byS.get(s.id) || 0;
        return {
          id: s.id, task: s.task, taskType: s.taskType, startAt: s.startAt, durMs, count, reliable,
          active: s.endAt == null, hasNextAction: !!s.nextAction,
          rate: reliable ? count / (durMs / HOUR) : null,
        };
      });
  }

  /** 할 일 유형별 (신뢰 세션 기준) */
  function byTaskType(data) {
    const rel = reliableSessions(data);
    const counts = new Map();
    for (const e of data.events) if (e.sessionId) counts.set(e.sessionId, (counts.get(e.sessionId) || 0) + 1);
    const out = {};
    for (const s of rel) {
      const k = s.taskType || 'other';
      const o = (out[k] = out[k] || { taskType: k, sessions: 0, exposureMs: 0, events: 0 });
      o.sessions += 1;
      o.exposureMs += s.endAt - s.startAt;
      o.events += counts.get(s.id) || 0;
    }
    return Object.values(out).map((o) => ({ ...o, rate: o.exposureMs > 0 ? o.events / (o.exposureMs / HOUR) : null }));
  }

  function tagCounts(events, field) {
    const m = new Map();
    let missing = 0;
    for (const e of events) {
      const v = e[field];
      if (!v) { missing++; continue; }
      m.set(v, (m.get(v) || 0) + 1);
    }
    const tagged = events.length - missing;
    return {
      tagged,
      missing,
      items: [...m.entries()].map(([id, count]) => ({ id, count, share: tagged ? count / tagged : 0 })).sort((a, b) => b.count - a.count),
    };
  }

  /** 주(월요일 시작, 로컬)별 기록 수와 신뢰 세션 기준 비율 */
  function weekStart(ts) {
    const d = new Date(ts);
    const diff = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff).getTime();
  }
  function weeklyTrend(data, now, weeks) {
    now = now != null ? now : Date.now();
    weeks = weeks || 8;
    const cur = weekStart(now);
    const out = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const ws = new Date(new Date(cur).getFullYear(), new Date(cur).getMonth(), new Date(cur).getDate() - 7 * i).getTime();
      const we = new Date(new Date(ws).getFullYear(), new Date(ws).getMonth(), new Date(ws).getDate() + 7).getTime();
      const evs = data.events.filter((e) => e.ts >= ws && e.ts < we);
      const rel = reliableSessions(data).filter((s) => s.startAt >= ws && s.startAt < we);
      const relIds = new Set(rel.map((s) => s.id));
      const exp = rel.reduce((a, s) => a + (s.endAt - s.startAt), 0);
      const relEvents = evs.filter((e) => relIds.has(e.sessionId)).length;
      out.push({ weekStart: ws, count: evs.length, exposureMs: exp, rate: exp >= HOUR ? relEvents / (exp / HOUR) : null });
    }
    return out;
  }

  function sufficiency(data) {
    const events = data.events.length;
    const days = new Set(data.events.map((e) => dateKey(e.ts))).size;
    const reliable = reliableSessions(data).length;
    let level = 'none';
    if (events > 0) level = 'early';
    if (events >= INSIGHT_MIN_EVENTS && days >= INSIGHT_MIN_DAYS) level = 'some';
    if (events >= 40 && days >= 7 && reliable >= 5) level = 'enough';
    return {
      events, days, reliable, level,
      canInsight: level === 'some' || level === 'enough',
      needEvents: INSIGHT_MIN_EVENTS, needDays: INSIGHT_MIN_DAYS,
      progress: Math.min(1, (Math.min(events / INSIGHT_MIN_EVENTS, 1) + Math.min(days / INSIGHT_MIN_DAYS, 1)) / 2),
    };
  }

  function buildReport(data, now) {
    now = now != null ? now : Date.now();
    const gapsMap = eventGaps(data.events);
    const gaps = [...gapsMap.values()].filter((g) => g != null);
    const rel = reliableSessions(data);
    const relIds = new Set(rel.map((s) => s.id));
    const relExposure = rel.reduce((a, s) => a + (s.endAt - s.startAt), 0);
    const relEvents = data.events.filter((e) => relIds.has(e.sessionId)).length;
    const r = {
      total: data.events.length,
      inSession: data.events.filter((e) => e.sessionId).length,
      sessionCount: data.sessions.length,
      reliableCount: rel.length,
      reliableExposureMs: relExposure,
      ratePerHour: relExposure >= HOUR ? relEvents / (relExposure / HOUR) : null,
      gapCount: gaps.length,
      medianGapMs: median(gaps),
      shortGapShare: gaps.length ? gaps.filter((g) => g <= SHORT_GAP_MS).length / gaps.length : null,
      gapHist: gapHistogram(gaps),
      hours: hourlyDistribution(data),
      sessions: sessionStats(data, now),
      taskTypes: byTaskType(data),
      activities: tagCounts(data.events, 'activity'),
      triggers: tagCounts(data.events, 'trigger'),
      weekly: weeklyTrend(data, now, 8),
      weekday: WEEKDAYS.map((_, i) => data.events.filter((e) => new Date(e.ts).getDay() === i).length),
      sufficiency: sufficiency(data),
    };
    r.insights = r.sufficiency.canInsight ? insights(r, data) : [];
    return r;
  }

  // 돌아보기 화면의 '다음에 해볼 작은 실험' (짧게)
  const ACTIVITY_EXP = {
    search: '궁금한 검색어는 맡기고, 쉬는 시간에 찾아보기',
    messenger: '세션 동안 메신저 알림 끄기',
    'other-task': '떠오른 다른 일은 한 줄로 맡기기',
    moving: '시작 전에 물·자리 정리 먼저 하기',
    other: '세션이 끝난 뒤 메모를 한 번만 훑어보기',
  };
  const TRIGGER_EXP = {
    thought: '떠오른 생각은 한 줄로 맡기고 돌아오기',
    notification: '세션 동안 방해 금지 모드 켜기',
    person: '세션 중이라고 주변에 알려 두기',
    noise: '이어폰을 쓰거나 자리 바꿔 보기',
    fatigue: '수면·식사 시간도 메모해 보기',
    other: '세션이 끝난 뒤 메모를 한 번만 훑어보기',
  };

  const ACTIVITY_TRY = {
    search: '궁금한 단어·개념은 검색하지 말고 "생각 한 줄 맡기기"에 검색어만 남겨 두고, 쉬는 시간에 한 번에 찾아보세요.',
    messenger: '세션을 시작할 때 메신저 알림을 끄거나 폰을 손이 닿지 않는 곳에 두는 것부터 해 보세요.',
    'other-task': '떠오른 다른 작업은 보관함에 한 줄만 적고, 세션의 첫 행동으로 돌아가 보세요.',
    moving: '자리를 뜨게 되는 이유(물, 화장실, 정리 등)를 세션 시작 전에 미리 처리해 보세요.',
    other: '자세히 기록한 메모를 세션이 끝난 뒤 한 번만 훑어보며 공통점을 찾아보세요.',
  };
  const TRIGGER_TRY = {
    thought: '떠오른 생각을 잃을까 봐 따라가게 된다면 "생각 한 줄 맡기기"로 보관하고 돌아오는 연습을 해 보세요.',
    notification: '세션 동안 방해 금지 모드를 켜 보세요.',
    person: '세션 중임을 주변에 알리거나, 방해가 적은 장소를 골라 보세요.',
    noise: '이어폰·자리 이동처럼 환경을 바꿀 수 있는 작은 방법을 시도해 보세요.',
    fatigue: '피로가 자주 기록된다면 수면·식사·휴식 시간도 함께 메모해 보세요.',
    other: '자세히 기록한 메모를 세션이 끝난 뒤 한 번만 훑어보세요.',
  };

  /**
   * 규칙 기반 인사이트. 형식: { id, fact, limit, try }
   * 관찰된 사실 → 해석의 한계 → 시도해 볼 작은 전략
   */
  function insights(r) {
    const out = [];

    // 1) 시간대
    const rated = r.hours.filter((h) => h.rate != null);
    if (rated.length >= 3 && r.reliableCount >= 3) {
      const top = [...rated].sort((a, b) => b.rate - a.rate)[0];
      const med = median(rated.map((h) => h.rate));
      if (med > 0 && top.rate >= med * 1.5 && top.count >= 3) {
        out.push({
          id: 'hour-rate',
          fact: `${top.hour}시대에는 세션 1시간당 기록이 ${top.rate.toFixed(1)}회로, 다른 시간대(중앙값 ${med.toFixed(1)}회)보다 많았어요.`,
          limit: '기록은 "알아차린" 횟수라서, 그 시간대에 더 잘 알아차렸을 수도 있어요. 할 일의 종류나 피로도도 시간대마다 달랐을 수 있어요.',
          try: `${top.hour}시대 세션을 시작할 때 "돌아왔을 때 첫 행동"을 한 줄 적어 두세요.`,
          experiment: { id: `hour-rate:${top.hour}`, text: `${top.hour}시대 세션은 첫 행동을 더 구체적으로 적기` },
        });
      }
    } else {
      const top = [...r.hours].sort((a, b) => b.count - a.count)[0];
      if (top && top.count >= 5 && top.count / Math.max(1, r.total) >= 0.25) {
        out.push({
          id: 'hour-count',
          fact: `기록의 ${Math.round((top.count / r.total) * 100)}%(${top.count}건)가 ${top.hour}시대에 있어요.`,
          limit: '그 시간대에 원래 더 오래 공부·업무를 했을 수 있어서 횟수만으로는 비교할 수 없어요. 세션을 시작하고 끝내면 시간당 비율로 비교할 수 있어요.',
          try: '다음 몇 번은 세션 시작·종료 버튼을 함께 써 보세요.',
          experiment: { id: 'hour-count', text: '세션 시작과 마치기를 함께 써 보기' },
        });
      }
    }

    // 2) 할 일 유형
    const tt = r.taskTypes.filter((t) => t.exposureMs >= 2 * HOUR && t.sessions >= 2 && t.rate != null);
    if (tt.length >= 2) {
      const s = [...tt].sort((a, b) => b.rate - a.rate);
      const hi = s[0];
      const lo = s[s.length - 1];
      if (lo.rate > 0 ? hi.rate / lo.rate >= 1.5 : hi.rate >= 1) {
        out.push({
          id: 'task-type',
          fact: `${tagLabel(TASK_TYPES, hi.taskType)} 세션은 1시간당 ${hi.rate.toFixed(1)}회, ${tagLabel(TASK_TYPES, lo.taskType)} 세션은 ${lo.rate.toFixed(1)}회 기록했어요.`,
          limit: '활동마다 난이도, 시간대, 알아차리기 쉬운 정도가 달라서 이 차이가 활동 종류 때문이라고 단정할 수 없어요.',
          try: `${tagLabel(TASK_TYPES, hi.taskType)} 세션에서는 현재 위치를 조금 더 구체적으로 적어 두세요(예: 페이지·함수 이름).`,
          experiment: { id: `task-type:${hi.taskType}`, text: `${(metaOf(TASK_TYPES, hi.taskType) || { label: hi.taskType }).label} 세션에서 위치를 페이지·함수 이름으로 적기` },
        });
      }
    }

    // 3) 짧은 간격의 연속 기록
    if (r.gapCount >= 10 && r.shortGapShare >= 0.4) {
      out.push({
        id: 'short-gaps',
        fact: `기록 간격의 ${Math.round(r.shortGapShare * 100)}%가 5분 이내였어요(간격 ${r.gapCount}개 중).`,
        limit: '짧은 간격의 기록이 하나의 이탈이 이어진 것인지, 서로 다른 이탈인지는 기록만으로 알 수 없어요.',
        try: '기록한 뒤 떠오른 게 있으면 "생각 한 줄 맡기기"로 보관하고, 첫 행동 하나만 하고 돌아가 보세요.',
        experiment: { id: 'short-gaps', text: '기록 뒤엔 생각을 맡기고 첫 행동 하나만 하기' },
      });
    }

    // 4) 반복 태그
    const act = r.activities.items[0];
    if (act && r.activities.tagged >= 8 && act.share >= 0.4) {
      out.push({
        id: 'top-activity',
        fact: `"${(metaOf(ACTIVITIES, act.id) || { label: act.id }).label}"(이)라고 남긴 기록이 ${act.count}번이에요(활동을 적은 기록 ${r.activities.tagged}건 중).`,
        limit: `선택해서 적은 기록만의 요약이에요. 원인을 알 수는 없고, 활동을 적지 않은 기록 ${r.activities.missing}건은 빠져 있어요.`,
        try: ACTIVITY_TRY[act.id] || ACTIVITY_TRY.other,
        experiment: { id: `top-activity:${act.id}`, text: ACTIVITY_EXP[act.id] || ACTIVITY_EXP.other },
      });
    }
    const trg = r.triggers.items[0];
    if (trg && r.triggers.tagged >= 8 && trg.share >= 0.4) {
      out.push({
        id: 'top-trigger',
        fact: `방해 요인으로 "${(metaOf(TRIGGERS, trg.id) || { label: trg.id }).label}"을(를) ${trg.count}번 골랐어요(요인을 적은 기록 ${r.triggers.tagged}건 중).`,
        limit: `선택해서 적은 기록만의 요약이에요. 원인을 알 수는 없고, 요인을 적지 않은 기록 ${r.triggers.missing}건은 빠져 있어요.`,
        try: TRIGGER_TRY[trg.id] || TRIGGER_TRY.other,
        experiment: { id: `top-trigger:${trg.id}`, text: TRIGGER_EXP[trg.id] || TRIGGER_EXP.other },
      });
    }

    // 5) 첫 행동을 적은 세션과 적지 않은 세션
    const relS = r.sessions.filter((s) => s.reliable);
    const withA = relS.filter((s) => s.hasNextAction);
    const noA = relS.filter((s) => !s.hasNextAction);
    if (withA.length >= 3 && noA.length >= 3) {
      const rate = (list) => list.reduce((a, s) => a + s.count, 0) / (list.reduce((a, s) => a + s.durMs, 0) / HOUR);
      const a = rate(withA);
      const b = rate(noA);
      if (Math.max(a, b) > 0 && Math.abs(a - b) / Math.max(a, b) >= 0.25) {
        out.push({
          id: 'next-action',
          fact: `첫 행동을 적은 세션은 1시간당 ${a.toFixed(1)}회, 적지 않은 세션은 ${b.toFixed(1)}회 기록했어요(각 ${withA.length}·${noA.length}개 세션).`,
          limit: '첫 행동을 적은 세션과 적지 않은 세션은 성격이 다를 수 있어서, 이 차이가 첫 행동 때문이라고 말할 수 없어요. 기록이 많다는 건 더 잘 알아차렸다는 뜻일 수도 있어요.',
          try: '복귀가 쉬웠는지를 기준으로, 첫 행동을 적는 방식이 나에게 맞는지 직접 판단해 보세요.',
          experiment: { id: 'next-action', text: '첫 행동을 한 문장으로 적고 복귀가 쉬웠는지 느껴 보기' },
        });
      }
    }

    return out;
  }

  // 돌아보기 기본 화면에 보여 줄 인사이트는 하나. 바로 해볼 수 있는 것부터.
  const INSIGHT_PRIORITY = ['top-activity', 'top-trigger', 'short-gaps', 'next-action', 'hour-rate', 'task-type', 'hour-count'];
  function pickInsight(r) {
    if (!r || !r.insights || !r.insights.length) return null;
    const rank = (i) => { const k = INSIGHT_PRIORITY.indexOf(i.id); return k < 0 ? 99 : k; };
    return [...r.insights].sort((a, b) => rank(a) - rank(b))[0];
  }

  /** 최근 n일(오늘 포함) 날짜별 기록 수. 기록 없는 날은 count 0 → UI에서 '미기록'으로 표시 */
  function recentDays(events, now, n) {
    now = now != null ? now : Date.now();
    n = n || 7;
    const counts = dailyCounts(events);
    const base = new Date(now);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      const k = dateKey(d.getTime());
      out.push({ key: k, month: d.getMonth() + 1, day: d.getDate(), weekday: WEEKDAYS[d.getDay()], count: counts[k] || 0 });
    }
    return out;
  }

  // ───────── 집중 저하 시간 패턴 (제안서: docs/FOCUS_DECLINE_PATTERN_PROPOSAL.md) ─────────
  // 원칙: 날짜 단위로 센다 · 추정은 범위로 · 연결이 불명확하면 제외 · 우세한 패턴을 자동 판정하지 않는다
  const DECLINE_MIN_DAYS = 5; // 비교를 '시작'하는 제품상 기준. 통계적·의학적 타당성 기준이 아님
  const SYMPTOM_META = [
    { id: 'distracted', label: '산만함' },
    { id: 'sleepy', label: '졸림·피로' },
    { id: 'lethargic', label: '무기력' },
    { id: 'irritable', label: '짜증·초조' },
    { id: 'drifted', label: '다른 일로 이탈' },
  ];
  const LINK_LABELS = {
    linked: '복용 정보와 연결',
    'no-dose-info': '복용 미기록',
    'no-dose-time': '복용 시각 미기록',
    'not-taken': '복용 안 한 날',
    ambiguous: '연결 불명확',
    multiple: '여러 번 복용한 날',
  };

  function minutesOfDay(ts) {
    const d = new Date(ts);
    const mid = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return (ts - mid) / MIN; // DST 날에도 실제 경과 분
  }

  /**
   * 집중 저하 보고 하나를 복용 정보와 연결.
   * 발생 시각 기준 24시간 안의 복용(같은 날 또는 전날)만 후보. 후보가 하나일 때만 연결한다.
   */
  function linkDose(decline, days) {
    const from = decline.onsetFrom;
    const keys = [...new Set([dateKey(from), dateKey(from - 24 * HOUR)])];
    const cands = [];
    let notTaken = false;
    let noTime = false;
    for (const k of keys) {
      const day = days && days[k];
      if (!day || !day.dose) continue;
      if (day.dose.status === 'not-taken' && k === dateKey(from)) notTaken = true;
      if (day.dose.status !== 'taken') continue;
      const ts = day.dose.times || [];
      if (!ts.length) { if (k === dateKey(from)) noTime = true; continue; }
      const within = ts.filter((t) => t <= from && from - t <= 24 * HOUR);
      if (!within.length) continue;
      cands.push({ key: k, day, partial: within.length !== ts.length });
    }
    if (!cands.length) return { status: notTaken ? 'not-taken' : noTime ? 'no-dose-time' : 'no-dose-info' };
    if (cands.length > 1 || cands[0].partial) return { status: 'ambiguous' };
    const c = cands[0];
    if (c.day.dose.multiple) return { status: 'multiple' };
    const ts = c.day.dose.times;
    return {
      status: 'linked',
      doseKey: c.key,
      doseTimes: ts,
      elapsedFrom: from - ts[ts.length - 1], // 가장 늦은 복용 후보 기준 최소 경과
      elapsedTo: decline.onsetTo - ts[0], // 가장 이른 복용 후보 기준 최대 경과
      doseEstimated: ts.length > 1 || c.day.dose.certainty === 'estimated',
    };
  }

  /**
   * 날짜별 범위 목록에서 width 폭 창이 가장 많은 '날'을 덮는 위치.
   * 읽기 쉬운 정각 창(예: 16~17시)을 먼저 찾고, step 단위로 어긋난 창은 더 많은 날을 덮을 때만 쓴다.
   */
  function bestWindow(dayRanges, width, step, lo, hi) {
    const cover = (a) => dayRanges.filter((rs) => rs.some(([x, y]) => y >= a && x < a + width)).length;
    let best = null;
    for (let a = lo; a + width <= hi; a += width) {
      const count = cover(a);
      if (!best || count > best.count) best = { start: a, end: a + width, count };
    }
    for (let a = lo; a + width <= hi; a += step) {
      const count = cover(a);
      if (count > best.count) best = { start: a, end: a + width, count };
    }
    return best;
  }

  function fmtClockWindow(a, b) {
    const f = (m) => { const h = Math.floor(m / 60) % 24; const mm = Math.round(m % 60); return mm ? `${h}:${String(mm).padStart(2, '0')}` : `${h}`; };
    const onHour = a % 60 === 0 && b % 60 === 0;
    return onHour ? `${f(a)}~${f(b)}시` : `${f(a)}~${f(b)}`;
  }
  function fmtHours(m) {
    const h = m / 60;
    return Number.isInteger(h) ? `${h}` : h.toFixed(1).replace(/\.0$/, '');
  }

  function declineAnalysis(data) {
    const declines = (data.declines || []).slice().sort((a, b) => a.onsetFrom - b.onsetFrom);
    const days = data.days || {};
    const byDay = new Map();
    for (const d of declines) {
      const k = dateKey(d.onsetFrom);
      if (!byDay.has(k)) byDay.set(k, { key: k, items: [] });
      const from = minutesOfDay(d.onsetFrom);
      const to = Math.min(24 * 60, from + (d.onsetTo - d.onsetFrom) / MIN);
      const link = linkDose(d, days);
      byDay.get(k).items.push({ id: d.id, from, to, estimated: d.onsetCertainty === 'estimated', link, symptoms: d.symptoms || [] });
    }
    const rows = [...byDay.values()].map((r) => {
      const linked = r.items.filter((i) => i.link.status === 'linked');
      const order = ['ambiguous', 'multiple', 'not-taken', 'no-dose-time', 'no-dose-info'];
      const reasons = r.items.map((i) => i.link.status);
      return {
        ...r,
        estimatedClock: r.items.some((i) => i.estimated),
        linked: linked.length > 0,
        estimatedElapsed: linked.some((i) => i.estimated || i.link.doseEstimated),
        excludeReason: linked.length ? null : order.find((o) => reasons.includes(o)) || 'no-dose-info',
        context: days[r.key] || null,
      };
    });

    const clockRanges = rows.map((r) => r.items.map((i) => [i.from, i.to]));
    const clockSure = rows.map((r) => r.items.filter((i) => !i.estimated).map((i) => [i.from, i.to])).filter((x) => x.length);
    const linkedRows = rows.filter((r) => r.linked);
    const elapsedRanges = linkedRows.map((r) => r.items.filter((i) => i.link.status === 'linked').map((i) => [i.link.elapsedFrom / MIN, i.link.elapsedTo / MIN]));
    const elapsedSure = linkedRows
      .map((r) => r.items.filter((i) => i.link.status === 'linked' && !i.estimated && !i.link.doseEstimated).map((i) => [i.link.elapsedFrom / MIN, i.link.elapsedTo / MIN]))
      .filter((x) => x.length);

    const clockReady = rows.length >= DECLINE_MIN_DAYS;
    const elapsedReady = linkedRows.length >= DECLINE_MIN_DAYS;
    const clockBest = rows.length ? bestWindow(clockRanges, 60, 15, 0, 24 * 60) : null;
    const clockBestSure = clockSure.length ? bestWindow(clockSure, 60, 15, 0, 24 * 60) : null;
    const elapsedBest = linkedRows.length ? bestWindow(elapsedRanges, 60, 30, 0, 24 * 60) : null;
    const elapsedBestSure = elapsedSure.length ? bestWindow(elapsedSure, 60, 30, 0, 24 * 60) : null;

    // 복용 시각이 날마다 비슷하면(±30분) 시계 시간과 경과시간을 구분하기 어렵다
    const doseMids = linkedRows.map((r) => {
      const l = r.items.find((i) => i.link.status === 'linked').link;
      return (minutesOfDay(l.doseTimes[0]) + minutesOfDay(l.doseTimes[l.doseTimes.length - 1])) / 2;
    });
    const doseSimilar = doseMids.length >= 2 && Math.max(...doseMids) - Math.min(...doseMids) <= 60;
    const sensitiveClock = !!(clockReady && clockBestSure && clockSure.length >= 3 && clockBestSure.start !== clockBest.start);
    const sensitiveElapsed = !!(elapsedReady && elapsedBestSure && elapsedSure.length >= 3 && elapsedBestSure.start !== elapsedBest.start);

    const excluded = {};
    for (const r of rows) if (r.excludeReason) excluded[r.excludeReason] = (excluded[r.excludeReason] || 0) + 1;

    const counts = {
      observedDays: rows.length,
      clockDays: rows.length,
      elapsedDays: linkedRows.length,
      estimatedDays: rows.filter((r) => r.estimatedClock || r.estimatedElapsed).length,
      excludedDays: rows.length - linkedRows.length,
      excluded,
      reports: declines.length,
    };

    let observation;
    if (!clockReady) {
      observation = {
        ready: false,
        fact: `아직 관찰 중이에요. 현재 비교 가능한 날은 ${rows.length}일이에요.`,
        limit: '미기록 시간의 집중 상태는 알 수 없어요.',
        try: null,
      };
    } else {
      const win = fmtClockWindow(clockBest.start, clockBest.end);
      let fact = `비교 가능한 ${rows.length}일 중 ${clockBest.count}일에 ${win} 집중 저하를 기록했어요.`;
      if (elapsedReady) fact += ` 복용 후 경과시간으로는 연결 가능한 ${linkedRows.length}일 중 ${elapsedBest.count}일이 ${fmtHours(elapsedBest.start)}~${fmtHours(elapsedBest.end)}시간 사이였어요.`;
      const limits = ['미기록 시간의 집중 상태는 알 수 없고, 이 기록만으로 원인을 알 수는 없어요.'];
      if (!elapsedReady) limits.push(`복용 정보와 연결된 날이 ${linkedRows.length}일이라 복용 후 경과시간 비교는 아직 하지 않아요.`);
      if (doseSimilar) limits.push('복용 시각이 날마다 비슷해서, 시계 시간과 복용 후 경과시간 중 어느 쪽과 더 관련 있는지는 아직 구분하기 어려워요.');
      if (sensitiveClock || sensitiveElapsed) limits.push('추정 시각에 따라 관찰이 달라져요.');
      limits.push('특정 시간에만 앱을 열었다면 그 시간의 기록이 많아 보일 수 있어요.');
      observation = {
        ready: true,
        fact,
        limit: limits.join(' '),
        try: `${win} 무렵의 작업량과 휴식 여부를 함께 돌아보기`,
      };
    }

    return {
      rows, counts, clockReady, elapsedReady, clockBest, clockBestSure, elapsedBest, elapsedBestSure,
      doseSimilar, sensitiveClock, sensitiveElapsed, observation,
    };
  }

  /** 미리보기용 데모 데이터 (저장하지 않음). seed 고정 → 테스트 재현 가능 */
  function generateDemoData(now, days) {
    now = now != null ? now : Date.now();
    days = days || 28;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const sessions = [];
    const events = [];
    const base = new Date(now);
    const blocks = [[9, 'class', 'LangGraph 수업', 'search', 22], [14, 'class', '데이터베이스 수업', 'messenger', 10], [20, 'coding', '개인 프로젝트', 'other-task', 16]];
    for (let i = days; i >= 1; i--) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      if (day.getDay() === 0) continue;
      for (const [h, taskType, task, bias, drift] of blocks) {
        if (rand() < 0.3) continue;
        const startAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, Math.floor(rand() * 30)).getTime();
        const len = (50 + Math.floor(rand() * 70)) * MIN;
        const id = `demo-s-${sessions.length}`;
        const hasAction = rand() < 0.5;
        sessions.push({
          id, taskType, task, location: '', nextAction: hasAction ? '강의 화면 보고 마지막 줄 확인' : '',
          startAt, endAt: startAt + len, endReason: 'manual', tz: null, tzOffsetMin: null, createdAt: startAt, updatedAt: startAt + len,
        });
        let t = startAt + (drift * 0.4 + rand() * drift) * MIN;
        while (t < startAt + len) {
          const tagged = rand() < 0.6;
          events.push({
            id: `demo-e-${events.length}`, sessionId: id, ts: Math.floor(t), tz: null, tzOffsetMin: null, source: 'one-tap', taskType,
            thought: '', activity: tagged ? (rand() < 0.55 ? bias : pick(ACTIVITIES).id) : null,
            trigger: tagged && rand() < 0.5 ? pick(TRIGGERS).id : null, returned: 'unknown', note: '',
            keepForLater: false, laterDone: false, chainLink: null, createdAt: t, updatedAt: t,
          });
          // 가끔 짧은 간격의 연속 기록
          t += rand() < 0.3 ? (1 + rand() * 3) * MIN : (drift * 0.4 + rand() * drift) * MIN;
        }
      }
    }
    return { schemaVersion: 2, activeSessionId: null, sessions, events };
  }

  return {
    MIN, HOUR, WEEKDAYS, TASK_TYPES, ACTIVITIES, TRIGGERS, RETURNED, GAP_BUCKETS,
    RELIABLE_MIN_MS, RELIABLE_MAX_MS, INSIGHT_MIN_EVENTS, INSIGHT_MIN_DAYS, SHORT_GAP_MS,
    metaOf, tagLabel, dateKey, median, fmtDur, sessionDurationMs,
    isReliableSession, reliableSessions, eventGaps, gapHistogram,
    monthHourMatrix, dailyCounts, countLevel, focusMsByDay, hourlyExposure, hourlyDistribution,
    sessionStats, byTaskType, tagCounts, weekStart, weeklyTrend, sufficiency, buildReport, insights, pickInsight, recentDays,
    generateDemoData,
    DECLINE_MIN_DAYS, SYMPTOM_META, LINK_LABELS, minutesOfDay, linkDose, bestWindow, fmtClockWindow, fmtHours, declineAnalysis,
  };
});
