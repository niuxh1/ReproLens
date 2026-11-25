const state = {
  view: 'overview', projects: [], current: null, options: null, settings: null,
  events: [], stream: null, pollTimer: null, commandIndex: 0, commands: [],
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ACTIVE_STATES = new Set(['INITIALIZED', 'INGESTED', 'AWAITING_CLAIMS', 'AWAITING_PLAN', 'SANDBOX_READY', 'EXECUTING', 'AWAITING_PATCH', 'RETRYING', 'VERIFYING', 'REPORTING']);
const STATE_ORDER = ['CREATED', 'INITIALIZED', 'INGESTED', 'AWAITING_CLAIMS', 'AWAITING_PLAN', 'SANDBOX_READY', 'EXECUTING', 'AWAITING_PATCH', 'RETRYING', 'VERIFYING', 'REPORTING', 'COMPLETED'];
const STATE_LABELS = { CREATED: '已创建', INITIALIZED: '已初始化', INGESTED: '材料已摄取', AWAITING_CLAIMS: '待选主张', AWAITING_PLAN: '待确认计划', SANDBOX_READY: '沙箱就绪', EXECUTING: '执行中', AWAITING_PATCH: '待审批补丁', RETRYING: '重试中', VERIFYING: '核验中', REPORTING: '生成报告', COMPLETED: '已完成', FAILED: '失败', STOPPED: '已停止' };

document.addEventListener('DOMContentLoaded', () => { void boot(); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (['overview', 'new-run', 'projects', 'settings', 'docs'].includes(view)) setView(view); });
async function boot() {
  bindGlobalEvents();
  await Promise.allSettled([checkHealth(), loadOptions(), loadSettings(), loadProjects()]);
  const initialView = location.hash.slice(1);
  if (['overview', 'new-run', 'projects', 'settings', 'docs'].includes(initialView)) setView(initialView);
  if (state.projects.length) { const first = state.projects[0]; if (first.state !== 'CREATED' && !initialView) await openProject(first.id, false); }
}

function bindGlobalEvents() {
  document.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { event.preventDefault(); setView(viewButton.dataset.view); return; }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) { event.preventDefault(); handleGlobalAction(actionButton.dataset.action); return; }
    if (event.target.closest('[data-close-command]')) closeCommandPalette();
  });
  $('#refresh-button').addEventListener('click', () => void refreshAll());
  $('#command-trigger').addEventListener('click', openCommandPalette);
  $('#command-input').addEventListener('input', renderCommandResults);
  $('#command-input').addEventListener('keydown', handleCommandKey);
  $('#project-filter').addEventListener('input', renderProjects);
  $('#paper-file').addEventListener('change', () => void uploadPaper());
  $('#repo-file').addEventListener('change', () => void uploadRepo());
  $('#paper-path').addEventListener('input', refreshNewRunChecks);
  $('#repo-path').addEventListener('input', refreshNewRunChecks);
  $('#runner-select').addEventListener('change', refreshRunnerFields);
  $('#code-agent-select').addEventListener('change', refreshCodeAgentFields);
  $('#new-run-form').addEventListener('submit', (event) => { event.preventDefault(); void createProject(); });
  $('#select-claims-button').addEventListener('click', () => void selectClaims());
  $('#approve-patch-button').addEventListener('click', () => void projectAction('approve'));
  $('#reject-patch-button').addEventListener('click', () => void projectAction('reject'));
  $('#save-settings-button').addEventListener('click', () => void saveSettings());
  $('#test-llm-button').addEventListener('click', () => void testLLM());
  $('#settings-llm-preset').addEventListener('change', applyModelPreset);
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); }
    if (event.key === 'Escape') closeCommandPalette();
  });
  $$('#paper-drop, #repo-drop').forEach((zone) => {
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('dragging'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault(); zone.classList.remove('dragging');
      const input = $('input', zone);
      if (event.dataTransfer.files[0]) {
        const transfer = new DataTransfer(); transfer.items.add(event.dataTransfer.files[0]);
        input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
}

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === view));
  $('#crumb-current').textContent = { overview: '总览', 'new-run': '新建复现', projects: '项目', project: '项目详情', settings: '运行时设置', docs: '接口与扩展' }[view] || view;
  if (view === 'overview') renderOverview();
  if (view === 'projects') renderProjects();
  if (view === 'new-run') refreshNewRunChecks();
  if (view === 'settings') fillSettingsForm();
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
function handleGlobalAction(action) { if (action === 'new-run') { setView('new-run'); $('#paper-path').focus(); } }

async function checkHealth() {
  try { const health = await api('/healthz'); setHealth(true, health.service || 'reprolens'); }
  catch { setHealth(false, 'offline'); }
}
function setHealth(ok, label) {
  $$('.health-dot').forEach((dot) => { dot.classList.toggle('ok', ok); dot.classList.toggle('bad', !ok); });
  $('#health-label').textContent = ok ? '服务在线' : '服务离线';
  $('#health-pill').textContent = ok ? 'OK' : 'ERR';
  $('#connection-text').textContent = ok ? '本地 API' : '连接失败';
  $('#workspace-status').textContent = ok ? 'SQLite · 本地 Agent' : '等待服务';
}

async function loadOptions() {
  try {
    state.options = await api('/api/v1/options');
    $('#settings-llm-preset').innerHTML = '<option value="">选择预设…</option>' + state.options.model_presets.map((item, index) => `<option value="${index}">${escapeHtml(item.label)}</option>`).join('');
  } catch (error) { toast(`读取选项失败：${error.message}`, 'error'); }
}
async function loadSettings() {
  try { state.settings = await api('/api/v1/settings'); fillSettingsForm(); renderRuntimeConfig(); }
  catch { state.settings = null; renderRuntimeConfig(); }
}
async function loadProjects() {
  try { state.projects = await api('/api/v1/projects'); renderOverview(); renderProjects(); $('#project-count').textContent = String(state.projects.length); }
  catch (error) { toast(`读取项目失败：${error.message}`, 'error'); }
}
async function refreshAll() {
  await Promise.allSettled([checkHealth(), loadProjects(), loadSettings()]);
  if (state.current) await openProject(state.current.id, false);
  toast('已刷新工作区');
}

async function openProject(id, announce = true) {
  try {
    if (state.stream) { state.stream.close(); state.stream = null; }
    state.current = await api(`/api/v1/projects/${id}`);
    state.events = await api(`/api/v1/projects/${id}/events`);
    setView('project'); renderProject(); subscribeProjectEvents(id); startProjectPolling();
    if (announce) toast(`已打开 ${state.current.name}`);
  } catch (error) { toast(`打开项目失败：${error.message}`, 'error'); }
}

function renderOverview() {
  const verdicts = state.projects.filter((project) => project.verification).length;
  const gpuRuns = state.projects.reduce((sum, project) => sum + (project.runs || []).filter((run) => run.gpu).length, 0);
  const packages = state.projects.filter((project) => project.report?.package_path).length;
  $('#metric-projects').textContent = String(state.projects.length);
  $('#metric-verdicts').textContent = String(verdicts);
  $('#metric-gpu').textContent = String(gpuRuns);
  $('#metric-packages').textContent = String(packages);
  $('#overview-projects').innerHTML = state.projects.length ? state.projects.slice(0, 6).map(projectCard).join('') : '<div class="empty-panel">还没有项目。点击“新建复现”开始。</div>';
  renderRuntimeConfig();
}
function projectCard(project) {
  const verdict = project.verification?.verdict || '—';
  return `<button class="project-card" data-open-project="${escapeAttr(project.id)}" type="button">
    <div class="project-card-top"><span class="status-pill ${stateClass(project.state)}">${STATE_LABELS[project.state] || project.state}</span><span class="status-pill ${verdict === 'PASS' ? 'success' : verdict === 'DIFFERENT' ? 'warning' : verdict === 'FAILED' ? 'danger' : 'neutral'}">${escapeHtml(verdict)}</span></div>
    <div class="project-card-name">${escapeHtml(project.name)}</div><div class="project-card-path">${escapeHtml(project.paper_path || '—')}</div>
    <div class="project-card-foot"><span>${project.runs?.length || 0} runs</span><span>${project.paper?.pages?.length || 0} pages</span><span>${project.patch ? 'patch' : 'no patch'}</span></div>
  </button>`;
}
function renderProjects() {
  const filter = ($('#project-filter')?.value || '').toLowerCase().trim();
  const projects = state.projects.filter((project) => !filter || `${project.name} ${project.state} ${project.paper?.title || ''}`.toLowerCase().includes(filter));
  $('#project-filter-count').textContent = `${projects.length} 个项目`;
  $('#project-list').innerHTML = projects.length ? projects.map((project) => `<button class="project-row" data-open-project="${escapeAttr(project.id)}" type="button">
    <div><div class="project-row-title">${escapeHtml(project.name)}</div><div class="project-row-sub">${escapeHtml(project.paper_path || project.id)}</div></div>
    <div class="project-row-meta"><strong>${STATE_LABELS[project.state] || project.state}</strong>${project.claims?.length || 0} claims</div>
    <div class="project-row-meta"><strong>${project.runs?.length || 0} runs</strong>${project.patch ? 'patch proposed' : 'no patch'}</div>
    <div class="project-row-meta"><strong>${project.verification?.verdict || '—'}</strong>verdict</div>
  </button>`).join('') : '<div class="empty-panel">没有匹配的项目。</div>';
}
function renderRuntimeConfig() {
  const settings = state.settings;
  if (!settings) { $('#runtime-config').innerHTML = '<div class="empty-panel">设置 API 不可用。</div>'; return; }
  const rows = [['模型', settings.llm?.model || '未配置'], ['Base URL', settings.llm?.baseURL || '未配置'], ['执行器', settings.runner], ['GPU', settings.enableGPU ? '启用' : '关闭'], ['CodeAgent', settings.codeAgent?.type || 'none'], ['多模态', settings.llm?.vision ? '启用' : '关闭']];
  $('#runtime-config').innerHTML = rows.map(([key, value]) => `<div class="config-row"><span>${key}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
  $('#runtime-runner').textContent = settings.runner;
}

function renderProject() {
  const project = state.current; if (!project) return;
  $('#project-detail-name').textContent = project.name;
  $('#project-detail-meta').textContent = `${project.id} · ${project.paper?.title || '未摄取论文'} · ${project.paper?.sha256 ? 'sha256:' + project.paper.sha256.slice(0, 12) : 'no sha'}`;
  $('#project-eyebrow').textContent = project.id;
  renderProjectActions(project); renderStateStrip(project); renderClaims(project); renderPlans(project); renderRuns(project);
  renderPatch(project); renderVerification(project); renderDeliverables(project); renderSourceIndex(project); renderEvents();
}
function renderProjectActions(project) {
  const actions = [];
  if (project.state === 'CREATED') actions.push('<button class="button primary" data-project-action="start" type="button">开始摄取</button>');
  if (project.state === 'AWAITING_PLAN') actions.push('<button class="button primary" data-project-action="confirm" type="button">确认并执行</button>');
  if (project.state === 'AWAITING_PATCH') actions.push('<button class="button primary" data-project-action="approve" type="button">审批补丁</button>', '<button class="button ghost" data-project-action="reject" type="button">拒绝</button>');
  if (ACTIVE_STATES.has(project.state)) actions.push('<button class="button ghost" data-project-action="stop" type="button">停止</button>');
  if (project.report?.markdown) actions.push(`<a class="button" href="/api/v1/projects/${encodeURIComponent(project.id)}/report.md" target="_blank" rel="noreferrer">报告</a>`);
  if (project.report?.package_path) actions.push(`<a class="button primary" href="/api/v1/projects/${encodeURIComponent(project.id)}/package">下载证据包</a>`);
  $('#project-actions').innerHTML = actions.join('');
  $$('[data-project-action]').forEach((button) => button.addEventListener('click', () => void projectAction(button.dataset.projectAction)));
}
function renderStateStrip(project) {
  const currentIndex = STATE_ORDER.indexOf(project.state);
  const failed = project.state === 'FAILED' || project.state === 'STOPPED';
  $('#state-strip').innerHTML = STATE_ORDER.map((stateName, index) => {
    const done = currentIndex >= index && project.state !== 'CREATED';
    const current = project.state === stateName || (failed && index === currentIndex);
    return `<div class="state-step ${done ? 'done' : ''} ${current ? 'current' : ''} ${failed && current ? 'failed' : ''}"><span class="state-dot"></span><span>${STATE_LABELS[stateName]}</span></div>`;
  }).join('');
}
function renderClaims(project) {
  const claims = project.claims || [];
  const canSelect = project.state === 'AWAITING_CLAIMS';
  $('#select-claims-button').disabled = !canSelect;
  $('#claims-list').className = claims.length ? 'stack' : 'stack empty-panel';
  $('#claims-list').innerHTML = claims.length ? claims.map((claim) => `<label class="claim-item">
    <input type="checkbox" data-claim-id="${escapeAttr(claim.claim_id)}" ${claim.selected ? 'checked' : ''} ${canSelect ? '' : 'disabled'}>
    <span class="claim-copy"><strong>${escapeHtml(claim.claim_id)} · ${escapeHtml(claim.metric)} = ${claim.expected_value}</strong><p>${escapeHtml(claim.text)}</p><small>${escapeHtml(claim.source?.path || '')}:${claim.source?.line || 0} · tolerance abs ${claim.tolerance?.abs ?? 0}</small></span>
  </label>`).join('') : '开始摄取后显示论文中的可测主张。';
}
function renderPlans(project) {
  const plans = project.plans || [];
  $('#plan-count').textContent = String(plans.length);
  $('#plans-list').className = plans.length ? 'stack' : 'stack empty-panel';
  $('#plans-list').innerHTML = plans.length ? plans.map((plan) => `<div class="plan-item"><div class="plan-item-head"><strong>${escapeHtml(plan.claim_id)} · ${escapeHtml(plan.expected_metric)}</strong><span class="status-pill ${plan.confirmed ? 'success' : 'neutral'}">${plan.confirmed ? 'confirmed' : 'draft'}</span></div><code>${escapeHtml(plan.command)}</code><div class="plan-meta"><span>seed ${plan.seed}</span><span>${escapeHtml(plan.image)}</span><span>abs tol ${plan.tolerance?.abs ?? 0}</span><span>${escapeHtml(plan.work_dir)}</span></div></div>`).join('') : '选择 claim 后生成计划。';
}
function renderRuns(project) {
  const runs = project.runs || [];
  $('#run-count').textContent = String(runs.length);
  $('#runs-list').className = runs.length ? 'stack' : 'stack empty-panel';
  $('#runs-list').innerHTML = runs.length ? runs.map((run) => `<div class="run-item"><div class="run-line"><strong>run ${run.attempt} · ${escapeHtml(run.runner)}</strong><span class="status-pill ${run.status === 'succeeded' ? 'success' : run.status === 'timeout' ? 'warning' : 'danger'}">${escapeHtml(run.status)}</span></div><small>exit ${run.exit_code} · ${run.duration_ms} ms${run.gpu ? ' · GPU' : ''}${run.provider ? ' · ' + escapeHtml(run.provider) : ''}${run.offer_id ? ' · ' + escapeHtml(run.offer_id) : ''}</small>${run.failure_class ? `<small>${escapeHtml(run.failure_class)} — ${escapeHtml(run.failure_summary || '')}</small>` : ''}${run.stdout ? `<details><summary>stdout</summary><pre class="code-block">${escapeHtml(run.stdout.slice(0, 4000))}</pre></details>` : ''}</div>`).join('') : '尚未运行。';
}
function renderPatch(project) {
  const panel = $('#patch-panel');
  if (!project.patch) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#patch-status').textContent = project.patch.status;
  $('#patch-status').className = `status-pill ${project.patch.status === 'applied' ? 'success' : project.patch.status === 'rejected' ? 'danger' : 'warning'}`;
  $('#patch-diagnosis').textContent = `${project.patch.diagnosis.failure_class} · ${project.patch.diagnosis.root_cause}${project.patch.diagnosis.explanation ? ' — ' + project.patch.diagnosis.explanation : ''}`;
  $('#patch-diff').textContent = project.patch.diff || '';
  const actionable = project.state === 'AWAITING_PATCH' && project.patch.status === 'proposed';
  $('#approve-patch-button').disabled = !actionable; $('#reject-patch-button').disabled = !actionable;
}
function renderVerification(project) {
  const panel = $('#verification-panel');
  if (!project.verification) { panel.hidden = true; return; }
  panel.hidden = false;
  const verdict = project.verification;
  $('#verdict-pill').textContent = verdict.verdict;
  $('#verdict-pill').className = `verdict ${verdict.verdict.toLowerCase()}`;
  $('#verification-body').innerHTML = `<div class="verification-grid"><div><span>expected</span><strong>${formatNumber(verdict.expected)}</strong></div><div><span>observed</span><strong>${formatNumber(verdict.observed)}</strong></div><div><span>tolerance</span><strong>±${formatNumber(verdict.tolerance?.abs ?? 0)}</strong></div></div><div class="rule-line">${escapeHtml(verdict.rule)}${verdict.note ? ' · ' + escapeHtml(verdict.note) : ''}</div>`;
}
function renderDeliverables(project) {
  const items = [];
  if (project.report?.markdown) items.push({ href: `/api/v1/projects/${encodeURIComponent(project.id)}/report.md`, icon: 'MD', title: 'Markdown 报告', note: '规则判决与事件链' });
  if (project.report?.package_path) items.push({ href: `/api/v1/projects/${encodeURIComponent(project.id)}/package`, icon: 'ZIP', title: '复现证据包', note: '原始 PDF、页面图像、日志与 diff' });
  if (project.paper?.pages?.length) items.push({ href: '#', icon: 'PDF', title: `${project.paper.pages.length} 页视觉证据`, note: 'PDF 页面渲染已归档', disabled: true });
  $('#deliverables').innerHTML = items.length ? items.map((item) => `<a class="deliverable ${item.disabled ? 'disabled' : ''}" ${item.disabled ? '' : `href="${item.href}"`} ${item.href !== '#' ? 'target="_blank" rel="noreferrer"' : ''}><span class="deliverable-icon">${item.icon}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.note)}</small></span></a>`).join('') : '<div class="empty-panel">完成核验后生成报告与证据包。</div>';
}
function renderSourceIndex(project) {
  $('#source-index').innerHTML = `<div><span>论文</span><strong title="${escapeAttr(project.paper_path || '')}">${escapeHtml(project.paper_path || '—')}</strong></div><div><span>仓库</span><strong title="${escapeAttr(project.repo_path || '')}">${escapeHtml(project.repo_path || '—')}</strong></div><div><span>论文标题</span><strong>${escapeHtml(project.paper?.title || '—')}</strong></div><div><span>视觉页面</span><strong>${project.paper?.pages?.length || 0} pages</strong></div><div><span>SHA-256</span><strong>${escapeHtml(project.paper?.sha256?.slice(0, 24) || '—')}</strong></div>`;
}
function renderEvents() {
  const events = [...state.events].sort((a, b) => a.seq - b.seq);
  $('#event-log').innerHTML = events.length ? events.slice(-80).map((event) => `<div class="event-item ${escapeAttr(event.type)}"><code>#${event.seq} · ${escapeHtml(event.type)}</code><p>${escapeHtml(event.message)}</p></div>`).join('') : '<div class="empty-panel">等待事件。</div>';
  const log = $('#event-log'); log.scrollTop = log.scrollHeight;
}

