import { icon, mountIcons } from './icons.js';

const state = {
  view: 'overview', projects: [], current: null, options: null, settings: null,
  events: [], stream: null, pollTimer: null, commandIndex: 0, commands: [],
  filter: 'all', projectTab: 'transcript', settingsTab: 'model', sidebarCollapsed: false, autoscroll: true,

  theme: localStorage.getItem('reprolens-theme') || 'light',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ACTIVE_STATES = new Set(['INITIALIZED', 'INGESTED', 'AWAITING_CLAIMS', 'AWAITING_PLAN', 'SANDBOX_READY', 'EXECUTING', 'AWAITING_PATCH', 'RETRYING', 'VERIFYING', 'REPORTING']);
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'STOPPED']);
const STATE_LABELS = {
  CREATED: '已创建', INITIALIZED: '已初始化', INGESTED: '材料已摄取', AWAITING_CLAIMS: '待选择主张',
  AWAITING_PLAN: '待确认计划', SANDBOX_READY: '执行环境就绪', EXECUTING: '实验执行中', AWAITING_PATCH: '待审批补丁',
  RETRYING: '补丁应用中', VERIFYING: '正在核验', REPORTING: '生成报告', COMPLETED: '已完成', FAILED: '失败', STOPPED: '已停止',
};
const STAGE_MAP = {
  CREATED: 0, INITIALIZED: 0, INGESTED: 0,
  AWAITING_CLAIMS: 1, AWAITING_PLAN: 2, SANDBOX_READY: 3,
  EXECUTING: 3, AWAITING_PATCH: 3, RETRYING: 3, VERIFYING: 4,
  REPORTING: 5, COMPLETED: 5, FAILED: 5, STOPPED: 5,
};
const STAGES = ['材料摄取', '主张选择', '计划确认', '受控执行', '规则核验', '证据交付'];
const RUNNER_LABELS = { auto: '自动选择', local: '本机运行', docker: 'Docker', ssh: 'SSH 主机' };
const CODE_AGENT_LABELS = { none: '关闭', codex: 'Codex CLI', claude: 'Claude Code', gemini: 'Gemini CLI', command: '自定义命令' };
const VIEWS = ['overview', 'projects', 'new-run', 'project', 'settings', 'docs'];

document.addEventListener('DOMContentLoaded', () => { void boot(); });
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#project/')) { void openProject(location.hash.slice('#project/'.length), false); return; }
  if (VIEWS.includes(view) && view !== state.view && view !== 'project') setView(view);
});

async function boot() {
  applyTheme(state.theme);
  bindGlobalEvents();
  mountIcons();
  await Promise.allSettled([checkHealth(), loadOptions(), loadSettings(), loadProjects()]);
  const initialView = location.hash.slice(1);
  if (initialView.startsWith('project/')) { await openProject(initialView.slice('project/'.length), false); return; }
  if (state.projects.length && !initialView) {
    const active = state.projects.find((project) => !TERMINAL_STATES.has(project.state)) ?? state.projects[0];
    if (active && active.state !== 'CREATED') await openProject(active.id, false);
  }
}

function bindGlobalEvents() {
  document.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { event.preventDefault(); setView(viewButton.dataset.view); return; }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) { event.preventDefault(); handleGlobalAction(actionButton.dataset.action); return; }
    const projectButton = event.target.closest('[data-open-project]');
    if (projectButton) { event.preventDefault(); void openProject(projectButton.dataset.openProject); return; }
    const tabButton = event.target.closest('[data-project-tab]');
    if (tabButton) { event.preventDefault(); setProjectTab(tabButton.dataset.projectTab); return; }
    const settingsTab = event.target.closest('[data-settings-tab]');
    if (settingsTab) { event.preventDefault(); setSettingsTab(settingsTab.dataset.settingsTab); return; }
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) { state.filter = filterButton.dataset.filter; renderProjects(); return; }
    const editClaimButton = event.target.closest('[data-edit-claim]');
    if (editClaimButton) { event.preventDefault(); openClaimEditor(editClaimButton.dataset.editClaim); return; }
    const pageButton = event.target.closest('[data-preview-page]');
    if (pageButton) { event.preventDefault(); previewPage(Number(pageButton.dataset.previewPage)); return; }
    const logButton = event.target.closest('[data-preview-log]');
    if (logButton) { event.preventDefault(); previewLog(logButton.dataset.previewLog); return; }
    if (event.target.closest('[data-close-mobile-nav]')) closeMobileNav();
  });
  $('#refresh-button').addEventListener('click', () => void refreshAll());
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#sidebar-collapse').addEventListener('click', toggleSidebar);
  $('#mobile-menu').addEventListener('click', openMobileNav);
  $('#mobile-scrim').addEventListener('click', closeMobileNav);
  $('#load-demo').addEventListener('click', () => void runDemo());
  $('#command-trigger').addEventListener('click', openCommandPalette);
  $('#command-input').addEventListener('input', renderCommandResults);
  $('#command-input').addEventListener('keydown', handleCommandKey);
  $('#project-filter').addEventListener('input', renderProjects);
  $('#paper-file').addEventListener('change', () => void uploadPaper());
  $('#repo-file').addEventListener('change', () => void uploadRepo());
  $('#paper-path').addEventListener('input', refreshNewRunChecks);
  $('#repo-path').addEventListener('input', refreshNewRunChecks);
  $('#project-name-input').addEventListener('input', refreshNewRunChecks);
  $$('input[name="runner-choice"]').forEach((input) => input.addEventListener('change', refreshRunnerFields));
  $('#enable-gpu').addEventListener('change', refreshNewRunChecks);
  $('#code-agent-enabled').addEventListener('change', () => { $('#code-agent-fields').hidden = !$('#code-agent-enabled').checked; refreshNewRunChecks(); });
  $('#code-agent-select').addEventListener('change', refreshCodeAgentFields);
  ['#max-runs', '#max-seconds', '#max-patches'].forEach((selector) => $(selector).addEventListener('input', refreshNewRunChecks));
  $('#new-run-form').addEventListener('submit', (event) => { event.preventDefault(); void createProject(); });
  $('#select-claims-button').addEventListener('click', () => void selectClaims());
  $('#approve-patch-button').addEventListener('click', () => void projectAction('approve'));
  $('#reject-patch-button').addEventListener('click', () => void projectAction('reject'));
  $('#copy-diff-button').addEventListener('click', copyDiff);
  $('#regenerate-report-summary').addEventListener('click', () => void regenerateReportSummary());
  $('#save-settings-button').addEventListener('click', () => void saveSettings());
  $('#test-llm-button').addEventListener('click', () => void testLLM());
  $('#settings-llm-preset').addEventListener('change', applyModelPreset);
  $('#close-preview').addEventListener('click', closePreview);
  $('#preview-dialog').addEventListener('click', (event) => { if (event.target === $('#preview-dialog')) closePreview(); });
  $('#command-dialog').addEventListener('click', (event) => { if (event.target === $('#command-dialog')) closeCommandPalette(); });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); }
    if (event.key === 'Escape') { if ($('#command-dialog').open) closeCommandPalette(); if ($('#preview-dialog').open) closePreview(); }
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
  $$('.docs-nav a').forEach((link) => link.addEventListener('click', () => {
    $$('.docs-nav a').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  }));
  refreshRunnerFields();
  refreshCodeAgentFields();
  refreshNewRunChecks();
}

