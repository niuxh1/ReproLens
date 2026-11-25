const state = {
  project: null,
  events: [],
  after: 0,
  selectedClaims: new Set(),
  pollTimer: null,
  eventSource: null,
  toastTimer: null,
};

const stateLabels = {
  CREATED: '项目已创建',
  INITIALIZED: '工作区初始化',
  INGESTED: '论文与仓库已解析',
  AWAITING_CLAIMS: '等待选择主张',
  AWAITING_PLAN: '等待确认实验计划',
  SANDBOX_READY: '沙箱准备完成',
  EXECUTING: '实验执行中',
  AWAITING_PATCH: '等待补丁审批',
  RETRYING: '应用补丁后重试',
  VERIFYING: '规则核验中',
  REPORTING: '生成证据报告',
  COMPLETED: '复现闭环完成',
  FAILED: '执行失败',
  STOPPED: '已停止',
};

const pipelineSteps = [
  ['CREATED', 'INIT'],
  ['INGESTED', 'INGEST'],
  ['AWAITING_CLAIMS', 'CLAIMS'],
  ['AWAITING_PLAN', 'PLAN'],
  ['SANDBOX_READY', 'SANDBOX'],
  ['EXECUTING', 'EXECUTE'],
  ['VERIFYING', 'VERIFY'],
  ['REPORTING', 'REPORT'],
  ['COMPLETED', 'DONE'],
];

const stateIndex = {
  CREATED: 0, INITIALIZED: 0, INGESTED: 1, AWAITING_CLAIMS: 2,
  AWAITING_PLAN: 3, SANDBOX_READY: 4, EXECUTING: 5, AWAITING_PATCH: 5,
  RETRYING: 5, VERIFYING: 6, REPORTING: 7, COMPLETED: 8,
};

const terminalStates = new Set(['COMPLETED', 'FAILED', 'STOPPED']);
const runningStates = new Set(['EXECUTING', 'RETRYING', 'VERIFYING', 'REPORTING']);
const waitingStates = new Set(['AWAITING_CLAIMS', 'AWAITING_PLAN', 'AWAITING_PATCH', 'SANDBOX_READY']);

const $ = (id) => document.getElementById(id);

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortPath(value, max = 46) {
  if (!value) return '—';
  const text = String(value);
  return text.length > max ? '…' + text.slice(-(max - 1)) : text;
}

function stateDotClass(stateName) {
  if (runningStates.has(stateName)) return 'running';
  if (waitingStates.has(stateName)) return 'waiting';
  if (stateName === 'COMPLETED') return 'done';
  if (stateName === 'FAILED' || stateName === 'STOPPED') return 'failed';
  return '';
}

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

async function api(path, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  if (request.body !== undefined && request.body !== null) {
    request.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, request);
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: { message: text } }; }
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function setBusy(button, busy) {
  if (!button) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.textContent = busy ? '处理中…' : button.dataset.originalText;
  button.disabled = busy;
}

async function withAction(button, successMessage, fn) {
  try {
    setBusy(button, true);
    await fn();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(button, false);
    render();
  }
}

async function loadDemo() {
  await withAction($('load-demo'), '演示项目已载入', async () => {
    const project = await api('/api/v1/demo', { method: 'POST', body: '{}' });
    state.project = project;
    state.events = [];
    state.after = 0;
    state.selectedClaims = new Set();
    localStorage.setItem('reprolens.projectId', project.id);
    startEventStream();
    startPolling();
    await fetchEvents();
  });
}

async function startAnalysis() {
  await withAction($('start-analysis'), '解析完成，请选择要复现的主张', async () => {
    const project = await api(`/api/v1/projects/${state.project.id}/start`, { method: 'POST', body: '{}' });
    state.project = project;
    await fetchEvents();
  });
}

async function selectClaims() {
  const ids = Array.from(state.selectedClaims);
  if (ids.length === 0) {
    showToast('请至少选择一条主张', true);
    return;
  }
  await withAction($('select-claims'), '复现计划已生成', async () => {
    const project = await api(`/api/v1/projects/${state.project.id}/claims`, {
      method: 'POST', body: JSON.stringify({ claim_ids: ids }),
    });
    state.project = project;
    await fetchEvents();
  });
}

async function confirmPlan() {
  await withAction($('run-plan'), '执行已启动', async () => {
    const project = await api(`/api/v1/projects/${state.project.id}/plan/confirm`, { method: 'POST', body: '{}' });
    state.project = project;
    startPolling();
    await fetchEvents();
  });
}

