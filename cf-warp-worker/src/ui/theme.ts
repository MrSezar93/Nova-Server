/** Shared stylesheet for every page (dark first, light supported). */

export const STYLES = `
:root{
  --bg:#080b12; --bg-soft:#0f141d; --card:#121925; --card-2:#161f2e; --line:#223046;
  --text:#e9eef8; --muted:#93a0b8; --accent:#f6821f; --accent-soft:rgba(246,130,31,.14);
  --brand:#5b8cff; --ok:#3ddc9a; --warn:#ffc860; --err:#ff7a86; --radius:16px;
  --shadow:0 18px 48px rgba(0,0,0,.45);
  color-scheme:dark;
}
@media (prefers-color-scheme:light){
  :root{
    --bg:#f5f7fb; --bg-soft:#ffffff; --card:#ffffff; --card-2:#f2f5fa; --line:#dde3ee;
    --text:#131a26; --muted:#5c6a83; --shadow:0 14px 34px rgba(18,32,58,.12);
    color-scheme:light;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:radial-gradient(1100px 520px at 12% -8%,rgba(91,140,255,.18),transparent 60%),
             radial-gradient(900px 520px at 100% 0%,rgba(246,130,31,.14),transparent 55%),var(--bg);
  color:var(--text);min-height:100vh;
  font-family:system-ui,-apple-system,"Segoe UI",Tahoma,"Iranian Sans",Roboto,sans-serif;
  font-size:15px;line-height:1.7;
}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:20px}
.center{display:grid;place-items:center;min-height:100vh;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.card + .card{margin-top:16px}
.stack{display:grid;gap:14px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.between{display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between}
.grow{flex:1 1 200px}
.brand{display:flex;gap:12px;align-items:center}
.logo{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;font-weight:800;
  background:linear-gradient(140deg,var(--accent),#ffb45c);color:#1a1206;font-size:19px}
h1,h2,h3{margin:0 0 6px;line-height:1.35}
h1{font-size:22px}
h2{font-size:18px}
h3{font-size:16px}
p{margin:0 0 8px}
.muted{color:var(--muted);font-size:13.5px}
.tiny{font-size:12.5px}
label{display:block;font-size:13.5px;color:var(--muted);margin-bottom:6px}
input,select,textarea,button{font-family:inherit;font-size:14.5px}
input,select,textarea{
  width:100%;padding:11px 12px;border-radius:12px;border:1px solid var(--line);
  background:var(--bg-soft);color:var(--text);outline:none
}
input:focus,select:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(91,140,255,.16)}
textarea{min-height:120px;resize:vertical;line-height:1.6}
button{
  cursor:pointer;border:1px solid var(--line);background:var(--card-2);color:var(--text);
  padding:10px 15px;border-radius:12px;font-weight:600;transition:.15s transform,.15s filter
}
button:hover{filter:brightness(1.07)}
button:active{transform:translateY(1px)}
button:disabled{opacity:.55;cursor:not-allowed}
button.primary{background:linear-gradient(140deg,var(--accent),#ffa94d);border-color:transparent;color:#1c1206}
button.ghost{background:transparent}
button.danger{color:var(--err);border-color:rgba(255,122,134,.4)}
button.small{padding:7px 11px;font-size:13px;border-radius:10px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;
  background:var(--accent-soft);color:var(--accent);border:1px solid rgba(246,130,31,.3)}
.pill.ok{background:rgba(61,220,154,.13);color:var(--ok);border-color:rgba(61,220,154,.32)}
.pill.err{background:rgba(255,122,134,.13);color:var(--err);border-color:rgba(255,122,134,.32)}
.pill.muted{background:var(--card-2);color:var(--muted);border-color:var(--line)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.table{width:100%;border-collapse:collapse;font-size:14px}
.table th,.table td{padding:11px 10px;text-align:start;border-bottom:1px solid var(--line);vertical-align:middle}
.table th{color:var(--muted);font-weight:600;font-size:12.5px}
.table tr:last-child td{border-bottom:0}
.nav{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 18px}
.nav button{border-radius:999px;padding:8px 15px;background:transparent}
.nav button.active{background:var(--accent-soft);border-color:rgba(246,130,31,.35);color:var(--accent)}
pre,code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;direction:ltr;text-align:left}
pre{background:#05070c;color:#cfe2ff;border:1px solid var(--line);border-radius:12px;padding:14px;
  overflow:auto;max-height:340px;font-size:12.5px;line-height:1.65}
.banner{padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card-2);font-size:13.5px}
.banner.warn{border-color:rgba(255,200,96,.35);background:rgba(255,200,96,.1);color:var(--warn)}
.banner.err{border-color:rgba(255,122,134,.35);background:rgba(255,122,134,.1);color:var(--err)}
.banner.ok{border-color:rgba(61,220,154,.35);background:rgba(61,220,154,.1);color:var(--ok)}
.modal{position:fixed;inset:0;background:rgba(3,6,12,.72);display:none;place-items:center;padding:18px;z-index:40;overflow:auto}
.modal.open{display:grid}
.modal .card{width:min(760px,100%);max-height:92vh;overflow:auto}
.toast{position:fixed;inset-inline-start:18px;bottom:18px;z-index:60;display:grid;gap:8px}
.toast div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;box-shadow:var(--shadow);font-size:13.5px}
.qr{background:#fff;padding:12px;border-radius:14px;display:inline-block}
.qr svg{display:block;width:min(300px,70vw);height:auto}
kbd{background:var(--card-2);border:1px solid var(--line);border-radius:7px;padding:1px 6px;font-size:12px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13.5px}
.kv span:nth-child(odd){color:var(--muted)}
.logs{display:grid;gap:8px;max-height:320px;overflow:auto}
.log{display:flex;gap:10px;align-items:flex-start;font-size:13px;padding:9px 11px;border:1px solid var(--line);border-radius:11px;background:var(--card-2)}
.log .dot{width:9px;height:9px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:var(--brand)}
.log.success .dot{background:var(--ok)} .log.warn .dot{background:var(--warn)} .log.error .dot{background:var(--err)}
.split{display:grid;gap:18px;grid-template-columns:1.4fr 1fr}
@media (max-width:820px){.split{grid-template-columns:1fr}.hide-sm{display:none}}
footer{color:var(--muted);font-size:12.5px;text-align:center;padding:22px 12px 34px}
fieldset{border:1px solid var(--line);border-radius:14px;padding:14px}
legend{padding:0 8px;color:var(--muted);font-size:13px}
.small-hint{color:var(--muted);font-size:12.5px;margin-top:6px}
`;