function setView(view) {
  if (view === 'project' && !state.current) view = 'projects';
  state.view = view;
  $$('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === view));
  $('#crumb-current').textContent = { overview: '科研工作台', projects: '复现项目', 'new-run': '新建复现', project: state.current?.name || '项目详情', settings: '模型与算力', docs: '指南与接口' }[view] || view;
  if (view === 'overview') renderOverview();
  if (view === 'projects') renderProjects();
  if (view === 'settings') fillSettingsForm();
  const targetHash = view === 'project' && state.current ? '#project/' + state.current.id : '#' + view;
  if (location.hash !== targetHash) history.replaceState(null, '', targetHash);
  closeMobileNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleGlobalAction(action) {
  if (action === 'new-run') setView('new-run');
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  $('.app-shell').classList.toggle('nav-collapsed', state.sidebarCollapsed);
  localStorage.setItem('reprolens-sidebar', state.sidebarCollapsed ? 'collapsed' : 'open');
}

function openMobileNav() { $('.app-shell').classList.add('mobile-nav-open'); $('#mobile-scrim').hidden = false; }
function closeMobileNav() { $('.app-shell').classList.remove('mobile-nav-open'); $('#mobile-scrim').hidden = true; }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('reprolens-theme', state.theme);
  applyTheme(state.theme);
}

async function checkHealth() {
  try { const health = await api('/healthz'); setHealth(true, health.service); }
  catch { setHealth(false, 'offline'); }
}
function setHealth(ok, label) {
  $('#health-dot').classList.toggle('ok', ok);
  $('#health-label').textContent = ok ? '服务在线' : '服务离线';
}

async function loadOptions() {
  try {
    state.options = await api('/api/v1/options');
    $('#settings-llm-preset').innerHTML = '<option value="">选择预设…</option>' + state.options.model_presets.map((item, index) => `<option value="${index}">${escapeHtml(item.label)}</option>`).join('');
  } catch (error) { toast(`无法读取系统选项：${error.message}`, 'error'); }
}
async function loadSettings() {
  try { state.settings = await api('/api/v1/settings'); fillSettingsForm(); renderRuntimeConfig(); }
  catch (error) { console.error('loadSettings failed', error); state.settings = null; renderRuntimeConfig(); }
}
async function loadProjects() {
  try {
    state.projects = await api('/api/v1/projects');
    $('#project-count').textContent = String(state.projects.length);
    renderOverview(); renderProjects();
  } catch (error) { toast(`无法读取项目：${error.message}`, 'error'); }
}
async function refreshAll() {
  await Promise.allSettled([checkHealth(), loadProjects(), loadSettings()]);
  if (state.current) await openProject(state.current.id, false);
  toast('工作区已刷新', 'ok');
}

async function runDemo() {
  const button = $('#load-demo');
  button.disabled = true;
  try {
    const project = await api('/api/v1/demo', { method: 'POST', body: JSON.stringify({}) });
    state.current = await api(`/api/v1/projects/${project.id}/start`, { method: 'POST', body: JSON.stringify({}) });
    await loadProjects();
    setView('project');
    renderProject();
    subscribeProjectEvents(project.id);
    startProjectPolling();
    toast('演示项目已创建，材料摄取完成', 'ok');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function openProject(id, announce = true) {
  try {
    if (state.stream) { state.stream.close(); state.stream = null; }
    state.current = await api(`/api/v1/projects/${id}`);
    state.events = await api(`/api/v1/projects/${id}/events`);
    state.projectTab = 'transcript';
    setView('project');
    renderProject();
    subscribeProjectEvents(id);
    startProjectPolling();
    if (announce) toast(`已打开「${state.current.name}」`);
  } catch (error) { toast(`无法打开项目：${error.message}`, 'error'); }
}

function renderOverview() {
  const active = state.projects.filter((project) => !TERMINAL_STATES.has(project.state)).length;
  const verdicts = state.projects.filter((project) => project.verification).length;
  const runs = state.projects.reduce((sum, project) => sum + (project.runs?.length ?? 0), 0);
  $('#metric-projects').textContent = String(state.projects.length);
  $('#metric-active').textContent = String(active);
  $('#metric-verdicts').textContent = String(verdicts);
  $('#metric-runs').textContent = String(runs);
  const featured = state.projects.find((project) => !TERMINAL_STATES.has(project.state)) ?? state.projects[0];
  $('#featured-project').innerHTML = featured ? featuredProject(featured) : emptyFeatured();
  $('#overview-projects').innerHTML = state.projects.length
    ? state.projects.slice(0, 5).map(projectRow).join('')
    : emptyProjects('工作区还没有复现项目', '运行内置演示，或从一份论文开始。');
  renderRuntimeConfig();
}

function featuredProject(project) {
  const stage = STAGE_MAP[project.state] ?? 0;
  const progress = Math.round(((stage + (project.state === 'COMPLETED' ? 1 : 0)) / STAGES.length) * 100);
  const verdict = project.verification?.verdict;
  return `<div class="featured">
    <div class="featured-main">
      <div class="featured-kicker">${statusBadge(project.state)}<span class="project-id mono">${escapeHtml(project.id)}</span></div>
      <h3>${escapeHtml(project.name)}</h3>
      <p>${escapeHtml(project.paper?.title || '等待论文材料摄取')}</p>
      <div class="featured-path"><span data-icon="file"></span><span>${escapeHtml(project.paper_path || '未指定论文')}</span></div>
      <div class="featured-progress"><div class="progress-rail"><span style="width:${progress}%"></span></div><small>${Math.max(0, stage)} / 5 阶段 · ${STATE_LABELS[project.state] || project.state}</small></div>
      <div class="featured-actions"><button class="button primary small" data-open-project="${escapeAttr(project.id)}" type="button">打开工作区<span data-icon="arrow"></span></button>${project.state === 'AWAITING_PATCH' ? '<button class="button secondary small" data-open-project="' + escapeAttr(project.id) + '" type="button">审批补丁</button>' : ''}</div>
    </div>
    <div class="featured-side">
      <div class="featured-metric"><span>实验主张</span><strong>${project.claims?.length ?? 0}</strong></div>
      <div class="featured-metric"><span>运行次数</span><strong>${project.runs?.length ?? 0}</strong></div>
      <div class="featured-metric"><span>核验结论</span><strong style="font-size:14px;color:${verdict ? 'var(--success)' : 'var(--ink-muted)'}">${verdict ?? '待核验'}</strong></div>
    </div>
  </div>`;
}

function emptyFeatured() {
  return `<div class="featured"><div class="featured-main"><div class="featured-kicker"><span class="status-badge">开始研究</span></div><h3>从一份论文开始复现</h3><p>上传原始 PDF 和代码仓库，ReproLens 将把论文中的可测主张转化为受控实验，并生成可审查的证据。</p><div class="featured-actions"><button class="button primary small" data-action="new-run" type="button"><span data-icon="plus"></span>新建复现</button><button class="button secondary small" id="featured-demo" type="button"><span data-icon="play"></span>运行演示</button></div></div><div class="featured-side"><div class="featured-metric"><span>工作方式</span><strong style="font-size:13px">证据驱动</strong></div><div class="featured-metric"><span>人工确认</span><strong style="font-size:13px">补丁审批</strong></div><div class="featured-metric"><span>交付</span><strong style="font-size:13px">报告 + ZIP</strong></div></div></div>`;
}

function projectRow(project) {
  return `<button class="project-row" data-open-project="${escapeAttr(project.id)}" type="button">
    <div class="project-row-title"><span class="project-symbol"><span data-icon="file"></span></span><span class="project-name-block"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.paper?.title || project.paper_path || project.id)}</small></span></div>
    <div><span class="row-label">状态</span>${statusBadge(project.state)}</div>
    <div><span class="row-label">实验运行</span><span class="row-value">${project.runs?.length ?? 0} runs</span></div>
    <div><span class="row-label">核验结论</span><span class="row-value">${project.verification?.verdict ?? '—'}</span></div>
    <span class="row-arrow" aria-hidden="true"><span data-icon="chevron"></span></span>
  </button>`;
}

function emptyProjects(title, text) {
  return `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div></div>`;
}

function renderProjects() {
  const filter = ($('#project-filter')?.value || '').toLowerCase().trim();
  let projects = state.projects.filter((project) => {
    if (state.filter === 'active' && TERMINAL_STATES.has(project.state)) return false;
    if (state.filter === 'completed' && project.state !== 'COMPLETED') return false;
    if (state.filter === 'failed' && !['FAILED', 'STOPPED'].includes(project.state)) return false;
    return !filter || `${project.name} ${project.state} ${STATE_LABELS[project.state]} ${project.paper?.title || ''}`.toLowerCase().includes(filter);
  });
  $('#project-filter-count').textContent = `${projects.length} 个项目`;
  $$('#project-status-filters button').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
  $('#project-list').innerHTML = projects.length ? projects.map(projectRow).join('') : emptyProjects('没有匹配的项目', '尝试调整筛选条件，或创建新的复现实验。');
  if (!$('#overview-projects').children.length) {
    $('#overview-projects').innerHTML = state.projects.length ? state.projects.slice(0, 5).map(projectRow).join('') : emptyProjects('工作区还没有复现项目', '运行内置演示，或从一份论文开始。');
  }
}

function renderRuntimeConfig() {
  const settings = state.settings;
  if (!settings) { $('#runtime-config').innerHTML = '<div class="empty-state compact">运行时设置暂不可用。</div>'; return; }
  const rows = [
    ['论文理解模型', settings.llm?.model || '未配置'],
    ['模型接口', settings.llm?.baseURL || '未配置'],
    ['执行器', RUNNER_LABELS[settings.runner] || settings.runner],
    ['GPU 加速', settings.enableGPU ? '已启用' : '关闭'],
    ['代码 Agent', CODE_AGENT_LABELS[settings.codeAgent?.type] || '关闭'],
  ];
  $('#runtime-config').innerHTML = rows.map(([key, value]) => `<div class="runtime-line"><span>${key}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
}

function statusBadge(stateName) {
  const tone = stateName === 'COMPLETED' ? 'success' : ['FAILED', 'STOPPED'].includes(stateName) ? 'danger' : ['AWAITING_CLAIMS', 'AWAITING_PLAN', 'AWAITING_PATCH'].includes(stateName) ? 'warning' : ACTIVE_STATES.has(stateName) ? 'neutral' : '';
  return `<span class="status-badge ${tone}">${STATE_LABELS[stateName] || escapeHtml(stateName)}</span>`;
}

function renderProject() {
  const project = state.current;
  if (!project) return;
  mountIcons();
  $('#project-detail-name').textContent = project.name;
  $('#project-detail-meta').textContent = `${project.id} · ${project.paper?.sha256 ? 'sha256:' + project.paper.sha256.slice(0, 16) : '等待材料摄取'}`;
  $('#project-eyebrow').textContent = project.id;
  const badge = $('#project-state-badge');
  badge.textContent = STATE_LABELS[project.state] || project.state;
  badge.className = `status-badge ${project.state === 'COMPLETED' ? 'success' : ['FAILED', 'STOPPED'].includes(project.state) ? 'danger' : ['AWAITING_CLAIMS', 'AWAITING_PLAN', 'AWAITING_PATCH'].includes(project.state) ? 'warning' : 'neutral'}`;
  $('#project-stat-claims').textContent = String(project.claims?.length ?? 0);
  $('#project-stat-runs').textContent = String(project.runs?.length ?? 0);
  $('#project-stat-verdict').textContent = project.verification?.verdict ?? '—';
  $('#project-stat-verdict').style.color = project.verification?.verdict === 'PASS' ? 'var(--success)' : project.verification?.verdict && project.verification.verdict !== 'PASS' ? 'var(--danger)' : '';
  const errorBanner = $('#project-error-banner');
  if (errorBanner) {
    errorBanner.hidden = !project.error;
    const textNode = errorBanner.querySelector('span:last-child');
    if (textNode) textNode.textContent = project.error || '';
  }
  renderProjectActions(project);
  renderProgress(project);
  renderClaims(project);
  renderPlans(project);
  renderRuns(project);
  renderPatch(project);
  renderVerification(project);
  renderPaperPages(project);
  renderEvidence(project);
  renderContext(project);
  renderEvents();
  renderTranscript();
  setProjectTab(state.projectTab, false);
}

function renderProjectActions(project) {
  const actions = [];
  if (project.state === 'CREATED') actions.push('<button class="button primary small" data-project-action="start" type="button"><span data-icon="play"></span>开始材料摄取</button>');
  if (project.error) actions.push(`<span class="status-badge danger" title="${escapeAttr(project.error)}">需要处理</span>`);
  if (project.state === 'AWAITING_PLAN') actions.push('<button class="button primary small" data-project-action="confirm" type="button"><span data-icon="play"></span>确认并执行</button>');
  if (project.state === 'AWAITING_PATCH') actions.push('<button class="button secondary small" data-project-action="approve" type="button"><span data-icon="check"></span>批准补丁</button>', '<button class="button danger small" data-project-action="reject" type="button">拒绝</button>');
  if (ACTIVE_STATES.has(project.state)) actions.push('<button class="button secondary small" data-project-action="stop" type="button"><span data-icon="pause"></span>停止</button>');
  if (project.report?.markdown) actions.push('<a class="button secondary small" href="/api/v1/projects/' + encodeURIComponent(project.id) + '/report.html" target="_blank" rel="noreferrer">查看报告</a>');
  if (project.report?.package_path) actions.push('<a class="button primary small" href="/api/v1/projects/' + encodeURIComponent(project.id) + '/package"><span data-icon="download"></span>证据包</a>');
  $('#project-actions').innerHTML = actions.join('');
  $$('[data-project-action]').forEach((button) => button.addEventListener('click', () => void projectAction(button.dataset.projectAction)));
}

function renderProgress(project) {
  const current = STAGE_MAP[project.state] ?? 0;
  const failed = ['FAILED', 'STOPPED'].includes(project.state);
  $('#state-strip').innerHTML = STAGES.map((stage, index) => {
    const done = index < current || project.state === 'COMPLETED';
    const active = index === current && !failed;
    return `<div class="progress-step ${done ? 'done' : ''} ${active ? 'current' : ''} ${failed && index === current ? 'failed' : ''}"><span class="marker">${done ? '✓' : index + 1}</span><span>${stage}</span></div>`;
  }).join('');
}

function renderClaims(project) {
  const claims = project.claims ?? [];
  const canSelect = project.state === 'AWAITING_CLAIMS';
  $('#select-claims-button').disabled = !canSelect;
  $('#claims-list').innerHTML = claims.length ? claims.map((claim) => `<label class="claim-row">
    <input type="checkbox" data-claim-id="${escapeAttr(claim.claim_id)}" ${claim.selected ? 'checked' : ''} ${canSelect ? '' : 'disabled'}>
    <span class="claim-content"><strong>${escapeHtml(claim.claim_id)} · ${escapeHtml(claim.metric)}</strong><p>${escapeHtml(claim.text)}</p><small>${escapeHtml(claim.source?.path || '')}:${claim.source?.line || 0} · abs tolerance ${claim.tolerance?.abs ?? 0}</small></span>
    <span class="claim-value"><strong>${formatNumber(claim.expected_value)}</strong><span>expected</span>${canSelect ? `<button class="claim-edit" data-edit-claim="${escapeAttr(claim.claim_id)}" type="button">校正</button>` : ''}</span>
  </label>`).join('') : '<div class="empty-state compact">开始材料摄取后显示论文中的可测主张。</div>';
}

function renderPlans(project) {
  const plans = project.plans ?? [];
  $('#plan-count').textContent = `${plans.length} 个计划`;
  $('#plans-list').innerHTML = plans.length ? plans.map((plan) => `<div class="plan-row">
    <div class="plan-head"><strong>${escapeHtml(plan.claim_id)} · ${escapeHtml(plan.expected_metric)}</strong>${plan.confirmed ? '<span class="status-badge success">已确认</span>' : '<span class="status-badge">待确认</span>'}</div>
    <div class="plan-command"><span data-icon="terminal"></span><span>${escapeHtml(plan.command)}</span></div>
    <div class="plan-meta"><span>seed ${plan.seed}</span><span>${escapeHtml(plan.image)}</span><span>work_dir ${escapeHtml(plan.work_dir)}</span><span>abs tol ${plan.tolerance?.abs ?? 0}</span></div>
  </div>`).join('') : '<div class="empty-state compact">选择实验主张后生成可审计的实验计划。</div>';
}

function renderRuns(project) {
  const runs = project.runs ?? [];
  $('#run-count').textContent = `${runs.length} 次运行`;
  $('#runs-tab-count').textContent = String(runs.length);
  $('#runs-list').innerHTML = runs.length ? runs.map((run) => `<div class="run-row">
    <div class="run-head"><strong>RUN ${String(run.attempt).padStart(2, '0')} · ${escapeHtml(run.runner)}</strong>${statusBadge(run.status === 'succeeded' ? 'COMPLETED' : run.status === 'timeout' ? 'STOPPED' : 'FAILED')}</div>
    <div class="run-meta"><span>exit ${run.exit_code}</span><span>${run.duration_ms} ms</span><span>${escapeHtml(run.command)}</span>${run.gpu ? '<span>GPU</span>' : ''}${run.provider ? `<span>${escapeHtml(run.provider)}</span>` : ''}${run.offer_id ? `<span>${escapeHtml(run.offer_id)}</span>` : ''}</div>
    ${run.failure_class ? `<div class="run-failure">${escapeHtml(run.failure_class)} · ${escapeHtml(run.failure_summary || '')}</div>` : ''}
    ${run.metric ? `<div class="run-meta"><span>metric ${escapeHtml(run.metric.name)} = ${formatNumber(run.metric.value)}</span></div>` : ''}
    <div class="run-actions"><button type="button" data-preview-log="${escapeAttr(run.stdout_path || '')}">查看 stdout</button><button type="button" data-preview-log="${escapeAttr(run.stderr_path || '')}">查看 stderr</button></div>
  </div>`).join('') : '<div class="empty-state compact">尚未开始实验运行。</div>';
}

function renderPatch(project) {
  const panel = $('#patch-panel');
  if (!project.patch) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#patch-status').textContent = project.patch.status;
  $('#patch-status').className = `status-badge ${project.patch.status === 'applied' ? 'success' : project.patch.status === 'rejected' ? 'danger' : 'warning'}`;
  $('#patch-diagnosis').textContent = `${project.patch.diagnosis.failure_class} · ${project.patch.diagnosis.root_cause}${project.patch.diagnosis.explanation ? ' — ' + project.patch.diagnosis.explanation : ''}`;
  $('#patch-diff').textContent = project.patch.diff || '';
  const actionable = project.state === 'AWAITING_PATCH' && project.patch.status === 'proposed';
  $('#approve-patch-button').disabled = !actionable;
  $('#reject-patch-button').disabled = !actionable;
}

function renderVerification(project) {
  const panel = $('#verification-panel');
  if (!project.verification) { panel.hidden = true; return; }
  panel.hidden = false;
  const verification = project.verification;
  $('#verdict-pill').textContent = verification.verdict;
  $('#verdict-pill').className = `verdict ${verification.verdict.toLowerCase()}`;
  $('#verification-body').innerHTML = `<div class="verdict-grid">
    <div><span>论文期望</span><strong>${formatNumber(verification.expected)}</strong></div>
    <div><span>实验观测</span><strong>${formatNumber(verification.observed)}</strong></div>
    <div><span>绝对容差</span><strong>±${formatNumber(verification.tolerance?.abs ?? 0)}</strong></div>
  </div><div class="rule-line">${escapeHtml(verification.rule)}${verification.note ? ' · ' + escapeHtml(verification.note) : ''}</div>`;
}

function renderPaperPages(project) {
  const pages = project.paper?.pages ?? [];
  $('#paper-tab-count').textContent = String(pages.length);
  $('#paper-page-caption').textContent = `${pages.length} 页`;
  $('#paper-pages').innerHTML = pages.length ? pages.map((page) => `<button class="page-card ${page.image_path ? '' : 'no-image'}" data-preview-page="${page.page_number}" type="button">
    <span class="page-thumb">${page.image_path ? `<img src="/api/v1/projects/${encodeURIComponent(project.id)}/evidence/paper/page-${String(page.page_number).padStart(3, '0')}.png" alt="论文第 ${page.page_number} 页" loading="lazy">` : '无页面图像'}</span>
    <span class="page-meta"><span>PAGE ${String(page.page_number).padStart(3, '0')}</span><span>${page.width ? `${page.width} × ${page.height}` : 'TEXT'}</span></span>
  </button>`).join('') : '<div class="empty-state compact">论文尚未摄取，或该格式没有页面图像。</div>';
}

function renderEvidence(project) {
  const rows = [];
  if (project.paper?.source_path) rows.push({ icon: 'file', title: '原始论文', note: project.paper.source_path, href: null });
  if (project.report?.markdown) rows.push({ icon: 'file', title: '中文实验报告', note: '文档视图，支持打印与导出 PDF', href: `/api/v1/projects/${encodeURIComponent(project.id)}/report.html` });
  if (project.report?.package_path) rows.push({ icon: 'download', title: '下载复现证据包', note: '报告、日志、补丁、原始 PDF 与页面图像', href: `/api/v1/projects/${encodeURIComponent(project.id)}/package` });
  if (project.patch?.diff) rows.push({ icon: 'code', title: `补丁 · ${project.patch.status}`, note: project.patch.files?.join(', ') || '代码变更', href: null });
  $('#evidence-content').innerHTML = rows.length ? rows.map((row) => `<div class="evidence-row"><span class="evidence-icon"><span data-icon="${row.icon}"></span></span><span class="evidence-copy"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.note)}</small></span>${row.href ? `<a class="button secondary small" href="${row.href}" ${row.href.endsWith('.md') ? 'target="_blank" rel="noreferrer"' : ''}>打开<span data-icon="arrow"></span></a>` : '<span class="status-badge">已归档</span>'}</div>`).join('') : '<div class="empty-state compact">完成核验后生成报告与证据包。</div>';
}

function renderContext(project) {
  $('#source-index').innerHTML = [
    ['论文标题', project.paper?.title || '—'],
    ['代码仓库', project.repo_path || '—'],
    ['SHA-256', project.paper?.sha256?.slice(0, 20) || '—'],
    ['论文页数', String(project.paper?.pages?.length ?? 0)],
  ].map(([key, value]) => `<div class="context-item"><span>${key}</span><strong title="${escapeAttr(value)}">${escapeHtml(value)}</strong></div>`).join('');
  $('#project-runtime').innerHTML = [
    ['执行器', project.runs?.[0]?.runner || RUNNER_LABELS[state.settings?.runner] || '—'],
    ['运行镜像', project.plans?.[0]?.image || '—'],
    ['GPU', project.runs?.some((run) => run.gpu) ? '已使用' : state.settings?.enableGPU ? '已启用' : '未启用'],
    ['运行次数', String(project.runs?.length ?? 0)],
    ['补丁审批', project.patch ? project.patch.status : '无补丁'],
  ].map(([key, value]) => `<div class="context-item"><span>${key}</span><strong title="${escapeAttr(String(value))}">${escapeHtml(String(value))}</strong></div>`).join('');
}

function renderEvents() {
  const events = [...state.events].sort((a, b) => a.seq - b.seq);
  $('#event-log').innerHTML = events.length ? events.slice(-30).map((event) => `<div class="event-row ${escapeAttr(event.type)}"><code>#${event.seq} · ${escapeHtml(event.type)}</code><p>${escapeHtml(event.message)}</p></div>`).join('') : '<div class="empty-state compact">等待事件。</div>';
  const log = $('#event-log'); log.scrollTop = log.scrollHeight;
}

function setProjectTab(tab, scroll = true) {
  state.projectTab = ['transcript', 'workflow', 'paper', 'runs', 'evidence', 'report'].includes(tab) ? tab : 'transcript';
  $$('[data-project-tab]').forEach((button) => {
    const active = button.dataset.projectTab === state.projectTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-project-tab-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.projectTabPanel === state.projectTab));
  if (state.projectTab === 'report' && state.current) {
    const frame = $('#report-frame');
    const url = `/api/v1/projects/${encodeURIComponent(state.current.id)}/report.html`;
    if (frame && frame.getAttribute('src') !== url) frame.setAttribute('src', url);
    const link = $('#report-open-link');
    if (link) link.href = url;
  }
  if (scroll) $('#main-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const EVENT_META = {
  project_created: { icon: 'circle', label: '创建项目' },
  repository_copied: { icon: 'folder', label: '复制代码仓库' },
  claims_extracted: { icon: 'file', label: '提取实验主张' },
  plans_ready: { icon: 'list', label: '生成实验计划' },
  sandbox_ready: { icon: 'shield', label: '准备执行环境' },
  state_changed: { icon: 'activity', label: '状态转移' },
  run_started: { icon: 'play', label: '启动实验' },
  run_output: { icon: 'terminal', label: '进程输出' },
  run_completed: { icon: 'check', label: '实验结束' },
  metric_unavailable: { icon: 'alert', label: '指标不可用' },
  diagnosis_completed: { icon: 'flask', label: '故障诊断' },
  code_agent_proposed: { icon: 'code', label: '代码 Agent 产出补丁' },
  patch_proposed: { icon: 'code', label: '等待补丁审批' },
  patch_approved: { icon: 'check', label: '人工批准补丁' },
  patch_applied: { icon: 'check', label: '应用补丁' },
  patch_rejected: { icon: 'x', label: '拒绝补丁' },
  metric_verified: { icon: 'check', label: '规则核验完成' },
  report_summary_started: { icon: 'spark', label: '主 Agent 总结中' },
  report_summary_generated: { icon: 'check', label: '主 Agent 总结完成' },
  report_summary_fallback: { icon: 'alert', label: '主 Agent 总结回退' },
  report_generated: { icon: 'evidence', label: '生成证据报告' },
  workflow_failed: { icon: 'alert', label: '工作流失败' },
  workflow_stopped: { icon: 'pause', label: '工作流停止' },
  stop_requested: { icon: 'pause', label: '请求停止' },
};

function renderTranscript() {
  const container = $('#transcript');
  if (!container) return;
  const events = [...state.events].sort((a, b) => a.seq - b.seq);
  if (!events.length) {
    container.innerHTML = '<div class="empty-state compact">开始执行后，Agent 的完整过程会在这里实时展开。</div>';
    return;
  }
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  container.innerHTML = groupTranscriptEvents(events).map((event) => transcriptEntry(event)).join('');
  if (state.autoscroll && atBottom) container.scrollTop = container.scrollHeight;
  const running = state.current && ACTIVE_STATES.has(state.current.state);
  const live = $('#transcript-live');
  if (live) live.hidden = !running;
  const status = $('#transcript-status');
  if (status) status.textContent = running ? '正在执行' : TERMINAL_STATES.has(state.current?.state) ? '执行已结束' : '等待执行';
  mountIcons(container);
}


function groupTranscriptEvents(events) {
  const grouped = [];
  for (const event of events) {
    const last = grouped[grouped.length - 1];
    const sameOutput = event.type === 'run_output' && last && last.type === 'run_output'
      && last.data?.run_id === event.data?.run_id
      && last.data?.stream === event.data?.stream;
    if (sameOutput) {
      last.message += '\n' + event.message;
      last.lastSeq = event.seq;
      last.created_at = event.created_at;
      last.count = (last.count ?? 1) + 1;
      continue;
    }
    grouped.push({ ...event, lastSeq: event.seq, count: 1 });
  }
  return grouped;
}
function transcriptEntry(event) {
  const meta = EVENT_META[event.type] || { icon: 'circle', label: event.type };
  const data = event.data || {};
  const output = event.type === 'run_output';
  const body = [];
  if (event.type === 'run_started') {
    body.push(`<span class="transcript-command">${icon('terminal')}${escapeHtml(String(data.command || ''))}</span>`);
    body.push(`<div class="transcript-meta"><span>attempt ${data.attempt ?? 1}</span><span>${escapeHtml(String(data.runner || ''))}</span><span>seed ${data.seed ?? '—'}</span></div>`);
  } else if (output) {
    body.push(`<span class="transcript-output ${data.stream === 'stderr' ? 'stderr' : ''}">${escapeHtml(event.message.replace(/\u00a0/g, ' '))}</span>`);
  } else if (event.type === 'run_completed') {
    body.push(`<div class="transcript-meta"><span>${escapeHtml(String(data.status || ''))}</span><span>exit ${data.exit_code ?? '—'}</span><span>${data.duration_ms ?? 0} ms</span></div>`);
  } else if (event.type === 'metric_verified') {
    body.push(`<div class="transcript-meta"><span>${escapeHtml(String(data.verdict || ''))}</span><span>expected ${formatNumber(data.expected)}</span><span>observed ${formatNumber(data.observed)}</span></div>`);
  } else if (event.type === 'diagnosis_completed') {
    body.push(`<div class="transcript-meta"><span>${escapeHtml(String(data.failure_class || ''))}</span><span>confidence ${escapeHtml(String(data.confidence || ''))}</span></div>`);
  } else if (event.type !== 'state_changed' && event.message && event.message !== meta.label) {
    body.push(`<div class="transcript-body">${escapeHtml(event.message)}</div>`);
  }
  return `<div class="transcript-entry ${escapeAttr(event.type)}">
    <span class="transcript-icon">${icon(meta.icon)}</span>
    <div class="transcript-content">
      <div class="transcript-head"><strong>${escapeHtml(meta.label)}</strong><span>#${event.seq}${event.lastSeq && event.lastSeq !== event.seq ? '–' + event.lastSeq : ''}</span>${event.count > 1 ? `<span>${event.count} 个流式块</span>` : ''}<span class="transcript-time">${formatTime(event.created_at)}</span></div>
      ${body.join('')}
    </div>
  </div>`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false });
}
async function regenerateReportSummary() {
  if (!state.current?.report) return toast('报告尚未生成', 'error');
  const button = $('#regenerate-report-summary');
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = '主 Agent 正在总结…';
  try {
    state.current = await api(`/api/v1/projects/${encodeURIComponent(state.current.id)}/report/summarize`, { method: 'POST', body: '{}' });
    const frame = $('#report-frame');
    if (frame) frame.src = `/api/v1/projects/${encodeURIComponent(state.current.id)}/report.html?t=${Date.now()}`;
    renderProjectActions(state.current);
    toast('主 Agent 总结已更新，报告与证据包已重新生成', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
    mountIcons(button);
  }
}

async function projectAction(action) {
  if (!state.current) return;
  const project = state.current;
  try {
    if (action === 'start') state.current = await api(`/api/v1/projects/${project.id}/start`, { method: 'POST', body: '{}' });
    if (action === 'confirm') {
      state.current = await api(`/api/v1/projects/${project.id}/plan/confirm`, { method: 'POST', body: '{}' });
      await new Promise((resolve) => setTimeout(resolve, 900));
      state.current = await api(`/api/v1/projects/${project.id}`);
    }
    if (action === 'approve') {
      state.current = await api(`/api/v1/projects/${project.id}/patch/approve`, { method: 'POST', body: JSON.stringify({ approved_by: 'web-console' }) });
      await new Promise((resolve) => setTimeout(resolve, 900));
      state.current = await api(`/api/v1/projects/${project.id}`);
    }
    if (action === 'reject') state.current = await api(`/api/v1/projects/${project.id}/patch/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected in web console' }) });
    if (action === 'stop') state.current = await api(`/api/v1/projects/${project.id}/stop`, { method: 'POST', body: '{}' });
    renderProject();
    await loadProjects();
    toast(`操作已提交：${{ start: '材料摄取', confirm: '确认计划', approve: '批准补丁', reject: '拒绝补丁', stop: '停止实验' }[action] || action}`, 'ok');
    startProjectPolling();
  } catch (error) { toast(error.message, 'error'); }
}

async function selectClaims() {
  if (!state.current) return;
  const claimIds = $$('[data-claim-id]:checked').map((input) => input.dataset.claimId);
  if (!claimIds.length) return toast('请至少选择一条实验主张', 'error');
  try {
    state.current = await api(`/api/v1/projects/${state.current.id}/claims`, { method: 'POST', body: JSON.stringify({ claim_ids: claimIds }) });
    renderProject(); await loadProjects();
    toast('实验计划已生成，请确认后执行', 'ok');
  } catch (error) { toast(error.message, 'error'); }
}

function startProjectPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.current) return;
    try {
      const latest = await api(`/api/v1/projects/${state.current.id}`);
      state.current = latest; renderProject();
      if (TERMINAL_STATES.has(latest.state) && state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      await loadProjects();
    } catch { /* retry on next tick */ }
  }, 1600);
}

function subscribeProjectEvents(projectId) {
  if (state.stream) state.stream.close();
  const after = state.events.at(-1)?.seq || 0;
  const stream = new EventSource(`/api/v1/projects/${encodeURIComponent(projectId)}/events/stream?after=${after}`);
  state.stream = stream;
  stream.addEventListener('reprolens', (event) => {
    try { const parsed = JSON.parse(event.data); if (!state.events.some((item) => item.seq === parsed.seq)) state.events.push(parsed); renderEvents(); renderTranscript(); }
    catch { /* ignore malformed SSE */ }
  });
}


function openClaimEditor(claimId) {
  const claim = state.current?.claims?.find((item) => item.claim_id === claimId);
  if (!claim) return;
  $('#preview-overline').textContent = 'CLAIM REVIEW';
  $('#preview-title').textContent = `校正研究主张 · ${claim.claim_id}`;
  $('#preview-body').innerHTML = `<form class="claim-editor" id="claim-editor-form">
    <div class="field full"><label for="claim-editor-text">主张原文</label><input id="claim-editor-text" value="${escapeAttr(claim.text)}"></div>
    <div class="field"><label for="claim-editor-metric">指标</label><input id="claim-editor-metric" value="${escapeAttr(claim.metric)}"></div>
    <div class="field"><label for="claim-editor-expected">期望值</label><input id="claim-editor-expected" type="number" step="any" value="${claim.expected_value}"></div>
    <div class="field"><label for="claim-editor-tolerance">绝对容差</label><input id="claim-editor-tolerance" type="number" step="any" min="0" value="${claim.tolerance?.abs ?? 0}"></div>
    <p class="claim-editor-note">论文抽取可能受表格排版影响。研究员确认后的期望值与容差将作为规则核验的唯一依据；模型无法修改该值。</p>
  </form>`;
  $('#preview-footer').innerHTML = '<button class="button primary small" id="save-claim-button" type="button">保存并确认主张</button><button class="button secondary small" id="cancel-claim-button" type="button">取消</button>';
  $('#preview-dialog').showModal();
  $('#save-claim-button').addEventListener('click', () => void saveClaimEditor(claim.claim_id));
  $('#cancel-claim-button').addEventListener('click', closePreview);
}

async function saveClaimEditor(claimId) {
  try {
    state.current = await api(`/api/v1/projects/${state.current.id}/claims/${encodeURIComponent(claimId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        text: $('#claim-editor-text').value,
        metric: $('#claim-editor-metric').value,
        expected_value: Number($('#claim-editor-expected').value),
        tolerance_abs: Number($('#claim-editor-tolerance').value),
      }),
    });
    closePreview();
    renderProject();
    toast('主张已确认，可用于生成实验计划', 'ok');
  } catch (error) { toast(error.message, 'error'); }
}
function previewPage(pageNumber) {
  if (!state.current) return;
  $('#preview-overline').textContent = 'PAPER VISUAL EVIDENCE';
  $('#preview-title').textContent = `论文第 ${pageNumber} 页`;
  $('#preview-body').innerHTML = `<img src="/api/v1/projects/${encodeURIComponent(state.current.id)}/evidence/paper/page-${String(pageNumber).padStart(3, '0')}.png" alt="论文第 ${pageNumber} 页">`;
  $('#preview-footer').textContent = `PAGE ${String(pageNumber).padStart(3, '0')} · 原始 PDF 保留版式、图表与公式`;
  $('#preview-dialog').showModal();
}

function previewLog(path) {
  if (!path || !state.current) return;
  const relative = evidenceRelativePath(path);
  $('#preview-overline').textContent = 'EXECUTION LOG';
  $('#preview-title').textContent = relative;
  $('#preview-body').innerHTML = '<div class="loading-state"><span class="spinner"></span>正在读取日志…</div>';
  $('#preview-footer').textContent = 'RUN EVIDENCE · 只读';
  $('#preview-dialog').showModal();
  const url = `/api/v1/projects/${encodeURIComponent(state.current.id)}/evidence/${relative.split('/').map(encodeURIComponent).join('/')}`;
  fetch(url).then(async (response) => {
    if (!response.ok) throw new Error('无法读取日志');
    const text = await response.text();
    $(`#preview-body`).innerHTML = text.trim() ? `<pre>${escapeHtml(text)}</pre>` : '<div class="empty-state compact">该日志为空。</div>';
  }).catch((error) => {
    $('#preview-body').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  });
}

function evidenceRelativePath(absolutePath) {
  const root = String(state.current?.evidence_dir || '').replace(/[\\/]+$/, '');
  const normalized = String(absolutePath).replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  if (normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)) return normalized.slice(normalizedRoot.length + 1);
  const marker = '/evidence/';
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : normalized.split('/').slice(-3).join('/');
}
function closePreview() { if ($('#preview-dialog').open) $('#preview-dialog').close(); }