async function approvePatch() {
  await withAction($('approve-patch'), '补丁已审批，正在重跑', async () => {
    const project = await api(`/api/v1/projects/${state.project.id}/patch/approve`, {
      method: 'POST', body: JSON.stringify({ approved_by: 'dashboard-user' }),
    });
    state.project = project;
    startPolling();
    await fetchEvents();
  });
}

async function rejectPatch() {
  await withAction($('reject-patch'), '补丁已拒绝', async () => {
    const project = await api(`/api/v1/projects/${state.project.id}/patch/reject`, {
      method: 'POST', body: JSON.stringify({ reason: 'rejected from dashboard' }),
    });
    state.project = project;
    await fetchEvents();
  });
}

async function stopRun() {
  await withAction($('stop-run'), '已请求停止', async () => {
    const project = await api(`/api/v1/projects/${state.project.id}/stop`, { method: 'POST', body: '{}' });
    state.project = project;
    await fetchEvents();
  });
}

function startPolling() {
  stopPolling();
  if (!state.project || terminalStates.has(state.project.state)) return;
  state.pollTimer = setInterval(refreshProject, 1400);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function refreshProject() {
  if (!state.project) return;
  try {
    const project = await api(`/api/v1/projects/${state.project.id}`);
    state.project = project;
    render();
    await fetchEvents();
    if (terminalStates.has(project.state)) stopPolling();
  } catch (error) {
    if (String(error.message).includes('404')) {
      stopPolling();
      localStorage.removeItem('reprolens.projectId');
    }
  }
}

function startEventStream() {
  if (state.eventSource) state.eventSource.close();
  if (!state.project) return;
  const source = new EventSource(`/api/v1/projects/${state.project.id}/events/stream?after=${state.after}`);
  source.addEventListener('reprolens', (event) => {
    try {
      const item = JSON.parse(event.data);
      appendEvent(item);
    } catch { /* ignore malformed event frames */ }
  });
  source.onerror = () => { /* EventSource reconnects automatically. */ };
  state.eventSource = source;
}

async function fetchEvents() {
  if (!state.project) return;
  try {
    const events = await api(`/api/v1/projects/${state.project.id}/events?after=${state.after}`);
    for (const event of events || []) appendEvent(event);
  } catch { /* project may be changing */ }
}

function appendEvent(event) {
  if (!event || state.events.some((item) => item.seq === event.seq)) return;
  state.events.push(event);
  state.events.sort((a, b) => a.seq - b.seq);
  state.after = Math.max(state.after, Number(event.seq) || 0);
  renderEvents();
}

function renderEvents() {
  const box = $('events');
  if (state.events.length === 0) {
    box.className = 'event-log empty-state';
    box.textContent = '等待事件。';
    return;
  }
  box.className = 'event-log';
  box.innerHTML = state.events.map((event) => `
    <article class="event ${escapeHTML(event.type)}">
      <code>#${escapeHTML(event.seq)} · ${escapeHTML(event.type)}</code>
      <p>${escapeHTML(event.message)}</p>
      <small>${escapeHTML(new Date(event.created_at).toLocaleTimeString('zh-CN'))}</small>
    </article>
  `).join('');
  box.scrollTop = box.scrollHeight;
}

function renderPipeline(project) {
  const idx = stateIndex[project.state] ?? -1;
  $('pipeline-track').innerHTML = pipelineSteps.map(([key, label], index) => {
    let className = 'pipeline-step';
    if (idx > index) className += ' done';
    if (idx === index) className += project.state === 'AWAITING_PATCH' ? ' alert' : ' current';
    return `<div class="${className}" title="${escapeHTML(stateLabels[key] || key)}">${escapeHTML(label)}</div>`;
  }).join('');
}

function renderClaims(project) {
  const box = $('claims');
  if (!project.claims?.length) {
    box.className = 'stack empty-state';
    box.textContent = '尚无可测主张。请先开始分析。';
    return;
  }
  if (project.state === 'AWAITING_CLAIMS' && state.selectedClaims.size === 0) {
    state.selectedClaims.add(project.claims[0].claim_id);
  }
  box.className = 'stack';
  box.innerHTML = project.claims.map((claim) => {
    const checked = state.selectedClaims.has(claim.claim_id) || claim.selected;
    const selectable = project.state === 'AWAITING_CLAIMS';
    return `
      <article class="claim ${checked ? 'selected' : ''}" data-claim="${escapeHTML(claim.claim_id)}">
        <div class="claim-top">
          <span class="claim-id">${escapeHTML(claim.claim_id)} · ${escapeHTML(claim.metric)}</span>
          <span class="badge ${checked ? 'success' : ''}">${checked ? 'selected' : 'candidate'}</span>
        </div>
        <label>
          <input type="checkbox" value="${escapeHTML(claim.claim_id)}" ${checked ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
          <span class="claim-text">${escapeHTML(claim.text)}</span>
        </label>
        <div class="claim-meta">
          <span>expected <strong>${escapeHTML(claim.expected_value)}</strong></span>
          <span>abs tol <strong>${escapeHTML(claim.tolerance?.abs ?? 0)}</strong></span>
          <span>source <strong>${escapeHTML(claim.source?.path || 'paper')}:${escapeHTML(claim.source?.line || 0)}</strong></span>
        </div>
      </article>`;
  }).join('');
  box.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) state.selectedClaims.add(input.value);
      else state.selectedClaims.delete(input.value);
      renderClaims(project);
    });
  });
}

