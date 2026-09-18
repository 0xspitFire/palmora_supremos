export const WEB_STYLES = `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #111418;
  color: #f1f3f5;
  font-synthesis: none;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: #111418; }
body { margin: 0; background: #111418; color: #f1f3f5; }
a { color: #f6c453; }
a:focus-visible, summary:focus-visible, [tabindex="0"]:focus-visible { outline: 3px solid #f6c453; outline-offset: 3px; }
button, a, summary, [tabindex="0"] { min-height: 2.75rem; }
.skip-link { position: absolute; left: 1rem; top: -5rem; z-index: 10; padding: .75rem 1rem; background: #f6c453; color: #111418; }
.skip-link:focus { top: 1rem; }
.app-shell { min-height: 100vh; }
.app-header { display: flex; align-items: center; gap: 1.5rem; min-height: 4.5rem; padding: 1rem clamp(1rem, 4vw, 3rem); border-bottom: 1px solid #2a3038; background: #171b21; }
.brand { margin: 0; font-size: 1rem; letter-spacing: .08em; text-transform: uppercase; }
.read-only-mark { color: #a9b2bf; font-size: .8rem; }
.app-nav { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin-left: auto; }
.app-nav a { padding: .45rem .6rem; border-radius: .35rem; text-decoration: none; }
.app-nav a:hover { background: #252b34; }
.app-main { display: grid; gap: 1.5rem; width: min(1280px, 100%); margin: 0 auto; padding: clamp(1rem, 3vw, 2.5rem); }
.surface { display: grid; gap: 1.25rem; min-width: 0; }
.surface-header { display: grid; gap: .45rem; }
.surface-header h1, .surface-header h2, .surface h2, .surface h3 { margin: 0; }
.surface-header p, .surface p { max-width: 75ch; color: #b8c1cd; line-height: 1.55; }
.eyebrow { margin: 0; color: #f6c453 !important; font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.surface-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 1rem; }
.card, .metric-card, .attention-card, .calendar-card, .alert-card { min-width: 0; padding: 1rem; border: 1px solid #303743; border-radius: .55rem; background: #191e25; }
.card h3, .card h4, .metric-card h3, .attention-card h3, .calendar-card h3, .alert-card h3 { margin: 0 0 .55rem; }
.card p, .metric-card p, .attention-card p, .calendar-card p, .alert-card p { margin: .35rem 0 0; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.status-badge { display: inline-flex; align-items: center; gap: .35rem; width: fit-content; padding: .25rem .5rem; border: 1px solid currentColor; border-radius: 99rem; font-size: .78rem; font-weight: 700; line-height: 1.25; }
.status-dot { width: .5rem; height: .5rem; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
.status-available, .status-fresh, .status-pass, .status-permitted, .status-ready, .status-delivered, .status-final, .status-confirmed { color: #77d6a2; }
.status-partial, .status-warning, .status-stale, .status-posted, .status-included { color: #f6c453; }
.status-unavailable, .status-blocking, .status-blocked, .status-fail, .status-reorged, .status-aborted, .status-failed, .status-killed { color: #f08c8c; }
.status-unknown, .status-info, .status-pending, .status-delivering { color: #a9b2bf; }
.surface-notice { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .85rem 1rem; border: 1px solid #45505f; border-radius: .45rem; background: #1d232b; line-height: 1.5; }
.surface-notice-stale { border-color: #806b2b; }
.surface-notice-unavailable, .surface-notice-unknown { border-color: #744848; }
.surface-notice-partial { border-color: #806b2b; }
.freshness, .metric-meta, .check-required { color: #a9b2bf; font-size: .78rem; }
.freshness-stale { color: #f6c453; }
.freshness-unknown { color: #f08c8c; }
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .75rem; }
.metric { display: grid; gap: .25rem; min-width: 0; }
.metric-label { color: #a9b2bf; font-size: .78rem; }
.metric strong { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 1rem; }
.attention-list, .issue-list, .check-list, .timeline, .provenance ul { display: grid; gap: .75rem; margin: 0; padding: 0; list-style: none; }
.attention-card { display: grid; gap: .5rem; }
.attention-card .inspect-link, .inspect-link { width: fit-content; padding: .45rem .65rem; border: 1px solid #806b2b; border-radius: .35rem; text-decoration: none; }
.inspect-link:hover { background: #332d1b; }
.readiness-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .75rem; }
.metric-card strong { display: block; margin-top: .4rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 1.35rem; }
.gate, .issues, .timeline-section { display: grid; gap: .8rem; min-width: 0; padding: 1rem; border: 1px solid #303743; border-radius: .55rem; background: #15191f; }
.check, .issue { padding: .7rem; border-left: 3px solid #45505f; background: #1b2128; }
.check-pass { border-left-color: #77d6a2; }
.check-fail, .check-stale, .issue-blocking { border-left-color: #f08c8c; }
.check-unknown, .issue-warning { border-left-color: #f6c453; }
.check p, .issue p { margin: .35rem 0 0; }
.next-action, .issue-next { color: #d1d7df !important; font-size: .9rem; }
.table-wrap { width: 100%; max-width: 100%; overflow-x: auto; border: 1px solid #303743; border-radius: .55rem; }
table { width: 100%; border-collapse: collapse; min-width: 42rem; }
caption { padding: .85rem 1rem; color: #d1d7df; text-align: left; font-weight: 700; }
th, td { padding: .75rem 1rem; border-top: 1px solid #303743; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
th { color: #a9b2bf; font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; }
td code, .technical { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82rem; }
.readiness-table tbody tr { cursor: default; }
.readiness-table tbody tr:hover, .readiness-table tbody tr:focus-within { background: #1d2530; }
.card-footer { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-top: .8rem; }
.risk-list, .evidence-list { display: grid; gap: .6rem; margin: 0; padding: 0; list-style: none; }
.risk-list li, .evidence-list li { padding: .65rem; border: 1px solid #303743; border-radius: .35rem; }
.provenance { color: #b8c1cd; font-size: .78rem; }
.provenance summary { width: fit-content; cursor: pointer; }
.timeline li { display: grid; grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr); gap: .75rem; padding: .7rem 0; border-bottom: 1px solid #303743; }
.timeline li:last-child { border-bottom: 0; }
.empty-state { padding: 1rem; color: #a9b2bf; border: 1px dashed #45505f; border-radius: .45rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 900px) {
  .app-header { align-items: flex-start; flex-wrap: wrap; }
  .app-nav { width: 100%; margin-left: 0; }
}

@media (max-width: 720px) {
  .app-main { padding: 1rem; }
  .section-heading { align-items: flex-start; flex-direction: column; }
  .table-wrap { overflow-x: visible; border: 0; }
  .responsive-table, .responsive-table tbody, .responsive-table tr, .responsive-table td { display: block; min-width: 0; width: 100%; }
  .responsive-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .responsive-table tr { margin-bottom: .75rem; padding: .5rem; border: 1px solid #303743; border-radius: .45rem; background: #191e25; }
  .responsive-table td { display: grid; grid-template-columns: minmax(7rem, 35%) minmax(0, 1fr); gap: .75rem; padding: .55rem; border-top: 0; }
  .responsive-table td::before { content: attr(data-label); color: #a9b2bf; font-size: .78rem; font-weight: 700; }
  .timeline li { grid-template-columns: 1fr; gap: .3rem; }
}

@media (max-width: 480px) {
  .app-header { padding: .85rem 1rem; }
  .app-nav { gap: .25rem; }
  .app-nav a { padding: .4rem; }
  .surface-grid, .metric-grid { grid-template-columns: 1fr; }
  .responsive-table td { grid-template-columns: 1fr; gap: .2rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
}

@media (forced-colors: active) {
  .status-badge, .surface-notice, .card, .metric-card, .table-wrap { border: 1px solid ButtonText; }
}
`;