async function copyDiff() {
  const diff = state.current?.patch?.diff || '';
  if (!diff) return;
  try { await navigator.clipboard.writeText(diff); toast('补丁已复制到剪贴板', 'ok'); }
  catch { toast('当前环境不支持剪贴板访问', 'error'); }
}

async function uploadPaper() {
  const file = $('#paper-file').files[0];
  if (!file) return;
  const chip = $('#paper-file-name');
  chip.hidden = false; chip.textContent = `上传中：${file.name}`;
  try {
    const form = new FormData(); form.append('file', file);
    const result = await api('/api/v1/uploads/paper', { method: 'POST', body: form });
    $('#paper-path').value = result.paper_path;
    chip.textContent = `${result.filename} · ${formatBytes(result.size)}`;
    toast('论文 PDF 已上传，启动时将生成页面视觉证据', 'ok');
  } catch (error) { chip.textContent = '上传失败'; toast(error.message, 'error'); }
  refreshNewRunChecks();
}

async function uploadRepo() {
  const file = $('#repo-file').files[0];
  if (!file) return;
  const chip = $('#repo-file-name');
  chip.hidden = false; chip.textContent = `上传中：${file.name}`;
  try {
    const form = new FormData(); form.append('file', file);
    const result = await api('/api/v1/uploads/repo', { method: 'POST', body: form });
    $('#repo-path').value = result.repo_path;
    chip.textContent = `${result.filename} · ${formatBytes(result.size)}`;
    toast('仓库已解压到本地工作区', 'ok');
  } catch (error) { chip.textContent = '上传失败'; toast(error.message, 'error'); }
  refreshNewRunChecks();
}

