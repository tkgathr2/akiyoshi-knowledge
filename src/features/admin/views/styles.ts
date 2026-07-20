/**
 * スタイル - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * レスポンシブ対応の CSS を 1 箇所に集約する（外部 CSS を配信せず self-contained）。
 * モバイル（〜640px）ではナビとカードを縦積みにし、テーブルは横スクロールへ退避する。
 * ライト/ダークの両テーマに prefers-color-scheme で追従する。
 */

export const STYLES = `
:root{
  --bg:#f5f6f8; --panel:#ffffff; --border:#e2e5ea; --text:#1c2230; --muted:#5b6472;
  --accent:#c4302b; --accent-ink:#ffffff; --ok:#1a7f45; --warn:#b26a00; --err:#c0392b;
  --shadow:0 1px 3px rgba(20,24,33,.08);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#12151b; --panel:#1b1f27; --border:#2a3038; --text:#e8ebf0; --muted:#9aa4b2;
    --accent:#e0524d; --accent-ink:#ffffff; --ok:#4cc27f; --warn:#e0a54a; --err:#ef6a5a;
    --shadow:0 1px 3px rgba(0,0,0,.4);
  }
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent)}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:var(--panel);border-bottom:1px solid var(--border);flex-wrap:wrap}
.brand{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
.brand .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block}
nav.main{display:flex;gap:4px;flex-wrap:wrap}
nav.main a{padding:6px 12px;border-radius:8px;text-decoration:none;color:var(--muted);font-size:14px}
nav.main a.active{background:var(--accent);color:var(--accent-ink)}
nav.main a:hover{background:var(--border)}
.wrap{max-width:960px;margin:0 auto;padding:20px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;box-shadow:var(--shadow)}
.card .label{font-size:12px;color:var(--muted);margin-bottom:6px}
.card .value{font-size:26px;font-weight:700}
.card .unit{font-size:13px;color:var(--muted);font-weight:400}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px;box-shadow:var(--shadow);margin-bottom:20px}
.panel h2{font-size:16px;margin:0 0 14px}
.field{margin-bottom:16px}
.field label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.field .hint{font-weight:400;color:var(--muted);font-size:12px}
input[type=text],input[type=number],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:15px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.btn{display:inline-block;padding:10px 18px;border:none;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:15px;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{filter:brightness(1.05)}
.btn.secondary{background:var(--border);color:var(--text)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
.badge.ok{background:rgba(26,127,69,.15);color:var(--ok)}
.badge.err{background:rgba(192,57,43,.15);color:var(--err)}
.badge.warn{background:rgba(178,106,0,.15);color:var(--warn)}
.alert{padding:12px 14px;border-radius:8px;margin-bottom:16px;font-size:14px}
.alert.err{background:rgba(192,57,43,.12);color:var(--err);border:1px solid rgba(192,57,43,.3)}
.alert.ok{background:rgba(26,127,69,.12);color:var(--ok);border:1px solid rgba(26,127,69,.3)}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
td.mono,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.videolist{list-style:none;margin:0;padding:0}
.videolist li{border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;background:var(--bg)}
.videolist .vtitle{font-weight:600;margin-bottom:4px}
.videolist .vmeta{color:var(--muted);font-size:12px;margin-bottom:8px}
.videolist .vsummary{font-size:13.5px;color:var(--text)}
.logline{border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--bg)}
.logline .row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:13px}
.logline .skip{margin-top:8px;font-size:12.5px;color:var(--warn)}
.login-wrap{max-width:380px;margin:8vh auto;padding:0 20px}
.login-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:var(--shadow)}
.empty{color:var(--muted);text-align:center;padding:30px}
.foot{color:var(--muted);font-size:12px;text-align:center;padding:24px}
@media (max-width:640px){
  .topbar{flex-direction:column;align-items:flex-start}
  nav.main{width:100%}
  nav.main a{flex:1;text-align:center}
  .wrap{padding:14px}
  .card .value{font-size:22px}
}
`;
