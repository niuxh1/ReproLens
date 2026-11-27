import { randomUUID } from 'node:crypto';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { Project, Report, Verdict } from '../domain/types.js';

const VERDICT_META: Record<Verdict, { label: string; english: string; tone: string }> = {
  PASS: { label: '通过', english: 'PASS', tone: 'success' },
  DIFFERENT: { label: '存在差异', english: 'DIFFERENT', tone: 'warning' },
  INSUFFICIENT_EVIDENCE: { label: '证据不足', english: 'INSUFFICIENT EVIDENCE', tone: 'neutral' },
  FAILED: { label: '失败', english: 'FAILED', tone: 'danger' },
};

export function renderReportPage(project: Project, report: Report): string {
  const verification = project.verification;
  const aggregateVerdict = report.aggregate_verdict ?? verification?.verdict;
  const verdict = aggregateVerdict ? VERDICT_META[aggregateVerdict] : null;
  const markdown = report.markdown.replace(/^#\s+[^\n]+\n+/, '');
  let body = marked.parse(markdown, { gfm: true, breaks: false }) as string;
  body = sanitizeRenderedHtml(body);
  const toc: Array<{ id: string; label: string }> = [];
  let section = 0;
  body = body.replace(/<h2(?:\s[^>]*)?>([\s\S]*?)<\/h2>/g, (_match, inner: string) => {
    section += 1;
    const id = `section-${section}`;
    toc.push({ id, label: stripTags(inner) });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  const nonce = randomUUID().replace(/-/g, '');
  const generated = formatDate(report.generated_at);
  const summaryModel = report.agent_summary?.model ?? '尚未生成';
  const summarySource = report.agent_summary?.source === 'model' ? '主模型生成' : report.agent_summary ? '确定性回退' : '待生成';
  const assessment = report.assessment;
  const metaItems: Array<[string, string]> = [
    ['项目', project.id],
    ['工作流', project.state],
    ['报告时间', generated],
    ['总结模型', summaryModel],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; font-src data:; base-uri 'none'; form-action 'none';">
<title>实验复现报告 · ${escapeHtml(project.name)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Ccircle cx=%2732%27 cy=%2732%27 r=%2728%27 fill=%27%23fff%27 stroke=%27%23245fc4%27 stroke-width=%274%27/%3E%3Ctext x=%2732%27 y=%2742%27 text-anchor=%27middle%27 font-size=%2730%27 fill=%27%23245fc4%27%3ER%3C/text%3E%3C/svg%3E">
<style>
html{scroll-padding-top:84px}:root{--ink:#172432;--muted:#63717e;--line:#dfe5e8;--paper:#fff;--canvas:#eef1f2;--blue:#245fc4;--green:#17755c;--green-bg:#edf8f3;--amber:#95610a;--amber-bg:#fff7e7;--red:#b43a35;--red-bg:#fff1f0;--shadow:0 18px 60px rgba(22,38,54,.08);color-scheme:light}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.75 "Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}.toolbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;min-height:58px;padding:10px max(18px,calc((100vw - 1180px)/2));border-bottom:1px solid rgba(220,227,231,.9);background:rgba(255,255,255,.94);backdrop-filter:blur(16px)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.02em;white-space:nowrap}.brand-mark{display:grid;place-items:center;width:26px;height:26px;border:1px solid #234b8c;border-radius:50%;color:#234b8c;font:600 12px/1 ui-monospace,monospace}.brand small{display:block;color:var(--muted);font:500 9px/1.2 ui-monospace,monospace;letter-spacing:.12em}.toolbar-spacer{flex:1}.toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:6px 12px;border:1px solid #ccd6dd;border-radius:7px;background:#fff;color:#304251;font:600 12px/1.2 inherit;cursor:pointer}.btn:hover{border-color:#9eb3c3;background:#f8fafb}.btn.primary{border-color:#1f56b2;background:#1f56b2;color:#fff}.btn.primary:hover{background:#194b9e}.btn:disabled{opacity:.55;cursor:wait}
.report-shell{width:min(1180px,calc(100% - 32px));margin:28px auto 64px}.cover{position:relative;overflow:hidden;padding:46px 48px 36px;border:1px solid #dce3e7;border-radius:12px 12px 0 0;background:linear-gradient(145deg,#fff 0%,#fff 62%,#f2f6fa 100%);box-shadow:var(--shadow)}.cover::after{content:"";position:absolute;right:-90px;top:-120px;width:360px;height:360px;border:1px solid #dbe5ef;border-radius:50%;box-shadow:0 0 0 34px rgba(238,243,248,.55),0 0 0 68px rgba(238,243,248,.28);pointer-events:none}.cover-top{position:relative;z-index:1;display:flex;align-items:flex-start;gap:28px;justify-content:space-between}.overline{color:#4f6a85;font:600 10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.17em;text-transform:uppercase}.cover h1{max-width:760px;margin:12px 0 10px;font-size:clamp(28px,4vw,46px);line-height:1.16;letter-spacing:-.045em}.paper-title{max-width:760px;margin:0;color:var(--muted);font-size:15px}.verdict{position:relative;z-index:1;flex:0 0 auto;min-width:172px;padding:18px 20px;border:1px solid #c9ded6;border-radius:10px;background:var(--green-bg)}.verdict.warning{border-color:#ead6ae;background:var(--amber-bg)}.verdict.danger{border-color:#efc8c5;background:var(--red-bg)}.verdict.neutral{border-color:#d5dde2;background:#f5f7f8}.verdict-label{display:block;color:var(--muted);font:600 9px/1.3 ui-monospace,monospace;letter-spacing:.14em}.verdict strong{display:block;margin-top:5px;color:var(--green);font:750 28px/1.1 inherit;letter-spacing:-.03em}.verdict.warning strong{color:var(--amber)}.verdict.danger strong{color:var(--red)}.verdict.neutral strong{color:#435665}.verdict small{display:block;margin-top:6px;color:var(--muted);font:600 10px/1.3 ui-monospace,monospace;letter-spacing:.08em}
.meta-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin-top:34px;border:1px solid #dce3e7;background:#dce3e7;border-radius:9px;overflow:hidden}.meta-item{min-width:0;padding:13px 15px;background:#fff}.meta-item span{display:block;color:var(--muted);font:600 9px/1.4 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}.meta-item strong{display:block;overflow:hidden;margin-top:3px;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.metric-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;border:1px solid #dce3e7;border-top:0;border-radius:0 0 12px 12px;background:#dce3e7;box-shadow:var(--shadow);overflow:hidden}.metric{padding:18px 22px;background:#fbfcfd}.metric span{display:block;color:var(--muted);font:600 9px/1.3 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}.metric strong{display:block;margin-top:5px;font-size:24px;line-height:1.2;letter-spacing:-.035em}.metric small{display:block;margin-top:4px;color:var(--muted);font-size:10px}
.report-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;align-items:start;margin-top:24px}.toc{position:sticky;top:84px;padding:18px;border:1px solid #dce3e7;border-radius:10px;background:rgba(255,255,255,.72)}.toc h2{margin:0 0 10px;color:#4f6273;font:650 10px/1.3 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase}.toc a{display:block;padding:6px 7px;border-radius:5px;color:#586b7a;font-size:12px;line-height:1.45}.toc a:hover{background:#edf3f8;color:#244f82;text-decoration:none}.article{min-width:0;padding:42px 50px 50px;border:1px solid #dce3e7;border-radius:10px;background:var(--paper);box-shadow:var(--shadow)}
.article>h1:first-child{display:none}.article h2[id]{scroll-margin-top:84px}.article h2{margin:42px 0 14px;padding-bottom:9px;border-bottom:1px solid #e3e9ec;font-size:21px;line-height:1.35;letter-spacing:-.025em}.article h2:first-of-type{margin-top:0}.article h3{margin:25px 0 9px;font-size:15px;letter-spacing:-.01em}.article p{margin:11px 0}.article ul,.article ol{margin:10px 0;padding-left:22px}.article li{margin:5px 0}.article blockquote{margin:16px 0;padding:12px 16px;border-left:3px solid #3979d2;background:#f3f7fd;color:#315573}.article table{width:100%;border-collapse:collapse;margin:16px 0 22px;font-size:12px}.article th,.article td{padding:9px 11px;border:1px solid #dfe5e8;text-align:left;vertical-align:top}.article th{background:#f5f7f8;font-weight:650}.article tr:nth-child(even) td{background:#fafbfb}.article code{padding:1px 5px;border-radius:3px;background:#f0f3f5;font:11.5px/1.5 "JetBrains Mono",Consolas,monospace;word-break:break-all}.article pre{padding:15px 17px;overflow:auto;border:1px solid #263947;border-radius:7px;background:#17232c;color:#dce8f2}.article pre code{padding:0;background:none;color:inherit;font-size:11px;word-break:normal}.article hr{border:0;border-top:1px solid #e2e8ec;margin:28px 0}.report-footer{margin-top:38px;padding-top:15px;border-top:1px solid #e2e8ec;color:#87939d;font-size:10.5px}
.summary-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid #d7e2ec;border-radius:999px;background:#f4f8fc;color:#42617e;font:600 10px/1.2 ui-monospace,monospace}.summary-badge::before{content:"";width:5px;height:5px;border-radius:50%;background:#3979d2}
.notice{margin:12px 0 20px;padding:10px 13px;border:1px solid #eadfc9;border-radius:7px;background:#fffbf2;color:#715a2b;font-size:12px}
@media(max-width:900px){.report-layout{grid-template-columns:1fr}.toc{position:static;order:-1}.toc a{display:inline-block;margin:0 4px 3px 0}.article{padding:34px 28px}.cover{padding:34px 28px 28px}.cover-top{display:block}.verdict{display:inline-block;margin-top:22px}.meta-grid,.metric-strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){html{scroll-padding-top:120px}.article h2[id]{scroll-margin-top:120px}.toolbar{padding:9px 12px}.brand small{display:none}.toolbar-actions{max-width:calc(100vw - 56px);overflow-x:auto;flex-wrap:nowrap;justify-content:flex-start}.toolbar-actions .btn{display:inline-flex;flex:0 0 auto;white-space:nowrap}.report-shell{width:calc(100% - 16px);margin:12px auto 32px}.cover{padding:26px 20px 22px;border-radius:8px 8px 0 0}.cover h1{font-size:27px}.paper-title{font-size:13px}.meta-grid,.metric-strip{grid-template-columns:1fr}.metric{padding:14px 16px}.article{padding:28px 18px 34px}.article h2{font-size:19px}.article table{display:block;overflow-x:auto}.toc{padding:13px}.report-layout{gap:12px}}
@media print{@page{margin:16mm 15mm}body{background:#fff;font-size:10.5pt}.toolbar,.toc,.notice,.summary-badge{display:none!important}.report-shell{width:auto;margin:0}.cover{padding:0 0 18mm;border:0;box-shadow:none;background:#fff}.cover::after{display:none}.cover h1{font-size:24pt}.verdict{margin-top:10mm}.meta-grid,.metric-strip{border-color:#bbb;box-shadow:none}.metric,.meta-item{background:#fff!important}.report-layout{display:block;margin-top:8mm}.article{padding:0;border:0;box-shadow:none}.article h2{break-after:avoid}.article h3{break-after:avoid}.article pre,.article table,.article blockquote{break-inside:avoid}.article pre{white-space:pre-wrap}.report-footer{margin-top:12mm}}
</style>
</head>
<body>
<nav class="toolbar" aria-label="报告工具栏">
  <div class="brand"><span class="brand-mark">R</span><span>ReproLens<small>EVIDENCE REPORT</small></span></div>
  <div class="toolbar-spacer"></div>
  <div class="toolbar-actions">
    <a class="btn" href="/#project/${encodeURIComponent(project.id)}">返回工作台</a>
    <button class="btn" id="summarize-report" type="button">重新生成总结</button>
    <a class="btn" href="/api/v1/projects/${encodeURIComponent(project.id)}/report.md">Markdown</a>
    <a class="btn primary" href="/api/v1/projects/${encodeURIComponent(project.id)}/package">下载证据包</a>
    <button class="btn primary" id="print-report" type="button">打印 / PDF</button>
  </div>
</nav>
<main class="report-shell">
  <header class="cover">
    <div class="cover-top">
      <div>
        <div class="overline">ReproLens · Reproducibility Evidence</div>
        <h1>${escapeHtml(project.name)}</h1>
        <p class="paper-title">${escapeHtml(project.paper.title || '论文标题未识别')}</p>
      </div>
      ${verdict ? `<div class="verdict ${verdict.tone}"><span class="verdict-label">RULE VERDICT</span><strong>${escapeHtml(verdict.label)}</strong><small>${escapeHtml(verdict.english)}</small></div>` : '<div class="verdict neutral"><span class="verdict-label">RULE VERDICT</span><strong>待核验</strong><small>NO VERDICT</small></div>'}
    </div>
    <div class="meta-grid">${metaItems.map(([label, value]) => `<div class="meta-item"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join('')}</div>
  </header>
  <section class="metric-strip" aria-label="核验指标">
    <div class="metric"><span>论文期望值</span><strong>${verification ? formatNumber(verification.expected) : '—'}</strong><small>${escapeHtml(verification?.metric ?? '尚无指标')}</small></div>
    <div class="metric"><span>实验观测值</span><strong>${verification ? formatNumber(verification.observed) : '—'}</strong><small>来自受控运行</small></div>
    <div class="metric"><span>绝对误差</span><strong>${verification ? formatNumber(Math.abs(verification.observed - verification.expected)) : '—'}</strong><small>容差 ±${verification ? formatNumber(verification.tolerance.abs) : '—'}</small></div>
    <div class="metric"><span>主 Agent 总结</span><strong style="font-size:14px">${escapeHtml(summarySource)}</strong><small>${escapeHtml(summaryModel)}</small></div>
    <div class="metric"><span>证据成熟度评分</span><strong>${assessment ? assessment.score : '—'}<span style="font-size:11px;color:#7d8a95">/100</span></strong><small>${assessment ? `${assessment.grade} 级 · 证据成熟度` : '尚未评估'}</small></div>
  </section>
  <div class="report-layout">
    <aside class="toc" aria-label="报告目录"><h2>CONTENTS</h2>${toc.map((item) => `<a href="#${item.id}">${escapeHtml(item.label)}</a>`).join('')}</aside>
    <article class="article">
      <div class="notice"><span class="summary-badge">${escapeHtml(summarySource)}</span> 本报告中的解释性总结由主 Agent 生成；最终 PASS / DIFFERENT 结论仅由确定性数值规则计算。</div>
      ${body}
      <footer class="report-footer">ReproLens · 规则核验不可被模型或代码 Agent 改写 · 报告生成于 ${escapeHtml(generated)}</footer>
    </article>
  </div>
</main>
<script nonce="${nonce}">
(() => {
  document.getElementById('print-report')?.addEventListener('click', () => window.print());
  const notifyParentHeight = () => {
    if (window.parent === window) return;
    const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    window.parent.postMessage({ type: 'reprolens-report-height', height }, window.location.origin);
  };
  window.addEventListener('load', notifyParentHeight);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(notifyParentHeight).observe(document.body);
  const button = document.getElementById('summarize-report');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '主 Agent 正在总结…';
    try {
      const response = await fetch('/api/v1/projects/${encodeURIComponent(project.id)}/report/summarize', { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error?.message || '总结生成失败');
      }
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      window.alert(error instanceof Error ? error.message : String(error));
    }
  });
})();
</script>
</body>
</html>`;
}

function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'em', 'del', 'blockquote',
      'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      th: ['align'],
      td: ['align'],
      code: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noreferrer noopener', target: '_blank' } }),
    },
  });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(8)));
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
export function renderReportErrorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#eef1f2;color:#172432;font:14px/1.7 "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 32px));padding:36px;border:1px solid #dce3e7;border-radius:12px;background:#fff;box-shadow:0 18px 60px rgba(22,38,54,.08)}.mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid #b43a35;border-radius:50%;color:#b43a35;font-weight:700}h1{margin:18px 0 8px;font-size:24px;letter-spacing:-.03em}p{margin:0 0 20px;color:#63717e}a{display:inline-flex;padding:8px 12px;border:1px solid #245fc4;border-radius:7px;color:#245fc4;text-decoration:none;font-weight:600}</style>
</head><body><main class="card"><span class="mark">!</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="/">返回 ReproLens 工作台</a></main></body></html>`;
}