function currentRunner() { return $('input[name="runner-choice"]:checked')?.value || 'auto'; }

function refreshRunnerFields() {
  const runner = currentRunner();
  $('#runner-select').value = runner;
  $('#local-fields').hidden = runner !== 'auto' && runner !== 'local';
  $('#docker-fields').hidden = runner !== 'docker';
  $('#ssh-fields').hidden = runner !== 'ssh';
  refreshNewRunChecks();
}

function refreshCodeAgentFields() {
  const custom = $('#code-agent-select').value === 'command';
  $('#code-agent-command-field').hidden = !custom;
  $('#code-agent-command').placeholder = { codex: 'codex exec --approve-for-me --ephemeral', claude: 'claude -p --allowedTools Read,Edit,Write,Bash', gemini: 'gemini', command: 'your-coding-agent --non-interactive' }[$('#code-agent-select').value] || '';
  refreshNewRunChecks();
}

function refreshNewRunChecks() {
  const paper = $('#paper-path').value.trim();
  const repo = $('#repo-path').value.trim();
  const runner = currentRunner();
  const codeAgent = $('#code-agent-enabled').checked;
  const runs = $('#max-runs').value;
  const seconds = $('#max-seconds').value;
  const ready = Boolean(paper && repo);
  $('#summary-paper').textContent = paper ? paper.split(/[\\/]/).pop() : '待提供';
  $('#summary-runner').textContent = RUNNER_LABELS[runner] || runner;
  $('#summary-gpu').textContent = $('#enable-gpu').checked ? '已启用' : '关闭';
  $('#summary-code-agent').textContent = codeAgent ? CODE_AGENT_LABELS[$('#code-agent-select').value] : '关闭';
  $('#summary-budget').textContent = `${runs} 次 / ${seconds} 秒`;
  const readiness = $('#creation-readiness');
  readiness.className = `readiness ${ready ? 'ready' : 'warning'}`;
  readiness.innerHTML = ready ? `${icon('check')}<p>材料已就绪。创建后将立即开始摄取与论文页面渲染。</p>` : `${icon('info')}<p>请提供论文 PDF 和代码仓库路径以创建实验。</p>`;
}

