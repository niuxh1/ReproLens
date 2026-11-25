import * as Lucide from '/vendor/lucide/lucide.js';

const names = {
  dashboard: 'LayoutDashboard', projects: 'FolderKanban', settings: 'Settings2', docs: 'BookOpen',
  plus: 'Plus', search: 'Search', command: 'Command', chevron: 'ChevronRight', down: 'ChevronDown',
  arrow: 'ArrowUpRight', back: 'ArrowLeft', refresh: 'RefreshCw', play: 'Play', pause: 'Square',
  check: 'Check', x: 'X', menu: 'Menu', panel: 'PanelLeftClose', upload: 'Upload', file: 'FileText',
  folder: 'FolderOpen', code: 'Code2', activity: 'Activity', clock: 'Clock3', cpu: 'Cpu',
  gpu: 'Zap', database: 'Database', shield: 'ShieldCheck', evidence: 'PackageCheck', download: 'Download',
  external: 'ExternalLink', eye: 'Eye', terminal: 'Terminal', flask: 'FlaskConical', spark: 'Sparkles',
  layers: 'Layers3', circle: 'Circle', alert: 'CircleAlert', info: 'Info', more: 'MoreHorizontal',
  sun: 'Sun', moon: 'Moon', copy: 'Copy', branch: 'GitBranch', list: 'ListChecks', save: 'Save',
  key: 'KeyRound', link: 'Link2', server: 'Server', expand: 'Maximize2', collapse: 'Minimize2',
};

const renderNode = (node) => {
  if (typeof node === 'string') return node;
  const [tag, attrs, children] = node;
  const attributes = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${String(value)}"`).join('');
  const content = (children || []).map(renderNode).join('');
  return `<${tag}${attributes}>${content}</${tag}>`;
};

export function icon(name, className = '') {
  const node = Lucide[names[name] || name] || Lucide.Circle;
  const attributes = { ...node[1], class: `icon ${className}`.trim(), 'aria-hidden': 'true' };
  return `<svg${Object.entries(attributes).map(([key, value]) => ` ${key}="${value}"`).join('')}>${node[2].map(renderNode).join('')}</svg>`;
}

export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((element) => {
    if (element.dataset.mounted) return;
    element.innerHTML = icon(element.dataset.icon);
    element.dataset.mounted = 'true';
  });
}