function renderPlans(project) {
  const box = $('plans');
  $('plan-count').textContent = `${project.plans?.length || 0} plans`;
  if (!project.plans?.length) {
    box.className = 'stack empty-state';
    box.textContent = '确认 claim 后生成可审计的实验计划。';
    return;
  }
  box.className = 'stack';
  box.innerHTML = project.plans.map((plan, index) => `
    <article class="plan">
      <div class="plan-top">
        <span class="plan-id">${String(index + 1).padStart(2, '0')} · ${escapeHTML(plan.claim_id)}</span>
        <span class="badge ${plan.confirmed ? 'success' : 'wait'}">${plan.confirmed ? 'confirmed' : 'awaiting approval'}</span>
      </div>
      <div class="code-line">${escapeHTML(plan.command)}</div>
      <div class="plan-meta">
        <span>seed <strong>${escapeHTML(plan.seed)}</strong></span>
        <span>metric <strong>${escapeHTML(plan.expected_metric)}</strong></span>
        <span>expected <strong>${escapeHTML(plan.expected_value)}</strong></span>
        <span>image <strong>${escapeHTML(plan.image || 'python:3.11-slim')}</strong></span>
      </div>
    </article>
  `).join('');
}

function renderRuns(project) {
  const box = $('runs');
  if (!project.runs?.length) {
    box.className = 'stack empty-state';
    box.textContent = '尚无运行记录。';
    return;
  }
  box.className = 'stack';
  box.innerHTML = project.runs.map((run) => {
    const badge = run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'fail' : 'wait';
    return `
      <article class="run">
        <div class="run-top">
          <span class="run-id">RUN ${escapeHTML(run.attempt)} · ${escapeHTML(run.status)}</span>
          <span class="badge ${badge}">exit ${escapeHTML(run.exit_code)}</span>
        </div>
        <div class="code-line">${escapeHTML(run.command)}</div>
        <div class="run-meta">
          <span>runner <strong>${escapeHTML(run.runner)}</strong></span>
          <span>duration <strong>${escapeHTML(run.duration_ms)} ms</strong></span>
          ${run.metric ? `<span>observed <strong>${escapeHTML(run.metric.value)}</strong></span>` : ''}
        </div>
        ${run.failure_class ? `<div class="claim-meta"><span class="badge fail">${escapeHTML(run.failure_class)}</span><span>${escapeHTML(run.failure_summary)}</span></div>` : ''}
      </article>`;
  }).join('');
}

function renderPatch(project) {
  const card = $('patch-card');
  if (!project.patch) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const patch = project.patch;
  $('patch-status').textContent = patch.status;
  $('patch-status').className = 'pill ' + (patch.status === 'applied' ? '' : 'warning');
  $('patch-diagnosis').innerHTML = `
    <strong>${escapeHTML(patch.diagnosis?.failure_class || 'diagnosis')}</strong>
    <div>${escapeHTML(patch.diagnosis?.root_cause || 'No root cause provided.')}</div>
    <small>${escapeHTML(patch.diagnosis?.explanation || '')}</small>
  `;
  $('patch-diff').textContent = patch.diff || '';
  const canApprove = project.state === 'AWAITING_PATCH' && patch.status === 'proposed';
  $('approve-patch').disabled = !canApprove;
  $('reject-patch').disabled = !canApprove;
}