async function projectAction(action) {
  if (!state.current) return;
  const project = state.current;
  try {
    if (action === 'start') state.current = await api(`/api/v1/projects/${project.id}/start`, { method: 'POST' });
    if (action === 'confirm') state.current = await api(`/api/v1/projects/${project.id}/plan/confirm`, { method: 'POST' });
    if (action === 'approve') state.current = await api(`/api/v1/projects/${project.id}/patch/approve`, { method: 'POST', body: JSON.stringify({ approved_by: 'web-console' }) });
    if (action === 'reject') state.current = await api(`/api/v1/projects/${project.id}/patch/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected in web console' }) });
    if (action === 'stop') state.current = await api(`/api/v1/projects/${project.id}/stop`, { method: 'POST' });
    renderProject(); toast(`操作已提交：${action}`); startProjectPolling();
  } catch (error) { toast(error.message, 'error'); }
}
async function selectClaims() {
  if (!state.current) return;
  const claimIds = $$('[data-claim-id]:checked').map((input) => input.dataset.claimId);
  if (!claimIds.length) return toast('至少选择一条 claim', 'error');
  try { state.current = await api(`/api/v1/projects/${state.current.id}/claims`, { method: 'POST', body: JSON.stringify({ claim_ids: claimIds }) }); renderProject(); toast('实验计划已生成'); }
  catch (error) { toast(error.message, 'error'); }
}
function startProjectPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.current) return;
    try {
      const latest = await api(`/api/v1/projects/${state.current.id}`);
      state.current = latest; renderProject();
      if (!ACTIVE_STATES.has(latest.state) && state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      await loadProjects();
    } catch { /* next tick retries */ }
  }, 1500);
}
function subscribeProjectEvents(projectId) {
  if (state.stream) state.stream.close();
  const after = state.events.at(-1)?.seq || 0;
  const stream = new EventSource(`/api/v1/projects/${encodeURIComponent(projectId)}/events/stream?after=${after}`);
  state.stream = stream;
  stream.addEventListener('reprolens', (event) => {
    try { const parsed = JSON.parse(event.data); if (!state.events.some((item) => item.seq === parsed.seq)) state.events.push(parsed); renderEvents(); }
    catch { /* ignore malformed SSE */ }
  });
}

async function uploadPaper() {
  const file = $('#paper-file').files[0]; if (!file) return;
  const chip = $('#paper-file-name'); chip.hidden = false; chip.textContent = `上传中：${file.name}`;
  try {
    const form = new FormData(); form.append('file', file);
    const result = await api('/api/v1/uploads/paper', { method: 'POST', body: form });
    $('#paper-path').value = result.paper_path; chip.textContent = `${result.filename} · ${formatBytes(result.size)}`;
    toast('PDF 已上传，启动时会渲染页面图像', 'ok');
  } catch (error) { chip.textContent = '上传失败'; toast(error.message, 'error'); }
  refreshNewRunChecks();
}
async function uploadRepo() {
  const file = $('#repo-file').files[0]; if (!file) return;
  const chip = $('#repo-file-name'); chip.hidden = false; chip.textContent = `上传中：${file.name}`;
  try {
    const form = new FormData(); form.append('file', file);
    const result = await api('/api/v1/uploads/repo', { method: 'POST', body: form });
    $('#repo-path').value = result.repo_path; chip.textContent = `${result.filename} · ${formatBytes(result.size)}`;
    toast('仓库 ZIP 已解压到工作区', 'ok');
  } catch (error) { chip.textContent = '上传失败'; toast(error.message, 'error'); }
  refreshNewRunChecks();
}

async function createProject() {
  const paperPath = $('#paper-path').value.trim();
  const repoPath = $('#repo-path').value.trim();
  if (!paperPath || !repoPath) return toast('论文路径与仓库路径不能为空', 'error');
  const button = $('#create-project-button'); button.disabled = true; button.textContent = '创建中…';
  try {
    const runner = $('#runner-select').value;
    const codeAgent = $('#code-agent-select').value;
    const settingsPatch = { runner, enableGPU: $('#enable-gpu').checked, codeAgent: { type: codeAgent, ...(codeAgent === 'command' ? { command: $('#code-agent-command').value.trim() } : {}) } };
    if (runner === 'ssh') settingsPatch.remote = { host: $('#ssh-host').value.trim(), port: Number($('#ssh-port').value), identity: $('#ssh-identity').value.trim(), baseDir: $('#ssh-base-dir').value.trim() };
    if (runner === 'colab' || runner === 'platform') settingsPatch.platform = { baseURL: $('#platform-base-url').value.trim(), apiKey: $('#platform-api-key').value.trim(), provider: $('#platform-provider').value.trim(), image: $('#platform-image').value.trim(), gpuType: $('#platform-gpu-type').value.trim(), minVRAMGB: Number($('#platform-min-vram').value), maxHourlyUSD: Number($('#platform-max-price').value), pollIntervalMs: Number($('#platform-poll').value) };
    try { await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(settingsPatch) }); } catch { /* settings can be unavailable */ }
    const project = await api('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name: $('#project-name-input').value.trim(), paper_path: paperPath, repo_path: repoPath, data_path: $('#data-path').value.trim(), budget: { max_runs: Number($('#max-runs').value), max_seconds: Number($('#max-seconds').value), max_patches: Number($('#max-patches').value) } }) });
    state.current = await api(`/api/v1/projects/${project.id}/start`, { method: 'POST' });
    await loadProjects(); setView('project'); renderProject(); subscribeProjectEvents(project.id);
    toast('项目已创建，论文与仓库摄取完成');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = '创建并开始摄取 <span>→</span>'; }
}

function refreshRunnerFields() {
  const runner = $('#runner-select').value;
  $('#ssh-fields').hidden = runner !== 'ssh';
  $('#platform-fields').hidden = runner !== 'colab' && runner !== 'platform';
  $('#docker-fields').hidden = runner !== 'docker';
  $('#local-fields').hidden = runner !== 'local' && runner !== 'auto';
  const help = { auto: '自动优先 Docker，回退到本机。', local: '本机进程，仅回环地址建议使用。', docker: '容器隔离，禁止网络并限制资源。', ssh: '通过 SSH 上传工作区并执行。', colab: 'Colab 风格租赁平台 HTTP 适配器。', platform: '通用租赁平台 HTTP 适配器。' };
  $('#runner-help').textContent = help[runner] || ''; refreshNewRunChecks();
}
function refreshCodeAgentFields() { $('#code-agent-command-field').hidden = $('#code-agent-select').value !== 'command'; }
function refreshNewRunChecks() {
  const setCheck = (id, ok) => { const element = $(id); element.textContent = ok ? '✓' : '○'; element.classList.toggle('ok', ok); };
  setCheck('#check-paper', Boolean($('#paper-path')?.value.trim()));
  setCheck('#check-repo', Boolean($('#repo-path')?.value.trim()));
  setCheck('#check-model', Boolean(state.settings?.llm?.baseURL && state.settings?.llm?.model));
  setCheck('#check-runner', Boolean($('#runner-select')?.value));
}

function fillSettingsForm() {
  if (!state.settings) return;
  const settings = state.settings;
  $('#settings-llm-base-url').value = settings.llm?.baseURL || '';
  $('#settings-llm-model').value = settings.llm?.model || '';
  $('#settings-llm-api-key').value = '';
  $('#settings-llm-timeout').value = settings.llm?.timeoutMs || 60000;
  $('#settings-llm-vision').checked = settings.llm?.vision !== false;
  $('#settings-runner').value = settings.runner || 'auto';
  $('#settings-gpu').checked = Boolean(settings.enableGPU);
  $('#settings-code-agent').value = settings.codeAgent?.type || 'none';
  $('#settings-code-command').value = settings.codeAgent?.command || '';
  $('#settings-ssh-host').value = settings.remote?.host || '';
  $('#settings-ssh-port').value = settings.remote?.port || 22;
  $('#settings-ssh-identity').value = settings.remote?.identity || '';
  $('#settings-ssh-base-dir').value = settings.remote?.baseDir || '/tmp/reprolens';
  $('#settings-platform-url').value = settings.platform?.baseURL || '';
  $('#settings-platform-key').value = '';
  $('#settings-platform-provider').value = settings.platform?.provider || 'colab';
  $('#settings-platform-image').value = settings.platform?.image || 'python:3.11-slim';
  $('#settings-platform-gpu').value = settings.platform?.gpuType || '';
  $('#settings-platform-vram').value = settings.platform?.minVRAMGB || 16;
  $('#settings-platform-price').value = settings.platform?.maxHourlyUSD ?? 0.5;
  $('#settings-platform-timeout').value = settings.platform?.timeoutMs || 1800000;
}
function applyModelPreset() {
  const index = $('#settings-llm-preset').value; if (index === '') return;
  const preset = state.options?.model_presets?.[Number(index)]; if (!preset) return;
  $('#settings-llm-base-url').value = preset.base_url; $('#settings-llm-model').value = preset.model;
}
async function saveSettings() {
  const button = $('#save-settings-button'); button.disabled = true;
  try {
    const patch = {
      runner: $('#settings-runner').value, enableGPU: $('#settings-gpu').checked,
      llm: { baseURL: $('#settings-llm-base-url').value.trim(), model: $('#settings-llm-model').value.trim(), timeoutMs: Number($('#settings-llm-timeout').value), vision: $('#settings-llm-vision').checked, ...(($('#settings-llm-api-key').value || '').trim() ? { apiKey: $('#settings-llm-api-key').value.trim() } : {}) },
      codeAgent: { type: $('#settings-code-agent').value, command: $('#settings-code-command').value.trim() },
      remote: { host: $('#settings-ssh-host').value.trim(), port: Number($('#settings-ssh-port').value), identity: $('#settings-ssh-identity').value.trim(), baseDir: $('#settings-ssh-base-dir').value.trim() },
      platform: { baseURL: $('#settings-platform-url').value.trim(), provider: $('#settings-platform-provider').value.trim(), image: $('#settings-platform-image').value.trim(), gpuType: $('#settings-platform-gpu').value.trim(), minVRAMGB: Number($('#settings-platform-vram').value), maxHourlyUSD: Number($('#settings-platform-price').value), timeoutMs: Number($('#settings-platform-timeout').value), ...(($('#settings-platform-key').value || '').trim() ? { apiKey: $('#settings-platform-key').value.trim() } : {}) },
    };
    state.settings = await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(patch) });
    fillSettingsForm(); renderRuntimeConfig(); toast('运行时设置已保存并应用', 'ok');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}
async function testLLM() {
  const status = $('#llm-test-result'); status.textContent = '测试中…'; status.className = 'inline-status';
  try { const result = await api('/api/v1/settings/test-llm', { method: 'POST' }); status.textContent = `连接成功 · ${result.claims?.length || 0} claims`; status.className = 'inline-status ok'; toast('模型连接正常', 'ok'); }
  catch (error) { status.textContent = error.message; status.className = 'inline-status bad'; toast(error.message, 'error'); }
}

function openCommandPalette() {
  $('#command-modal').hidden = false; $('#command-input').value = ''; state.commandIndex = 0;
  state.commands = [
    { icon: '＋', label: '新建复现工程', hint: 'N', run: () => setView('new-run') },
    { icon: '◈', label: '打开总览', hint: 'G', run: () => setView('overview') },
    { icon: '▤', label: '查看全部项目', hint: '', run: () => setView('projects') },
    { icon: '⚙', label: '运行时设置', hint: '', run: () => setView('settings') },
    { icon: '↻', label: '刷新工作区', hint: '', run: () => void refreshAll() },
    ...state.projects.slice(0, 8).map((project) => ({ icon: '▸', label: `打开：${project.name}`, hint: project.state, run: () => void openProject(project.id) })),
  ];
  renderCommandResults(); $('#command-input').focus();
}
function closeCommandPalette() { $('#command-modal').hidden = true; }
function renderCommandResults() {
  const query = $('#command-input').value.toLowerCase().trim();
  const commands = state.commands.filter((command) => !query || command.label.toLowerCase().includes(query));
  state.commandIndex = Math.min(state.commandIndex, Math.max(0, commands.length - 1));
  $('#command-results').innerHTML = commands.length ? commands.map((command, index) => `<button class="command-result ${index === state.commandIndex ? 'selected' : ''}" data-command-index="${index}" type="button"><span>${command.icon}</span><span>${escapeHtml(command.label)}</span><small>${escapeHtml(command.hint)}</small></button>`).join('') : '<div class="empty-panel">没有匹配命令。</div>';
  $$('.command-result').forEach((button) => button.addEventListener('click', () => { commands[Number(button.dataset.commandIndex)]?.run(); closeCommandPalette(); }));
}
function handleCommandKey(event) {
  const query = $('#command-input').value.toLowerCase().trim();
  const commands = state.commands.filter((command) => !query || command.label.toLowerCase().includes(query));
  if (event.key === 'ArrowDown') { event.preventDefault(); state.commandIndex = Math.min(state.commandIndex + 1, commands.length - 1); renderCommandResults(); }
  if (event.key === 'ArrowUp') { event.preventDefault(); state.commandIndex = Math.max(state.commandIndex - 1, 0); renderCommandResults(); }
  if (event.key === 'Enter') { event.preventDefault(); commands[state.commandIndex]?.run(); closeCommandPalette(); }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const text = await response.text(); let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { message: text } }; }
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}
function toast(message, type = '') {
  const element = $('#toast'); element.textContent = message; element.className = `toast show ${type}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { element.className = 'toast'; }, 3600);
}
function stateClass(value) {
  if (value === 'COMPLETED') return 'success';
  if (value === 'FAILED' || value === 'STOPPED') return 'danger';
  if (value === 'AWAITING_PATCH' || value === 'AWAITING_CLAIMS' || value === 'AWAITING_PLAN') return 'warning';
  return 'neutral';
}
function formatNumber(value) { const number = Number(value); if (!Number.isFinite(number)) return '—'; return Number.isInteger(number) ? String(number) : String(Number(number.toPrecision(6))); }
function formatBytes(bytes) { if (!Number.isFinite(bytes)) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function escapeAttr(value) { return escapeHtml(value); }

document.addEventListener('click', (event) => {
  const projectButton = event.target.closest('[data-open-project]');
  if (projectButton) { event.preventDefault(); void openProject(projectButton.dataset.openProject); }
});