async function createProject() {
  const paperPath = $('#paper-path').value.trim();
  const repoPath = $('#repo-path').value.trim();
  if (!paperPath || !repoPath) return toast('论文路径与代码仓库不能为空', 'error');
  const button = $('#create-project-button');
  button.disabled = true; button.textContent = '正在创建…';
  try {
    const runner = currentRunner();
    const codeAgentEnabled = $('#code-agent-enabled').checked;
    const patch = {
      runner, enableGPU: $('#enable-gpu').checked,
      codeAgent: { type: codeAgentEnabled ? $('#code-agent-select').value : 'none', command: codeAgentEnabled ? $('#code-agent-command').value.trim() : '' },
    };
    if (runner === 'ssh') patch.remote = { host: $('#ssh-host').value.trim(), port: Number($('#ssh-port').value), identity: $('#ssh-identity').value.trim(), baseDir: $('#ssh-base-dir').value.trim() };
    try { state.settings = await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(patch) }); } catch (error) { toast(`运行环境未应用：${error.message}`, 'error'); return; }
    const project = await api('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name: $('#project-name-input').value.trim(), paper_path: paperPath, repo_path: repoPath, data_path: $('#data-path').value.trim(), budget: { max_runs: Number($('#max-runs').value), max_seconds: Number($('#max-seconds').value), max_patches: Number($('#max-patches').value) } }) });
    state.current = await api(`/api/v1/projects/${project.id}/start`, { method: 'POST', body: '{}' });
    await loadProjects(); setView('project'); renderProject(); subscribeProjectEvents(project.id); startProjectPolling();
    toast('复现实验已创建，材料摄取完成', 'ok');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = '创建并开始摄取<span data-icon="arrow"></span>'; mountIcons(); }
}