function renderVerification(project) {
  const card = $('verification-card');
  const verification = project.verification;
  if (!verification) {
    card.hidden = true;
    $('verdict-badge').textContent = '—';
    return;
  }
  card.hidden = false;
  const verdictClass = String(verification.verdict).toLowerCase();
  $('verdict-badge').textContent = verification.verdict;
  $('verdict-badge').className = `verdict ${verdictClass}`;
  const delta = Number(verification.observed) - Number(verification.expected);
  $('metric-grid').innerHTML = `
    <div class="metric"><span>Paper value</span><strong>${escapeHTML(verification.expected)}</strong><small>${escapeHTML(verification.metric)}</small></div>
    <div class="metric"><span>Observed value</span><strong>${escapeHTML(verification.observed)}</strong><small>delta ${escapeHTML(delta.toFixed(6))}</small></div>
    <div class="metric"><span>Rule</span><strong>${escapeHTML(verification.verdict)}</strong><small>${escapeHTML(verification.rule || verification.note || '')}</small></div>
  `;
}

function render(project = state.project) {
  const hasProject = Boolean(project);
  $('state-label').textContent = hasProject ? (stateLabels[project.state] || project.state) : '尚未载入项目';
  $('status-dot').className = 'status-dot ' + (hasProject ? stateDotClass(project.state) : '');
  $('meta-claims').textContent = hasProject ? `${project.claims?.length || 0}` : '—';
  $('meta-runs').textContent = hasProject ? `${project.runs?.length || 0}` : '—';
  $('meta-verdict').textContent = hasProject ? (project.verification?.verdict || '—') : '—';
  $('meta-evidence').textContent = hasProject ? `${(project.runs || []).reduce((sum, run) => sum + (run.stdout_path ? 1 : 0) + (run.stderr_path ? 1 : 0), 0)} files` : '—';
  $('runner-pill').textContent = hasProject ? `runner · ${project.runs?.[project.runs.length - 1]?.runner || 'pending'}` : 'runner —';

  $('project-name').textContent = hasProject ? project.name : '等待载入项目';
  $('project-id').textContent = hasProject ? project.id : '—';
  $('paper-path').textContent = hasProject ? shortPath(project.paper_path) : '—';
  $('repo-path').textContent = hasProject ? shortPath(project.repo_path) : '—';
  $('paper-title').textContent = hasProject ? (project.paper?.title || '—') : '—';
  $('paper-sha').textContent = hasProject ? (project.paper?.sha256 || '—') : '—';

  $('start-analysis').disabled = !hasProject || project.state !== 'CREATED';
  $('select-claims').disabled = !hasProject || project.state !== 'AWAITING_CLAIMS';
  $('run-plan').disabled = !hasProject || project.state !== 'AWAITING_PLAN';
  $('stop-run').disabled = !hasProject || terminalStates.has(project.state);

  $('report-link').classList.toggle('disabled', !hasProject || !project.report);
  $('package-link').classList.toggle('disabled', !hasProject || !project.report);
  if (hasProject && project.report) {
    $('report-link').href = `/api/v1/projects/${project.id}/report.md`;
    $('package-link').href = `/api/v1/projects/${project.id}/package`;
  }

  if (!hasProject) {
    $('pipeline-track').innerHTML = '';
    $('claims').className = 'stack empty-state';
    $('claims').textContent = '载入项目后显示论文中的可测主张。';
    $('plans').className = 'stack empty-state';
    $('plans').textContent = '确认 claim 后生成可审计的实验计划。';
    $('runs').className = 'stack empty-state';
    $('runs').textContent = '尚无运行记录。';
    $('patch-card').hidden = true;
    $('verification-card').hidden = true;
    return;
  }
  renderPipeline(project);
  renderClaims(project);
  renderPlans(project);
  renderRuns(project);
  renderPatch(project);
  renderVerification(project);
}

async function restoreProject() {
  const id = localStorage.getItem('reprolens.projectId');
  if (!id) {
    render();
    return;
  }
  try {
    state.project = await api(`/api/v1/projects/${id}`);
    state.selectedClaims = new Set((state.project.claims || []).filter((c) => c.selected).map((c) => c.claim_id));
    startEventStream();
    startPolling();
    await fetchEvents();
    render();
  } catch {
    localStorage.removeItem('reprolens.projectId');
    render();
  }
}

$('load-demo').addEventListener('click', loadDemo);
$('start-analysis').addEventListener('click', startAnalysis);
$('select-claims').addEventListener('click', selectClaims);
$('run-plan').addEventListener('click', confirmPlan);
$('approve-patch').addEventListener('click', approvePatch);
$('reject-patch').addEventListener('click', rejectPatch);
$('stop-run').addEventListener('click', stopRun);

render();
restoreProject();