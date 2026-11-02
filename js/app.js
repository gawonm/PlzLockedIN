/* app.js — UI. 원칙: "앱에 머무르게 하는가?"가 아니라 "원래 하던 일로 빨리 돌아가게 하는가?" */
(function () {
  'use strict';
  const S = window.FocusStats;
  const Store = window.FocusStore;

  const STATUS_MS = 6000; // 기록 후 상태 영역 표시 시간
  const DEBOUNCE_MS = 800; // 같은 손가락의 중복 클릭 방지 (그 뒤 연속 기록은 허용)
  const SHEET_IDLE_MS = 30000; // 상세 시트에서 입력이 없으면 자동으로 닫힘
  const THOUGHT_IDLE_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const mdhm = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ts)}`; };

  // ───────── 저장소 ─────────
  let storage = null;
  try { storage = window.localStorage; storage.getItem('__probe'); } catch (e) { storage = null; }
  const memory = { m: {}, getItem(k) { return k in this.m ? this.m[k] : null; }, setItem(k, v) { this.m[k] = String(v); }, removeItem(k) { delete this.m[k]; } };
  const backend = () => storage || memory;

  const loaded = Store.load(backend());
  let data = loaded.data;
  const notices = [];
  if (!storage || !loaded.ok) showBanner('브라우저 저장소를 쓸 수 없어요. 이 창을 닫으면 기록이 사라질 수 있어요. 데이터 탭에서 JSON 백업을 받아 두세요.');
  if (loaded.migratedFromV1) notices.push(`이전 버전 기록 ${data.events.length}개를 새 형식으로 옮겼어요. 원본도 브라우저에 그대로 남아 있어요.`);
  const stale = Store.closeStaleSessions(data);
  if (stale) notices.push(`12시간 넘게 열려 있던 세션 "${stale.task || '집중'}"을 닫았어요. 종료 시각을 알 수 없어 시간당 비율 계산에서는 빠져요.`);
  if (loaded.migratedFromV1 || stale) persist();

  function persist() {
    const ok = Store.save(backend(), data);
    if (!ok) showBanner('저장하지 못했어요(저장 공간 부족 또는 사생활 보호 모드). 지금 기록은 이 창을 닫으면 사라질 수 있어요. 데이터 탭에서 JSON 백업을 받아 두세요.');
    return ok;
  }
  function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = false; }

  const ui = { tab: 'now', taskType: null, viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth(), yearView: new Date().getFullYear(), hourMode: 'count', demo: null };
  const activeSession = () => (data.activeSessionId ? data.sessions.find((s) => s.id === data.activeSessionId) || null : null);
  const touch = (o) => { o.updatedAt = Date.now(); };

  // ───────── 탭 & 잠금 ─────────
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  function switchTab(tab) {
    ui.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    renderTab();
  }
  function applyLock() {
    const locked = !!activeSession();
    $('lockBadge').hidden = !locked;
    document.querySelectorAll('.tab[data-lockable]').forEach((t) => t.classList.toggle('locked', locked));
    ['later', 'pattern', 'data'].forEach((id) => $(`tab-${id}`).classList.toggle('locked', locked));
  }

  // ───────── 칩 렌더 헬퍼 ─────────
  function chipsHtml(list, selected, attr) {
    return list.map((x) => `<button type="button" class="chip${x.id === selected ? ' on' : ''}" data-${attr}="${x.id}" aria-pressed="${x.id === selected}">${x.emoji ? x.emoji + ' ' : ''}${esc(x.label)}</button>`).join('');
  }
  function setPressed(container, attr, value) {
    container.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset[attr] === value;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ───────── 최근 입력 재사용 ─────────
  function recentValues(list, n) {
    const seen = new Set();
    const out = [];
    for (const v of list) { const t = (v || '').trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } if (out.length >= n) break; }
    return out;
  }
  function renderDatalists() {
    const ss = [...data.sessions].sort((a, b) => b.startAt - a.startAt);
    const es = [...data.events].sort((a, b) => b.ts - a.ts);
    const opt = (arr) => arr.map((v) => `<option value="${esc(v)}"></option>`).join('');
    $('recentTasks').innerHTML = opt(recentValues(ss.map((s) => s.task), 8));
    $('recentActions').innerHTML = opt(recentValues(ss.map((s) => s.nextAction), 8));
    $('recentThoughts').innerHTML = opt(recentValues(es.map((e) => e.thought), 8));
  }

  // ───────── 세션 ─────────
  $('taskTypeChips').innerHTML = chipsHtml(S.TASK_TYPES, null, 'tt');
  $('taskTypeChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    ui.taskType = ui.taskType === c.dataset.tt ? null : c.dataset.tt;
    setPressed($('taskTypeChips'), 'tt', ui.taskType);
  });

  $('startBtn').addEventListener('click', () => {
    const task = $('taskInput').value.trim();
    const s = Store.newSession({
      taskType: ui.taskType || Store.inferTaskType(task),
      task,
      location: $('locationInput').value.trim(),
      nextAction: $('nextActionInput').value.trim(),
    });
    data.sessions.push(s);
    data.activeSessionId = s.id;
    persist();
    ['taskInput', 'locationInput', 'nextActionInput'].forEach((id) => { $(id).value = ''; });
    ui.taskType = null;
    setPressed($('taskTypeChips'), 'tt', null);
    hideStatus();
    renderAll();
    $('oopsBtn').focus();
  });

  $('endBtn').addEventListener('click', () => {
    const s = activeSession();
    if (!s) return;
    s.endAt = Date.now();
    s.endReason = 'manual';
    touch(s);
    data.activeSessionId = null;
    persist();
    const n = data.events.filter((e) => e.sessionId === s.id).length;
    renderAll();
    showStatusMessage(`세션을 마쳤어요 · ${S.fmtDur(s.endAt - s.startAt)} · 기록 ${n}개`);
  });

  $('editSessionBtn').addEventListener('click', () => {
    const s = activeSession();
    if (!s) return;
    const f = $('sessionEdit');
    f.hidden = !f.hidden;
    $('editLocation').value = s.location;
    $('editNextAction').value = s.nextAction;
    if (!f.hidden) $('editLocation').focus();
  });
  $('sessionEdit').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = activeSession();
    if (!s) return;
    s.location = $('editLocation').value.trim();
    s.nextAction = $('editNextAction').value.trim();
    touch(s);
    persist();
    $('sessionEdit').hidden = true;
    renderNow();
  });

  // ───────── 원탭 기록 ─────────
  let lastTapAt = 0;
  let lastEvent = null;
  $('oopsBtn').addEventListener('click', record);

  function record() {
    const now = Date.now();
    if (now - lastTapAt < DEBOUNCE_MS) return; // 중복 클릭 무시
    lastTapAt = now;
    if (sheet.open) closeSheet(false);
    commitThought();
    const ev = Store.newEvent(activeSession(), now);
    data.events.push(ev);
    const ok = persist();
    lastEvent = ev;
    flashButton();
    showRecorded(ev, ok);
  }

  let flashTimer = 0;
  function flashButton() {
    const b = $('oopsBtn');
    b.classList.add('done');
    b.setAttribute('aria-disabled', 'true');
    $('oopsSub').textContent = '✓ 기록됨';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      b.classList.remove('done');
      b.removeAttribute('aria-disabled');
      $('oopsSub').textContent = '흐트러진 걸 알아차렸을 때 한 번';
    }, DEBOUNCE_MS);
  }

  /** 복귀 문구: 첫 행동 1개 → 없으면 하는 일·위치 → 없으면 기본 문구 */
  function returnText(s) {
    if (!s) return '';
    if (s.nextAction) return s.nextAction;
    const parts = [s.task, s.location].filter(Boolean);
    return parts.length ? parts.join(' · ') : '';
  }

  // ───────── 상태 영역 (모달 아님) ─────────
  let statusTimer = 0;
  function showRecorded(ev, ok) {
    const s = activeSession();
    $('statusSaved').textContent = ok ? `✓ ${hhmm(ev.ts)} 기록됨` : `⚠ ${hhmm(ev.ts)} 기록됨(이 창에서만, 저장 실패)`;
    const rt = returnText(s);
    $('statusReturnText').textContent = rt || '하던 일로 돌아가기';
    $('statusReturn').hidden = false;
    $('statusActions').hidden = false;
    $('thoughtForm').hidden = true;
    $('thoughtInput').value = '';
    $('status').hidden = false;
    scheduleStatusHide(STATUS_MS);
  }
  function showStatusMessage(msg, ms) {
    $('statusSaved').textContent = msg;
    $('statusReturn').hidden = true;
    $('statusActions').hidden = true;
    $('thoughtForm').hidden = true;
    $('status').hidden = false;
    scheduleStatusHide(ms || 3500);
  }
  function scheduleStatusHide(ms) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { commitThought(); hideStatus(); }, ms);
  }
  function hideStatus() {
    clearTimeout(statusTimer);
    $('status').hidden = true;
    lastEvent = null;
  }

  $('undoBtn').addEventListener('click', () => {
    if (!lastEvent) return;
    data.events = data.events.filter((e) => e.id !== lastEvent.id);
    persist();
    lastEvent = null;
    showStatusMessage('기록을 취소했어요', 2000);
  });

  // 💭 생각 적어두기 — 상태 영역 안 한 줄 입력
  $('thoughtBtn').addEventListener('click', () => {
    if (!lastEvent) return;
    $('statusActions').hidden = true;
    $('thoughtForm').hidden = false;
    $('thoughtInput').focus();
    scheduleStatusHide(THOUGHT_IDLE_MS);
  });
  $('thoughtInput').addEventListener('input', () => scheduleStatusHide(THOUGHT_IDLE_MS));
  $('thoughtForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const had = commitThought();
    const s = activeSession();
    if (had) showStatusMessageWithReturn('💭 보관했어요', s);
    else hideStatus();
  });
  /** 입력 중인 생각이 있으면 저장 (자동 닫힘·다음 기록 시에도 유실 방지) */
  function commitThought() {
    if ($('thoughtForm').hidden || !lastEvent) return false;
    const t = $('thoughtInput').value.trim();
    $('thoughtForm').hidden = true;
    if (!t) return false;
    const ev = data.events.find((x) => x.id === lastEvent.id);
    if (!ev) return false;
    ev.thought = t;
    ev.keepForLater = true;
    touch(ev);
    persist();
    renderDatalists();
    return true;
  }
  function showStatusMessageWithReturn(msg, s) {
    $('statusSaved').textContent = msg;
    const rt = returnText(s);
    $('statusReturnText').textContent = rt || '하던 일로 돌아가기';
    $('statusReturn').hidden = false;
    $('statusActions').hidden = true;
    $('thoughtForm').hidden = true;
    $('status').hidden = false;
    scheduleStatusHide(3000);
  }

  $('detailBtn').addEventListener('click', () => {
    if (!lastEvent) return;
    const ev = data.events.find((x) => x.id === lastEvent.id);
    hideStatus();
    if (ev) openSheet(ev, true);
  });

  // ───────── 상세 시트 (선택) ─────────
  const sheet = { open: false, ev: null, idle: 0, fromRecord: false, opener: null };
  const sheetChips = {
    taskType: [S.TASK_TYPES, 'tt'],
    activity: [S.ACTIVITIES, 'ac'],
    trigger: [S.TRIGGERS, 'tg'],
    returned: [S.RETURNED, 'rt'],
  };
  document.querySelectorAll('#sheet .chips[data-field]').forEach((box) => {
    box.addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c || !sheet.ev) return;
      const field = box.dataset.field;
      const attr = sheetChips[field][1];
      const val = c.dataset[attr];
      if (field === 'returned') sheet.ev.returned = val;
      else sheet.ev[field] = sheet.ev[field] === val ? null : val;
      setPressed(box, attr, sheet.ev[field]);
      saveSheet();
    });
  });
  $('dThought').addEventListener('input', () => {
    if (!sheet.ev) return;
    const had = !!sheet.ev.thought;
    sheet.ev.thought = $('dThought').value.trim();
    if (!had && sheet.ev.thought && !$('dKeep').dataset.touched) { sheet.ev.keepForLater = true; $('dKeep').checked = true; }
    saveSheet();
  });
  $('dNote').addEventListener('input', () => { if (sheet.ev) { sheet.ev.note = $('dNote').value.trim(); saveSheet(); } });
  $('dKeep').addEventListener('change', () => { if (sheet.ev) { $('dKeep').dataset.touched = '1'; sheet.ev.keepForLater = $('dKeep').checked; saveSheet(); } });
  $('sheetDone').addEventListener('click', () => closeSheet(true));
  $('sheetBackdrop').addEventListener('click', () => closeSheet(true));
  $('sheetDelete').addEventListener('click', () => {
    if (!sheet.ev || !confirm('이 기록을 삭제할까요?')) return;
    const id = sheet.ev.id;
    data.events = data.events.filter((e) => e.id !== id);
    persist();
    sheet.ev = null;
    closeSheet(false);
    renderTab();
  });

  function openSheet(ev, fromRecord) {
    sheet.open = true;
    sheet.ev = ev;
    sheet.fromRecord = fromRecord;
    sheet.opener = document.activeElement;
    $('sheetWhen').textContent = mdhm(ev.ts);
    document.querySelectorAll('#sheet .chips[data-field]').forEach((box) => {
      const [list, attr] = sheetChips[box.dataset.field];
      box.innerHTML = chipsHtml(list, ev[box.dataset.field], attr);
    });
    $('dThought').value = ev.thought;
    $('dNote').value = ev.note;
    $('dKeep').checked = !!ev.keepForLater;
    delete $('dKeep').dataset.touched;
    $('sheet').hidden = false;
    $('sheetBackdrop').hidden = false;
    $('sheetDone').focus();
    bumpSheetIdle();
  }
  function bumpSheetIdle() {
    clearTimeout(sheet.idle);
    sheet.idle = setTimeout(() => closeSheet(true), SHEET_IDLE_MS);
  }
  $('sheet').addEventListener('input', bumpSheetIdle);
  $('sheet').addEventListener('click', bumpSheetIdle);
  function saveSheet() {
    if (!sheet.ev) return;
    touch(sheet.ev);
    persist();
  }
  function closeSheet(showReturn) {
    if (!sheet.open) return;
    sheet.open = false;
    clearTimeout(sheet.idle);
    $('sheet').hidden = true;
    $('sheetBackdrop').hidden = true;
    const wasRecord = sheet.fromRecord;
    sheet.ev = null;
    renderDatalists();
    if (wasRecord && showReturn && ui.tab === 'now') {
      showStatusMessageWithReturn('✓ 저장했어요', activeSession());
      $('oopsBtn').focus();
    } else {
      renderTab();
      if (sheet.opener && document.contains(sheet.opener)) sheet.opener.focus();
    }
  }

  // ───────── 키보드 ─────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (sheet.open) { closeSheet(true); return; }
      if (!$('thoughtForm').hidden) { commitThought(); hideStatus(); return; }
    }
    if (sheet.open || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || e.target.isContentEditable) return;
    if (e.key === 'a' || e.key === 'A' || e.key === 'ㅁ') { e.preventDefault(); record(); }
  });

  // ───────── 렌더: 지금 ─────────
  function renderNow() {
    const s = activeSession();
    $('idleSession').hidden = !!s;
    $('activeSession').hidden = !s;
    if (!s) { $('sessionEdit').hidden = true; return; }
    const tt = S.metaOf(S.TASK_TYPES, s.taskType);
    $('sessionTask').textContent = (tt ? tt.emoji + ' ' : '') + (s.task || (tt ? tt.label : '집중'));
    $('sessionLocation').textContent = s.location || '—';
    $('sessionNextAction').textContent = s.nextAction || '—';
    tickClock();
  }
  function tickClock() {
    const s = activeSession();
    if (!s) return;
    const m = Math.floor((Date.now() - s.startAt) / 60000);
    $('sessionElapsed').textContent = m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간 ${m % 60}분째`;
  }
  setInterval(tickClock, 15000);

  // ───────── 렌더: 보관함 ─────────
  function renderLater() {
    const keeps = data.events.filter((e) => e.keepForLater).sort((a, b) => b.ts - a.ts);
    const open = keeps.filter((e) => !e.laterDone);
    const done = keeps.filter((e) => e.laterDone);
    const item = (e) => `<li data-id="${e.id}" class="${e.laterDone ? 'done' : ''}">
        <input type="checkbox" data-act="done" ${e.laterDone ? 'checked' : ''} aria-label="확인함" />
        <span class="txt">${e.thought ? esc(e.thought) : esc(e.note) || '<span class="muted">(내용 없음)</span>'}</span>
        <span class="meta">${mdhm(e.ts)}</span>
        <button class="icon-btn" data-act="unkeep" aria-label="보관함에서 빼기" title="보관함에서 빼기">✕</button></li>`;
    $('laterList').innerHTML = open.length ? open.map(item).join('') : '<li class="empty">보관한 생각이 없어요.</li>';
    $('laterDoneList').innerHTML = done.length ? done.map(item).join('') : '<li class="empty">아직 없어요.</li>';

    // 최근 기록: 세션(없으면 날짜)별 그룹
    const gaps = S.eventGaps(data.events);
    const sessions = new Map(data.sessions.map((s) => [s.id, s]));
    const groups = new Map();
    for (const e of [...data.events].sort((a, b) => b.ts - a.ts)) {
      const k = e.sessionId ? `s:${e.sessionId}` : `d:${S.dateKey(e.ts)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const html = [];
    let n = 0;
    for (const [k, evs] of groups) {
      if (n++ >= 15) break;
      const s = k.startsWith('s:') ? sessions.get(k.slice(2)) : null;
      const tt = s ? S.metaOf(S.TASK_TYPES, s.taskType) : null;
      const title = s ? `${tt ? tt.emoji + ' ' : ''}${esc(s.task || (tt ? tt.label : '세션'))} <span class="muted small">${mdhm(s.startAt)}${s.endAt ? ' · ' + S.fmtDur(s.endAt - s.startAt) : ' · 진행 중'}</span>` : `세션 밖 기록 <span class="muted small">${esc(S.dateKey(evs[0].ts))}</span>`;
      const rows = [...evs].reverse().map((e) => {
        const g = gaps.get(e.id);
        const chain = g != null && g <= S.SHORT_GAP_MS;
        const tags = [S.metaOf(S.ACTIVITIES, e.activity), S.metaOf(S.TRIGGERS, e.trigger)].filter(Boolean).map((m) => `${m.emoji} ${esc(m.label)}`).join(' · ');
        return `<li class="ev" data-id="${e.id}">
          <span class="ev-time">${hhmm(e.ts)}</span>
          <span class="ev-gap ${chain ? 'chain' : ''}">${g == null ? '' : '+' + S.fmtDur(g)}${chain ? ' · 연쇄 가능성' : ''}</span>
          <span class="txt">${e.thought ? esc(e.thought) : ''}${tags ? ` <span class="muted small">${tags}</span>` : ''}${!e.thought && !tags ? '<span class="muted small">(상세 없음)</span>' : ''}</span>
          <button class="btn sm ghost" data-act="edit">자세히</button></li>`;
      }).join('');
      html.push(`<div class="group"><div class="group-title">${title}</div><ul class="list">${rows}</ul></div>`);
    }
    $('recentGroups').innerHTML = html.length ? html.join('') : '<p class="empty">아직 기록이 없어요.</p>';
  }
  function onLaterAction(e) {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const ev = data.events.find((x) => x.id === li.dataset.id);
    if (!ev) return;
    const act = e.target.dataset.act;
    if (act === 'done') ev.laterDone = e.target.checked;
    else if (act === 'unkeep') ev.keepForLater = false;
    else if (act === 'edit') { openSheet(ev, false); return; }
    else return;
    touch(ev);
    persist();
    renderLater();
  }
  ['laterList', 'laterDoneList', 'recentGroups'].forEach((id) => {
    $(id).addEventListener('change', (e) => { if (e.target.dataset.act === 'done') onLaterAction(e); });
    $(id).addEventListener('click', (e) => { if (e.target.dataset.act === 'unkeep' || e.target.dataset.act === 'edit') onLaterAction(e); });
  });

  // ───────── 렌더: 패턴 ─────────
  $('demoBtn').addEventListener('click', () => { ui.demo = S.generateDemoData(Date.now()); const n = new Date(); n.setDate(0); ui.viewYear = n.getFullYear(); ui.viewMonth = n.getMonth(); renderPattern(); });
  $('demoExit').addEventListener('click', () => { ui.demo = null; ui.viewYear = new Date().getFullYear(); ui.viewMonth = new Date().getMonth(); renderPattern(); });
  $('prevMonth').addEventListener('click', () => shiftMonth(-1));
  $('nextMonth').addEventListener('click', () => shiftMonth(1));
  $('prevYear').addEventListener('click', () => { ui.yearView -= 1; renderPattern(); });
  $('nextYear').addEventListener('click', () => { ui.yearView += 1; renderPattern(); });
  document.querySelectorAll('[data-hour-mode]').forEach((b) => b.addEventListener('click', () => {
    ui.hourMode = b.dataset.hourMode;
    document.querySelectorAll('[data-hour-mode]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    renderPattern();
  }));
  function shiftMonth(d) {
    const dt = new Date(ui.viewYear, ui.viewMonth + d, 1);
    ui.viewYear = dt.getFullYear();
    ui.viewMonth = dt.getMonth();
    renderPattern();
  }

  const bar = (label, value, max, right, title) => `<div class="bar-row" title="${esc(title || '')}"><span class="bl">${label}</span>
    <span class="track"><span class="fill" style="width:${max ? Math.round((value / max) * 100) : 0}%"></span></span><span class="n">${right}</span></div>`;

  function renderPattern() {
    const src = ui.demo || data;
    const r = S.buildReport(src);
    const suf = r.sufficiency;
    $('demoNotice').hidden = !ui.demo;
    $('sufficiencyCard').hidden = !!ui.demo || suf.canInsight;
    if (!suf.canInsight && !ui.demo) {
      $('sufficiencyText').textContent = `기록 ${suf.events}/${suf.needEvents}개, 기록한 날 ${suf.days}/${suf.needDays}일. 이만큼 모이기 전에는 패턴을 해석하지 않아요. 아래 숫자는 참고만 하세요.`;
      $('sufficiencyBar').style.width = `${Math.round(suf.progress * 100)}%`;
    }

    const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('kpis').innerHTML = [
      kpi(r.total, '총 기록'),
      kpi(suf.days, '기록한 날'),
      kpi(r.ratePerHour == null ? '—' : `${r.ratePerHour.toFixed(1)}회`, r.ratePerHour == null ? '세션 1시간당 (종료한 세션 1시간 이상 필요)' : `세션 1시간당 (세션 ${r.reliableCount}개 기준)`),
      kpi(r.medianGapMs == null ? '—' : S.fmtDur(r.medianGapMs), '기록 사이 간격 (중앙값)'),
    ].join('');

    $('insightCard').hidden = !suf.canInsight;
    $('insights').innerHTML = r.insights.length
      ? r.insights.map((i) => `<div class="insight"><p class="fact">${esc(i.fact)}</p><p class="limit"><b>단, </b>${esc(i.limit)}</p><p class="try"><b>해 볼 것 </b>${esc(i.try)}</p></div>`).join('')
      : '<p class="muted small">지금 기록에서는 뚜렷하게 말할 수 있는 패턴이 없어요.</p>';

    // 월 캘린더 (무드트래커 스타일)
    const y = ui.viewYear;
    const mo = ui.viewMonth;
    $('monthTitle').textContent = `${y}년 ${mo + 1}월`;
    const daily = S.dailyCounts(src.events);
    const first = new Date(y, mo, 1).getDay();
    const dim = new Date(y, mo + 1, 0).getDate();
    const todayKey = S.dateKey(Date.now());
    let cal = S.WEEKDAYS.map((w) => `<div class="cal-h" role="columnheader">${w}</div>`).join('');
    for (let i = 0; i < first; i++) cal += '<div class="cal-cell void"></div>';
    for (let d = 1; d <= dim; d++) {
      const k = S.dateKey(new Date(y, mo, d).getTime());
      const c = daily[k] || 0;
      cal += `<div class="cal-cell c${S.countLevel(c)}${k === todayKey ? ' today' : ''}" role="gridcell" aria-label="${mo + 1}월 ${d}일 기록 ${c}개" title="${mo + 1}/${d} · 기록 ${c}개"><span class="cal-d">${d}</span>${c ? `<span class="cal-n">${c}</span>` : ''}</div>`;
    }
    $('calendar').innerHTML = cal;
    const mx = S.monthHourMatrix(src.events, y, mo);
    let hm = '<div></div>';
    for (let h = 0; h < 24; h++) hm += `<div class="h">${h % 3 === 0 ? h : ''}</div>`;
    mx.forEach((row, i) => {
      hm += `<div class="d">${i + 1}</div>`;
      row.forEach((c, h) => { hm += `<div class="cell c${S.countLevel(c)}" title="${mo + 1}/${i + 1} ${h}시 · ${c}개"></div>`; });
    });
    $('monthGrid').innerHTML = hm;
    $('countLegend').innerHTML = ['0', '1', '2–3', '4–6', '7+'].map((l, i) => `<span><i class="c${i}"></i>${l}개</span>`).join('') + '<span class="muted">· 색은 기록 수일 뿐, 좋고 나쁨이 아니에요</span>';

    // 시간대
    const useRate = ui.hourMode === 'rate';
    const vals = r.hours.map((h) => (useRate ? h.rate : h.count));
    const maxV = Math.max(0.0001, ...vals.map((v) => v || 0));
    $('hourBars').innerHTML = r.hours.map((h, i) => {
      const v = vals[i];
      const t = useRate ? (v == null ? `${h.hour}시 · 세션 노출 1시간 미만` : `${h.hour}시 · ${v.toFixed(1)}회/시간`) : `${h.hour}시 · ${h.count}개`;
      return `<div class="col" title="${t}"><div class="bar ${v == null ? 'na' : ''}" style="height:${v == null ? 2 : Math.max(2, (v / maxV) * 100)}%"></div><div class="lbl">${h.hour % 3 === 0 ? h.hour : ''}</div></div>`;
    }).join('');
    $('hourNote').textContent = useRate
      ? '종료한 세션(5분~6시간)이 그 시간대에 1시간 이상 쌓인 경우에만 비율을 보여 줘요. 회색은 데이터 부족이에요.'
      : '세션을 많이 한 시간대는 횟수가 많아 보일 수 있어요. "세션 1시간당"으로 바꿔 비교해 보세요.';

    // 간격
    const maxG = Math.max(1, ...r.gapHist.map((b) => b.count));
    $('gapBars').innerHTML = r.gapCount
      ? r.gapHist.map((b) => bar(esc(b.label), b.count, maxG, `${b.count}`)).join('') + `<p class="muted small">5분 이내 간격은 연쇄일 수도, 따로 일어난 이탈일 수도 있어요.</p>`
      : '<p class="muted small">간격을 계산하려면 같은 세션(또는 같은 날)에 기록이 2개 이상 필요해요.</p>';

    // 세션별
    const list = r.sessions.slice(0, 12);
    $('sessionList').innerHTML = list.length ? list.map((s) => {
      const tt = S.metaOf(S.TASK_TYPES, s.taskType);
      const rate = s.active ? '진행 중' : s.reliable ? `${s.rate.toFixed(1)}회/시간` : '<span class="muted" title="종료 시각이 불확실하거나 너무 짧거나 길어서 비율에서 제외">비율 제외</span>';
      return `<li><span class="txt">${tt ? tt.emoji + ' ' : ''}${esc(s.task || (tt ? tt.label : '세션'))} <span class="muted small">${mdhm(s.startAt)} · ${S.fmtDur(s.durMs)}</span></span><span class="meta">${s.count}개 · ${rate}</span></li>`;
    }).join('') : '<li class="empty">세션 기록이 없어요.</li>';

    // 태그
    const tagBars = (tc, metaList) => {
      if (!tc.items.length) return `<p class="muted small">아직 적은 태그가 없어요(미기록 ${tc.missing}개).</p>`;
      const m = Math.max(...tc.items.map((x) => x.count));
      return tc.items.map((x) => bar(esc(S.tagLabel(metaList, x.id)), x.count, m, `${x.count}`)).join('') + `<p class="muted small">태그 없는 기록 ${tc.missing}개는 제외했어요.</p>`;
    };
    $('activityBars').innerHTML = tagBars(r.activities, S.ACTIVITIES);
    $('triggerBars').innerHTML = tagBars(r.triggers, S.TRIGGERS);

    // 주별
    const maxW = Math.max(1, ...r.weekly.map((w) => w.count));
    $('weekBars').innerHTML = r.weekly.map((w) => {
      const d = new Date(w.weekStart);
      return `<div class="col" title="${d.getMonth() + 1}/${d.getDate()} 주 · ${w.count}개"><span class="wv">${w.count}</span><div class="bar" style="height:${(w.count / maxW) * 70}%"></div><span class="wl">${d.getMonth() + 1}/${d.getDate()}</span><span class="wr">${w.rate == null ? '—' : w.rate.toFixed(1)}</span></div>`;
    }).join('');

    // 연간
    const Y = ui.yearView;
    $('yearTitle').textContent = `${Y}년`;
    let yh = '<div></div>';
    for (let m = 0; m < 12; m++) yh += `<div class="h">${m + 1}</div>`;
    for (let d = 1; d <= 31; d++) {
      yh += `<div class="d">${d}</div>`;
      for (let m = 0; m < 12; m++) {
        if (d > new Date(Y, m + 1, 0).getDate()) { yh += '<div class="cell void"></div>'; continue; }
        const k = S.dateKey(new Date(Y, m, d).getTime());
        const c = daily[k] || 0;
        yh += `<div class="cell c${S.countLevel(c)}${k === todayKey ? ' today' : ''}" title="${m + 1}/${d} · ${c}개"></div>`;
      }
    }
    $('yearGrid').innerHTML = yh;
  }

  // ───────── 렌더: 데이터 ─────────
  async function renderData() {
    const info = [];
    info.push(`기록 ${data.events.length}개 · 세션 ${data.sessions.length}개`);
    try {
      if (navigator.storage && navigator.storage.persisted) {
        const p = await navigator.storage.persisted();
        info.push(p ? '저장소 보호: 켜짐' : '저장소 보호: 꺼짐(브라우저가 공간이 부족하면 지울 수 있음)');
      }
    } catch (e) { /* 지원 안 함 */ }
    $('storageInfo').textContent = info.join(' · ');
  }
  $('persistBtn').addEventListener('click', async () => {
    try {
      if (!navigator.storage || !navigator.storage.persist) throw new Error('unsupported');
      const ok = await navigator.storage.persist();
      alert(ok ? '저장소 보호가 켜졌어요.' : '브라우저가 요청을 거절했어요. 홈 화면에 설치하거나 자주 방문하면 허용될 수 있어요.');
    } catch (e) {
      alert('이 브라우저는 저장소 보호 요청을 지원하지 않아요.');
    }
    renderData();
  });

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  const stamp = () => S.dateKey(Date.now());
  $('exportJson').addEventListener('click', () => download(`focus-backup-${stamp()}.json`, Store.toJSON(data), 'application/json'));
  $('exportCsv').addEventListener('click', () => download(`focus-log-${stamp()}.csv`, Store.toCSV(data), 'text/csv;charset=utf-8'));

  let pendingImport = null;
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const parsed = Store.parseImport(await f.text());
      pendingImport = parsed.data;
      $('importSummary').textContent = `파일에서 기록 ${parsed.data.events.length}개, 세션 ${parsed.data.sessions.length}개를 찾았어요${parsed.dropped ? ` (형식이 맞지 않는 기록 ${parsed.dropped}개 제외)` : ''}. 어떻게 할까요?`;
      $('importPanel').hidden = false;
    } catch (err) {
      pendingImport = null;
      $('importSummary').textContent = '가져오기 실패: ' + err.message;
      $('importPanel').hidden = false;
    }
  });
  $('importMerge').addEventListener('click', () => {
    if (!pendingImport) return;
    const r = Store.merge(data, pendingImport);
    data = r.data;
    persist();
    pendingImport = null;
    $('importPanel').hidden = true;
    renderAll();
    alert(`병합했어요. 새 기록 ${r.addedEvents}개, 갱신 ${r.updatedEvents}개.`);
  });
  $('importReplace').addEventListener('click', () => {
    if (!pendingImport) return;
    if (!confirm(`현재 기록 ${data.events.length}개를 지우고 파일 내용으로 바꿀까요? 되돌릴 수 없어요.`)) return;
    data = pendingImport;
    persist();
    pendingImport = null;
    $('importPanel').hidden = true;
    renderAll();
  });
  $('importCancel').addEventListener('click', () => { pendingImport = null; $('importPanel').hidden = true; });

  $('clearBtn').addEventListener('click', () => { $('clearPanel').hidden = false; $('clearInput').value = ''; $('clearInput').focus(); });
  $('clearCancel').addEventListener('click', () => { $('clearPanel').hidden = true; });
  $('clearPanel').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('clearInput').value.trim() !== '삭제') { $('clearInput').focus(); return; }
    Store.clearAll(backend());
    data = Store.empty();
    persist();
    $('clearPanel').hidden = true;
    renderAll();
    alert('모든 기록을 삭제했어요.');
  });

  // ───────── 전체 렌더 ─────────
  function renderTab() {
    if (activeSession() && ui.tab !== 'now') return; // 잠금 중엔 그리지 않음
    if (ui.tab === 'later') renderLater();
    else if (ui.tab === 'pattern') renderPattern();
    else if (ui.tab === 'data') renderData();
  }
  function renderAll() {
    applyLock();
    renderNow();
    renderDatalists();
    renderTab();
  }

  // 다른 탭/창에서 바뀌면 동기화
  window.addEventListener('storage', (e) => {
    if (e.key !== Store.KEY || !storage) return;
    data = Store.load(storage).data;
    renderAll();
  });

  renderAll();
  if (notices.length) showStatusMessage(notices.join(' '), 8000);

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
