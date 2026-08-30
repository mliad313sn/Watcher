/** @watcher/ui — registers all custom elements and exports helpers. */
export { WShell } from './chrome.js';
export { WGauge } from './widgets/gauge.js';
export { WTraffic, formatBps } from './widgets/traffic.js';
export { WHeatmap } from './widgets/heatmap.js';
export { WStatusgrid } from './widgets/statusgrid.js';
export { WEventfeed } from './widgets/eventfeed.js';
export { DashGrid } from './grid.js';
export { escapeHtml, escapeAttr } from './escape.js';
export { toast } from './toast.js';
export { timeAgo } from './format.js';
export { openPalette, installShortcuts } from './palette.js';
