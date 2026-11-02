/* app.js — UI. 원칙: "앱에 머무르게 하는가?"가 아니라 "원래 하던 일로 빨리 돌아가게 하는가?" */
(function () {
  'use strict';
  const S = window.FocusStats;
  const Store = window.FocusStore;

  const STATUS_MS = 6000; // 기록 후 상태 영역 표시 시간
  const DEBOUNCE_MS = 800; // 같은 손가락의 중복 클릭 방지 (그 뒤 연속 기록은 허용)
  const SHEET_IDLE_MS = 30000; // 상세 시트에서 입력이 없으면 자동으로 닫힘
  const THOUGHT_IDLE_MS = 30000; // 생각 입력이 30초 동안 없으면 접힘 (입력 내용은 이미 자동 저장됨)
  const DRAFT_SAVE_MS = 400; // 생각 입력 자동 저장 지연
  const FALLBACK_ACTION = '하던 일의 다음 한 단계';

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
  if (!data.settings) data.settings = { experiment: null };
  // 손상된 v2 원본: 사용자가 결정하기 전까지 절대 덮어쓰지 않는다
  let corruptInfo = loaded.corrupt || null;
  let writeBlocked = !!(corruptInfo && corruptInfo.blocksWrites);
  let v1NoticeOpen = !!(corruptInfo && !corruptInfo.blocksWrites);
  let lastPersistOk = !!storage && !loaded.unavailable;
  const notices = [];

  if (loaded.dropped > 0) {
    // 읽을 수 없는 항목은 다음 저장 때 빠지므로, 원문을 먼저 따로 보관
    let raw = null;
    try { raw = backend().getItem(Store.KEY) || backend().getItem(Store.KEY_V1); } catch (e) { raw = null; }
    const k = raw ? Store.quarantine(backend(), raw) : null;
    notices.push(`읽을 수 없는 항목 ${loaded.dropped}개를 건너뛰었어요.${k ? ' 원본은 따로 보관했어요.' : ''}`);
  }
  if (loaded.migratedFromV1) notices.push(`이전 버전 기록 ${data.events.length}개를 새 형식으로 옮겼어요. 원본도 브라우저에 그대로 남아 있어요.`);
  const stale = Store.closeStaleSessions(data);
  if (stale) notices.push(`12시간 넘게 열려 있던 세션을 닫았어요. 종료 시각을 알 수 없어 시간당 비율 계산에서는 빠져요.`);

  /** 영구 저장. 반환값이 실제 저장 결과이며, 모든 "저장됨" 표시는 이 값을 따른다 */
  function persist() {
    if (writeBlocked) {
      lastPersistOk = false;
    } else {
      lastPersistOk = !!storage && Store.save(storage, data);
    }
    updateBanner();
    return lastPersistOk;
  }
  if ((loaded.migratedFromV1 || stale || loaded.dropped > 0) && !writeBlocked) persist();

  // ───────── 배너 (집중 잠금과 무관하게 항상 접근 가능) ─────────
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
  const backupNow = () => download(`focus-backup-${stamp()}.json`, Store.toJSON(data), 'application/json');

  function updateBanner() {
    const b = $('banner');
    const actions = [];
    let text = '';
    if (writeBlocked) {
      text = '저장된 기록을 읽을 수 없어서, 원본을 덮어쓰지 않도록 저장을 멈췄어요. 지금 남기는 기록은 이 창에만 있어요.';
      actions.push(['bnRaw', '손상 원본 내려받기'], ['bnRecover', '백업 파일로 복구'], ['bnFresh', '원본 보관하고 새로 시작']);
      if (data.events.length) actions.push(['bnBackup', '지금 기록 JSON 백업']);
    } else if (!lastPersistOk) {
      text = storage
        ? '저장하지 못했어요(저장 공간 부족 또는 브라우저 설정). 방금 기록은 이 창을 닫으면 사라질 수 있어요.'
        : '브라우저 저장소를 쓸 수 없어요(시크릿 창 등). 기록은 이 창을 닫으면 사라져요.';
      actions.push(['bnBackup', '지금 JSON 백업']);
    } else if (v1NoticeOpen) {
      text = '이전 버전 기록을 읽을 수 없었어요. 원본은 지우지 않고 그대로 남겨 뒀어요.';
      actions.push(['bnRaw', '원본 내려받기'], ['bnDismiss', '닫기']);
    }
    b.hidden = !text;
    $('bannerText').textContent = text;
    $('bannerActions').innerHTML = actions.map(([id, label]) => `<button type="button" class="btn sm" data-bn="${id}">${esc(label)}</button>`).join('');
  }
  $('bannerActions').addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.bn;
    if (!id) return;
    if (id === 'bnBackup') backupNow();
    else if (id === 'bnRaw' && corruptInfo) download(`focus-original-unreadable-${stamp()}.txt`, corruptInfo.raw, 'text/plain');
    else if (id === 'bnRecover') $('recoverFile').click();
    else if (id === 'bnFresh') {
      if (!releaseCorrupt()) return;
      persist();
      renderAll();
    } else if (id === 'bnDismiss') { v1NoticeOpen = false; updateBanner(); }
  });
  /** 손상 원본을 별도 키에 보관하고 쓰기 차단을 푼다. 보관 실패 시 사용자 확인 필요 */
  function releaseCorrupt() {
    if (!writeBlocked) return true;
    const k = Store.quarantine(backend(), corruptInfo.raw);
    if (!k && !confirm('손상된 원본을 따로 보관하지 못했어요. "손상 원본 내려받기"로 먼저 저장하지 않았다면 원본이 사라져요. 계속할까요?')) return false;
    writeBlocked = false;
    corruptInfo = null;
    return true;
  }
  $('recoverFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const parsed = Store.parseImport(await f.text());
      if (!confirm(`백업에서 기록 ${parsed.data.events.length}개를 복구할까요? 지금 이 창에서 남긴 기록도 함께 합쳐요.`)) return;
      if (!releaseCorrupt()) return;
      data = Store.merge(parsed.data, data).data;
      data.settings = parsed.data.settings || data.settings;
      persist();
      renderAll();
    } catch (err) {
      alert('복구 실패: ' + err.message);
    }
  });

  // ───────── UI 상태 ─────────
  const ui = { tab: 'now', home: 'start', reviewSessionId: null, taskType: null, viewYear: new Date().getFullYear(), viewMonth: new Date().getMonth(), yearView: new Date().getFullYear(), hourMode: 'count', demo: null };
  const activeSession = () => (data.activeSessionId ? data.sessions.find((s) => s.id === data.activeSessionId) || null : null);
  const touch = (o) => { o.updatedAt = Date.now(); };
  const actionText = (s) => (s && (s.nextAction || [s.task, s.location].filter(Boolean).join(' · '))) || FALLBACK_ACTION;

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
    // 집중 중에는 탭 자체를 숨기고(압축 화면), 다른 패널도 잠근다. "집중 마치기"로 언제든 해제.
    $('tabs').hidden = locked;
    ['later', 'pattern', 'data'].forEach((id) => $(`tab-${id}`).classList.toggle('locked', locked));
    if (locked && ui.tab !== 'now') switchTab('now');
  }

  // ───────── 칩 / 최근 입력 ─────────
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

  // ───────── 01 세션 시작 ─────────
  $('taskTypeChips').innerHTML = chipsHtml(S.TASK_TYPES, null, 'tt');
  $('taskTypeChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    ui.taskType = ui.taskType === c.dataset.tt ? null : c.dataset.tt;
    setPressed($('taskTypeChips'), 'tt', ui.taskType);
  });
  $('nextActionInput').addEventListener('input', () => { $('startHint').hidden = true; });

  function beginSession(fields) {
    const exp = data.settings.experiment;
    const s = Store.newSession({ ...fields, experimentId: exp ? exp.id : null });
    data.sessions.push(s);
    data.activeSessionId = s.id;
    persist();
    ui.home = 'start';
    hideStatus();
    renderAll();
    $('oopsBtn').focus();
  }

  $('startForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const nextAction = $('nextActionInput').value.trim();
    if (!nextAction) {
      // 유령 세션을 만들지 않는다
      $('startHint').hidden = false;
      $('nextActionInput').focus();
      return;
    }
    const task = $('taskInput').value.trim();
    beginSession({ taskType: ui.taskType || Store.inferTaskType(task), task, location: $('locationInput').value.trim(), nextAction });
    ['taskInput', 'locationInput', 'nextActionInput'].forEach((id) => { $(id).value = ''; });
    ui.taskType = null;
    setPressed($('taskTypeChips'), 'tt', null);
    $('startMore').open = false;
  });

  function lastSession() {
    return [...data.sessions].filter((s) => s.endAt != null && (s.nextAction || s.task)).sort((a, b) => b.startAt - a.startAt)[0] || null;
  }
  $('resumeBtn').addEventListener('click', () => {
    const p = lastSession();
    if (!p) return;
    // 종료된 세션을 되살리지 않고, 기준점만 재사용하는 새 세션을 만든다
    beginSession({ taskType: p.taskType, task: p.task, location: p.location, nextAction: p.nextAction });
  });

  $('expStartClear').addEventListener('click', () => {
    data.settings.experiment = null;
    persist();
    renderNow();
  });

  // ───────── 02 집중 ─────────
  $('editActionBtn').addEventListener('click', () => {
    const s = activeSession();
    if (!s) return;
    $('editNextAction').value = s.nextAction;
    $('actionEdit').hidden = false;
    $('focusAction').hidden = true;
    $('editNextAction').focus();
  });
  function closeActionEdit() {
    $('actionEdit').hidden = true;
    $('focusAction').hidden = false;
  }
  $('actionEditCancel').addEventListener('click', () => { closeActionEdit(); $('editActionBtn').focus(); });
  $('actionEdit').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = activeSession();
    if (!s) return;
    s.nextAction = $('editNextAction').value.trim();
    touch(s);
    persist();
    closeActionEdit();
    renderNow();
    $('oopsBtn').focus();
  });

  $('endBtn').addEventListener('click', () => {
    const s = activeSession();
    if (!s) return;
    if (draft) commitThought();
    s.endAt = Date.now();
    s.endReason = 'manual';
    touch(s);
    data.activeSessionId = null;
    persist();
    closeActionEdit();
    hideStatus();
    ui.home = 'review';
    ui.reviewSessionId = s.id;
    renderAll();
    $('reviewTitle').focus();
  });

  // ───────── 원탭 기록 ─────────
  let lastTapAt = 0;
  let lastEvent = null;
  $('oopsBtn').addEventListener('click', record);
  $('quickRecordBtn').addEventListener('click', record);

  function record() {
    const now = Date.now();
    if (now - lastTapAt < DEBOUNCE_MS) return; // 중복 클릭 무시
    lastTapAt = now;
    if (sheet.open) closeSheet(false);
    if (draft) commitThought();
    const ev = Store.newEvent(activeSession(), now);
    data.events.push(ev);
    const ok = persist();
    lastEvent = ev;
    flashButton(ok);
    showRecorded(ev, ok);
  }

  let flashTimer = 0;
  function flashButton(ok) {
    const focus = !!activeSession();
    const b = focus ? $('oopsBtn') : $('quickRecordBtn');
    b.classList.add('done');
    b.setAttribute('aria-disabled', 'true');
    if (focus) $('oopsSub').textContent = ok ? '✓ 기록했어요' : '⚠ 이 창에만 기록됨';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      [$('oopsBtn'), $('quickRecordBtn')].forEach((x) => { x.classList.remove('done'); x.removeAttribute('aria-disabled'); });
      $('oopsSub').textContent = '지금 알아차렸어요';
    }, DEBOUNCE_MS);
  }

  // ───────── 상태 영역 ─────────
  let statusTimer = 0;
  const guideText = () => (activeSession() ? '위의 첫 행동부터 이어가세요.' : `${FALLBACK_ACTION}로 돌아가세요.`);
  function placeStatus() {
    const target = activeSession() ? $('slotFocus') : $('slotStart');
    if ($('status').parentNode !== target) target.appendChild($('status'));
  }
  function showRecorded(ev, ok) {
    placeStatus();
    $('statusSaved').textContent = ok ? `${hhmm(ev.ts)} 기록했어요` : `⚠ ${hhmm(ev.ts)} 이 창에만 기록했어요(저장 실패)`;
    $('statusSaved').classList.toggle('warn', !ok);
    $('statusGuide').textContent = guideText();
    $('statusActions').hidden = false;
    $('thoughtForm').hidden = true;
    $('status').hidden = false;
    scheduleStatusHide(STATUS_MS);
  }
  function showStatusMessage(msg, withGuide, ms) {
    placeStatus();
    $('statusSaved').textContent = msg;
    $('statusSaved').classList.toggle('warn', msg.startsWith('⚠'));
    $('statusGuide').textContent = withGuide ? guideText() : '';
    $('statusActions').hidden = true;
    $('thoughtForm').hidden = true;
    $('status').hidden = false;
    scheduleStatusHide(ms || 3500);
  }
  function scheduleStatusHide(ms) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (draft) {
        const r = commitThought();
        if (!r.ok) return; // 저장 실패 시 입력을 유지(사라지게 하지 않음)
      }
      hideStatus();
    }, ms);
  }
  function hideStatus() {
    clearTimeout(statusTimer);
    $('status').hidden = true;
    lastEvent = null;
  }

  $('undoBtn').addEventListener('click', () => {
    if (!lastEvent) return;
    const id = lastEvent.id;
    draft = null;
    data.events = data.events.filter((e) => e.id !== id);
    const ok = persist();
    lastEvent = null;
    showStatusMessage(ok ? '기록을 취소했어요' : '⚠ 기록을 취소했지만 저장하지 못했어요', false, 2500);
  });

  // ───────── 생각 한 줄 맡기기 (입력 즉시 자동 저장) ─────────
  let draft = null; // { eventId, prevKeep, timer, ok }
  $('thoughtBtn').addEventListener('click', () => {
    if (!lastEvent) return;
    const ev = data.events.find((x) => x.id === lastEvent.id);
    if (!ev) return;
    draft = { eventId: ev.id, prevKeep: ev.keepForLater, timer: 0, ok: true };
    $('thoughtSaveNote').classList.remove('warn');
    $('thoughtInput').value = ev.thought || '';
    $('thoughtSaveNote').textContent = '입력하면 바로 저장돼요.';
    $('statusActions').hidden = true;
    $('thoughtForm').hidden = false;
    $('thoughtInput').focus();
    scheduleStatusHide(THOUGHT_IDLE_MS);
  });
  $('thoughtInput').addEventListener('input', () => {
    scheduleStatusHide(THOUGHT_IDLE_MS);
    if (!draft) return;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(saveDraft, DRAFT_SAVE_MS);
  });
  /** 입력 중인 생각을 이벤트에 저장. 실제 영구 저장 결과를 반환 */
  function saveDraft() {
    if (!draft) return true;
    clearTimeout(draft.timer);
    const ev = data.events.find((x) => x.id === draft.eventId);
    if (!ev) return true;
    const t = $('thoughtInput').value.trim();
    if (ev.thought !== t || draft.ok === false) {
      ev.thought = t;
      ev.keepForLater = t ? true : draft.prevKeep;
      touch(ev);
      draft.ok = persist();
    }
    $('thoughtSaveNote').textContent = draft.ok
      ? (t ? '자동 저장됨' : '')
      : '⚠ 저장하지 못했어요. 입력은 그대로 두었어요. 위 배너에서 백업할 수 있어요.';
    $('thoughtSaveNote').classList.toggle('warn', !draft.ok);
    return draft.ok;
  }
  /** 생각 입력을 마무리. 저장 실패면 입력을 유지하고 ok:false */
  function commitThought() {
    if (!draft) return { had: false, ok: true };
    const had = !!$('thoughtInput').value.trim();
    const ok = saveDraft();
    if (!ok) {
      $('thoughtForm').hidden = false;
      return { had, ok: false };
    }
    draft = null;
    $('thoughtForm').hidden = true;
    renderDatalists();
    return { had, ok: true };
  }
  $('thoughtForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const r = commitThought();
    if (!r.ok) { $('thoughtInput').focus(); return; }
    if (r.had) showStatusMessage('맡겼어요 · 보관함에 있어요', true, 3000);
    else hideStatus();
    if (activeSession()) $('oopsBtn').focus();
  });
  // 창을 닫거나 다른 앱으로 갈 때도 입력 중인 생각을 저장 (이것만 믿지 않고 입력 즉시 자동 저장도 함)
  const flush = () => { if (draft) saveDraft(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

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
      showStatusMessage(lastPersistOk ? '✓ 저장했어요' : '⚠ 이 창에만 있어요(저장 실패)', true, 3000);
      if (activeSession()) $('oopsBtn').focus();
    } else {
      renderTab();
      if (sheet.opener && document.contains(sheet.opener)) sheet.opener.focus();
    }
  }

  // ───────── 키보드 ─────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (sheet.open) { closeSheet(true); return; }
      if (!$('actionEdit').hidden) { closeActionEdit(); return; }
      if (draft) { const r = commitThought(); if (r.ok) hideStatus(); return; }
    }
    if (sheet.open || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || e.target.isContentEditable) return;
    if (ui.tab !== 'now' || (!activeSession() && ui.home !== 'start')) return;
    if (e.key === 'a' || e.key === 'A' || e.key === 'ㅁ') { e.preventDefault(); record(); }
  });

  // ───────── 렌더: 지금 (시작 / 집중 / 돌아보기 / 종료) ─────────
  function renderNow() {
    const s = activeSession();
    const screen = s ? 'focus' : ui.home;
    $('screenStart').hidden = screen !== 'start';
    $('screenFocus').hidden = screen !== 'focus';
    $('screenReview').hidden = screen !== 'review';
    $('screenDone').hidden = screen !== 'done';
    $('stateLabel').textContent = { start: '시작 전', focus: '집중 중', review: '돌아보기', done: '오늘은 여기까지' }[screen];
    placeStatus();
    const exp = data.settings.experiment;

    if (screen === 'start') {
      const p = lastSession();
      $('resumeBtn').hidden = !p;
      if (p) $('resumeText').textContent = p.nextAction || p.task;
      $('expStart').hidden = !exp;
      if (exp) $('expStartText').textContent = exp.text;
    }
    if (screen === 'focus') {
      $('focusAction').textContent = actionText(s);
      const showExp = !!(exp && s.experimentId && exp.id === s.experimentId);
      $('expFocus').hidden = !showExp;
      if (showExp) $('expFocusText').textContent = exp.text;
    }
    if (screen === 'review') renderReview();
    if (screen === 'done') {
      $('doneText').textContent = lastPersistOk && !writeBlocked
        ? '기록은 이 브라우저에 저장돼 있어요. 이 탭은 직접 닫아도 괜찮아요.'
        : '⚠ 일부 기록이 아직 저장되지 않았어요. 위 안내에서 JSON 백업을 받아 두세요.';
    }
  }

  // ───────── 03 짧은 돌아보기 (항상 내 데이터만 사용, 예시 데이터와 섞지 않음) ─────────
  let reviewInsight = null;
  function renderReview() {
    const s = ui.reviewSessionId ? data.sessions.find((x) => x.id === ui.reviewSessionId) : null;
    if (s && s.endAt) {
      const n = data.events.filter((e) => e.sessionId === s.id).length;
      $('reviewSummary').textContent = `이번 집중 ${S.fmtDur(s.endAt - s.startAt)} · 기록 ${n}개`;
    } else $('reviewSummary').textContent = '';

    $('reviewDays').innerHTML = S.recentDays(data.events, Date.now(), 7).map((d) =>
      `<li class="${d.count ? 'has' : 'none'}"><span class="dd">${d.month}/${d.day}</span><span class="dw">${d.weekday}</span><span class="dc">${d.count ? `${d.count}번` : '미기록'}</span></li>`).join('');

    reviewInsight = S.pickInsight(S.buildReport(data));
    $('reviewObserving').hidden = !!reviewInsight;
    $('reviewInsight').hidden = !reviewInsight;
    $('reviewExperiment').hidden = !reviewInsight;
    if (reviewInsight) {
      $('riFact').textContent = reviewInsight.fact;
      $('riLimit').textContent = reviewInsight.limit;
      $('reText').textContent = reviewInsight.experiment.text;
      const chosen = !!(data.settings.experiment && data.settings.experiment.id === reviewInsight.experiment.id);
      $('reChoose').textContent = chosen ? '✓ 다음 세션에서 해볼게요 (취소)' : '다음 세션에서 해보기';
      $('reChoose').setAttribute('aria-pressed', chosen ? 'true' : 'false');
      $('reChosen').hidden = !chosen;
    }

    const later = data.events.filter((e) => e.keepForLater && !e.laterDone).sort((a, b) => b.ts - a.ts);
    $('reviewLaterCount').textContent = later.length ? `${later.length}개` : '';
    $('reviewLater').innerHTML = later.length ? later.map(laterItem).join('') : '<li class="empty">맡겨둔 생각이 없어요.</li>';
  }
  $('reChoose').addEventListener('click', () => {
    if (!reviewInsight) return;
    const cur = data.settings.experiment;
    data.settings.experiment = cur && cur.id === reviewInsight.experiment.id
      ? null
      : { id: reviewInsight.experiment.id, text: reviewInsight.experiment.text, chosenAt: Date.now() };
    persist();
    renderReview();
  });
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('reviewBackup').addEventListener('click', backupNow);
  $('nextFocusBtn').addEventListener('click', () => { ui.home = 'start'; renderNow(); $('nextActionInput').focus(); });
  $('doneTodayBtn').addEventListener('click', () => { ui.home = 'done'; renderNow(); $('doneTitle').focus(); });
  $('restartBtn').addEventListener('click', () => { ui.home = 'start'; renderNow(); $('nextActionInput').focus(); });

  // ───────── 렌더: 보관함 ─────────
  function laterItem(e) {
    return `<li data-id="${e.id}" class="${e.laterDone ? 'done' : ''}">
        <input type="checkbox" data-act="done" ${e.laterDone ? 'checked' : ''} aria-label="확인함" />
        <span class="txt">${e.thought ? esc(e.thought) : esc(e.note) || '<span class="muted">(내용 없음)</span>'}</span>
        <span class="meta">${mdhm(e.ts)}</span>
        <button class="icon-btn" data-act="unkeep" aria-label="보관함에서 빼기" title="보관함에서 빼기">✕</button></li>`;
  }
  function renderLater() {
    const keeps = data.events.filter((e) => e.keepForLater).sort((a, b) => b.ts - a.ts);
    const open = keeps.filter((e) => !e.laterDone);
    const done = keeps.filter((e) => e.laterDone);
    $('laterList').innerHTML = open.length ? open.map(laterItem).join('') : '<li class="empty">보관한 생각이 없어요.</li>';
    $('laterDoneList').innerHTML = done.length ? done.map(laterItem).join('') : '<li class="empty">아직 없어요.</li>';

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
      const name = s ? (s.task || s.nextAction || (tt ? tt.label : '세션')) : '';
      const title = s ? `${tt ? tt.emoji + ' ' : ''}${esc(name)} <span class="muted small">${mdhm(s.startAt)}${s.endAt ? ' · ' + S.fmtDur(s.endAt - s.startAt) : ' · 진행 중'}</span>` : `세션 밖 기록 <span class="muted small">${esc(S.dateKey(evs[0].ts))}</span>`;
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
    if (ui.tab === 'later') renderLater();
    else renderReview();
  }
  ['laterList', 'laterDoneList', 'recentGroups', 'reviewLater'].forEach((id) => {
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

    const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('kpis').innerHTML = [
      kpi(r.total, '총 기록'),
      kpi(suf.days, '기록한 날'),
      kpi(r.ratePerHour == null ? '—' : `${r.ratePerHour.toFixed(1)}회`, r.ratePerHour == null ? '세션 1시간당 (마친 세션 1시간 이상 필요)' : `세션 1시간당 (세션 ${r.reliableCount}개 기준)`),
      kpi(r.medianGapMs == null ? '—' : S.fmtDur(r.medianGapMs), '기록 사이 간격 (중앙값)'),
    ].join('');

    $('insightCard').hidden = !suf.canInsight;
    $('insights').innerHTML = r.insights.length
      ? r.insights.map((i) => `<div class="insight"><p class="fact">${esc(i.fact)}</p><p class="limit"><b>단, </b>${esc(i.limit)}</p><p class="try"><b>해 볼 것 </b>${esc(i.try)}</p></div>`).join('')
      : '<p class="muted small">지금 기록에서는 뚜렷하게 말할 수 있는 패턴이 없어요.</p>';

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
      cal += `<div class="cal-cell c${S.countLevel(c)}${k === todayKey ? ' today' : ''}" role="gridcell" aria-label="${mo + 1}월 ${d}일 ${c ? `기록 ${c}개` : '미기록'}" title="${mo + 1}/${d} · ${c ? `기록 ${c}개` : '미기록'}"><span class="cal-d">${d}</span>${c ? `<span class="cal-n">${c}</span>` : ''}</div>`;
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
    $('countLegend').innerHTML = ['미기록', '1', '2–3', '4–6', '7+'].map((l, i) => `<span><i class="c${i}"></i>${i ? l + '개' : l}</span>`).join('') + '<span class="muted">· 색은 기록 수일 뿐, 좋고 나쁨이 아니에요</span>';

    const useRate = ui.hourMode === 'rate';
    const vals = r.hours.map((h) => (useRate ? h.rate : h.count));
    const maxV = Math.max(0.0001, ...vals.map((v) => v || 0));
    $('hourBars').innerHTML = r.hours.map((h, i) => {
      const v = vals[i];
      const t = useRate ? (v == null ? `${h.hour}시 · 세션 노출 1시간 미만` : `${h.hour}시 · ${v.toFixed(1)}회/시간`) : `${h.hour}시 · ${h.count}개`;
      return `<div class="col" title="${t}"><div class="bar ${v == null ? 'na' : ''}" style="height:${v == null ? 2 : Math.max(2, (v / maxV) * 100)}%"></div><div class="lbl">${h.hour % 3 === 0 ? h.hour : ''}</div></div>`;
    }).join('');
    $('hourNote').textContent = useRate
      ? '마친 세션(5분~6시간)이 그 시간대에 1시간 이상 쌓인 경우에만 비율을 보여 줘요. 회색은 데이터 부족이에요.'
      : '세션을 많이 한 시간대는 횟수가 많아 보일 수 있어요. "세션 1시간당"으로 바꿔 비교해 보세요.';

    const maxG = Math.max(1, ...r.gapHist.map((b) => b.count));
    $('gapBars').innerHTML = r.gapCount
      ? r.gapHist.map((b) => bar(esc(b.label), b.count, maxG, `${b.count}`)).join('') + '<p class="muted small">5분 이내 간격은 연쇄일 수도, 따로 일어난 이탈일 수도 있어요.</p>'
      : '<p class="muted small">간격을 계산하려면 같은 세션(또는 같은 날)에 기록이 2개 이상 필요해요.</p>';

    const list = r.sessions.slice(0, 12);
    $('sessionList').innerHTML = list.length ? list.map((s) => {
      const tt = S.metaOf(S.TASK_TYPES, s.taskType);
      const rate = s.active ? '진행 중' : s.reliable ? `${s.rate.toFixed(1)}회/시간` : '<span class="muted" title="종료 시각이 불확실하거나 너무 짧거나 길어서 비율에서 제외">비율 제외</span>';
      return `<li><span class="txt">${tt ? tt.emoji + ' ' : ''}${esc(s.task || (tt ? tt.label : '세션'))} <span class="muted small">${mdhm(s.startAt)} · ${S.fmtDur(s.durMs)}</span></span><span class="meta">${s.count}개 · ${rate}</span></li>`;
    }).join('') : '<li class="empty">세션 기록이 없어요.</li>';

    const tagBars = (tc, metaList) => {
      if (!tc.items.length) return `<p class="muted small">아직 적은 태그가 없어요(미기록 ${tc.missing}개).</p>`;
      const m = Math.max(...tc.items.map((x) => x.count));
      return tc.items.map((x) => bar(esc(S.tagLabel(metaList, x.id)), x.count, m, `${x.count}`)).join('') + `<p class="muted small">태그 없는 기록 ${tc.missing}개는 제외했어요.</p>`;
    };
    $('activityBars').innerHTML = tagBars(r.activities, S.ACTIVITIES);
    $('triggerBars').innerHTML = tagBars(r.triggers, S.TRIGGERS);

    const maxW = Math.max(1, ...r.weekly.map((w) => w.count));
    $('weekBars').innerHTML = r.weekly.map((w) => {
      const d = new Date(w.weekStart);
      return `<div class="col" title="${d.getMonth() + 1}/${d.getDate()} 주 · ${w.count}개"><span class="wv">${w.count}</span><div class="bar" style="height:${(w.count / maxW) * 70}%"></div><span class="wl">${d.getMonth() + 1}/${d.getDate()}</span><span class="wr">${w.rate == null ? '—' : w.rate.toFixed(1)}</span></div>`;
    }).join('');

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
        yh += `<div class="cell c${S.countLevel(c)}${k === todayKey ? ' today' : ''}" title="${m + 1}/${d} · ${c ? c + '개' : '미기록'}"></div>`;
      }
    }
    $('yearGrid').innerHTML = yh;
  }

  // ───────── 렌더: 데이터 ─────────
  async function renderData() {
    const info = [`기록 ${data.events.length}개 · 세션 ${data.sessions.length}개`];
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

  $('exportJson').addEventListener('click', backupNow);
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
    if (!pendingImport || !releaseCorrupt()) return;
    const r = Store.merge(data, pendingImport);
    data = r.data;
    const ok = persist();
    pendingImport = null;
    $('importPanel').hidden = true;
    renderAll();
    alert(ok ? `병합했어요. 새 기록 ${r.addedEvents}개, 갱신 ${r.updatedEvents}개.` : '병합했지만 저장하지 못했어요. 위 안내에서 백업해 주세요.');
  });
  $('importReplace').addEventListener('click', () => {
    if (!pendingImport) return;
    if (!confirm(`현재 기록 ${data.events.length}개를 지우고 파일 내용으로 바꿀까요? 되돌릴 수 없어요.`)) return;
    if (!releaseCorrupt()) return;
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
    writeBlocked = false; // 사용자가 명시적으로 전부 지웠으므로 손상 원본 보호도 해제
    corruptInfo = null;
    v1NoticeOpen = false;
    data = Store.empty();
    persist();
    $('clearPanel').hidden = true;
    ui.home = 'start';
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
    updateBanner();
  }

  // 다른 탭/창에서 바뀌면 동기화 (손상 보호 중에는 하지 않음)
  window.addEventListener('storage', (e) => {
    if (e.key !== Store.KEY || !storage || writeBlocked) return;
    const r = Store.load(storage);
    if (r.ok) { data = r.data; renderAll(); }
  });

  renderAll();
  if (notices.length) showStatusMessage(notices.join(' '), false, 8000);

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
})();