function setSettingsTab(tab) {
  state.settingsTab = ['model', 'execution'].includes(tab) ? tab : 'model';
  $$('[data-settings-tab]').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === state.settingsTab));
  $$('[data-settings-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === state.settingsTab));
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
  $('#settings-code-acceptance').checked = Boolean(settings.codeAgent?.runAcceptance);
  $('#settings-code-timeout').value = settings.codeAgent?.timeoutMs || 600000;
  $('#settings-ssh-host').value = settings.remote?.host || '';
  $('#settings-ssh-port').value = settings.remote?.port || 22;
  $('#settings-ssh-identity').value = settings.remote?.identity || '';
  $('#settings-ssh-base-dir').value = settings.remote?.baseDir || '/tmp/reprolens';
  $('#settings-model-state').textContent = settings.llm?.baseURL ? `${settings.llm.model} · 已配置` : '未配置模型';
}

function applyModelPreset() {
  const index = $('#settings-llm-preset').value;
  if (index === '') return;
  const preset = state.options?.model_presets?.[Number(index)];
  if (!preset) return;
  $('#settings-llm-base-url').value = preset.base_url;
  $('#settings-llm-model').value = preset.model;
  $('#settings-model-state').textContent = `${preset.model} · 待保存`;
}

async function saveSettings() {
  const button = $('#save-settings-button');
  button.disabled = true;
  try {
    const patch = {
      runner: $('#settings-runner').value, enableGPU: $('#settings-gpu').checked,
      llm: {
        baseURL: $('#settings-llm-base-url').value.trim(), model: $('#settings-llm-model').value.trim(),
        timeoutMs: Number($('#settings-llm-timeout').value), vision: $('#settings-llm-vision').checked,
        ...(($('#settings-llm-api-key').value || '').trim() ? { apiKey: $('#settings-llm-api-key').value.trim() } : {}),
      },
      codeAgent: { type: $('#settings-code-agent').value, command: $('#settings-code-command').value.trim(), timeoutMs: Number($('#settings-code-timeout').value), runAcceptance: $('#settings-code-acceptance').checked },
      remote: { host: $('#settings-ssh-host').value.trim(), port: Number($('#settings-ssh-port').value), identity: $('#settings-ssh-identity').value.trim(), baseDir: $('#settings-ssh-base-dir').value.trim() },
    };
    state.settings = await api('/api/v1/settings', { method: 'PUT', body: JSON.stringify(patch) });
    fillSettingsForm(); renderRuntimeConfig();
    toast('运行时设置已保存并应用', 'ok');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function testLLM() {
  const status = $('#llm-test-result');
  const badge = $('#llm-status');
  status.textContent = '正在测试连接…'; status.className = 'inline-status';
  badge.textContent = '测试中'; badge.className = 'status-badge neutral';
  try {
    const result = await api('/api/v1/settings/test-llm', { method: 'POST', body: '{}' });
    status.textContent = `连接正常 · 返回 ${result.claims?.length || 0} 条主张`; status.className = 'inline-status ok';
    badge.textContent = '连接正常'; badge.className = 'status-badge success';
    toast('模型连接正常', 'ok');
  } catch (error) {
    status.textContent = error.message; status.className = 'inline-status bad';
    badge.textContent = '连接失败'; badge.className = 'status-badge danger';
    toast(error.message, 'error');
  }
}

function openCommandPalette() {
  if (!$('#command-dialog').open) $('#command-dialog').showModal();
  $('#command-input').value = '';
  state.commandIndex = 0;
  state.commands = [
    { icon: 'plus', label: '新建复现实验', hint: 'N', run: () => setView('new-run') },
    { icon: 'dashboard', label: '打开科研工作台', hint: 'G', run: () => setView('overview') },
    { icon: 'projects', label: '查看全部项目', hint: '', run: () => setView('projects') },
    { icon: 'settings', label: '打开模型与算力设置', hint: '', run: () => setView('settings') },
    { icon: 'docs', label: '查看指南与接口', hint: '', run: () => setView('docs') },
    { icon: 'play', label: '运行内置演示', hint: '', run: () => void runDemo() },
    ...state.projects.slice(0, 8).map((project) => ({ icon: 'file', label: project.name, hint: STATE_LABELS[project.state] || project.state, run: () => void openProject(project.id) })),
  ];
  renderCommandResults();
  $('#command-input').focus();
}

function closeCommandPalette() { if ($('#command-dialog').open) $('#command-dialog').close(); }

function renderCommandResults() {
  const query = $('#command-input').value.toLowerCase().trim();
  const commands = state.commands.filter((command) => !query || command.label.toLowerCase().includes(query));
  state.commandIndex = Math.min(state.commandIndex, Math.max(0, commands.length - 1));
  $('#command-results').innerHTML = commands.length ? commands.map((command, index) => `<button class="command-item ${index === state.commandIndex ? 'selected' : ''}" data-command-index="${index}" type="button">${icon(command.icon)}<span>${escapeHtml(command.label)}</span><small>${escapeHtml(command.hint)}</small></button>`).join('') : '<div class="empty-state compact">没有匹配的操作。</div>';
  $$('.command-item').forEach((button) => button.addEventListener('click', () => { commands[Number(button.dataset.commandIndex)]?.run(); closeCommandPalette(); }));
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
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { message: text } }; }
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}

function toast(message, type = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 3600);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return Number.isInteger(number) ? String(number) : String(Number(number.toPrecision(6)));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function escapeAttr(value) { return escapeHtml(value); }
