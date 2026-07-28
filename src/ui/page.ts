/**
 * page.ts — the single-page local web UI, as one exported template string.
 *
 * Fully self-contained: inline CSS and JS only, no CDN links, no external
 * fonts or scripts. Served by server.ts at GET /?k=<token>. The client reads
 * the `k` token from location.search once and appends it to every API call.
 *
 * Design intent: this is the face of the product for non-technical legal
 * staff. Calm, professional, honest — the engine's warnings (notably the
 * homoglyph search-impact disclosure) are surfaced verbatim, never hidden.
 */

export const PAGE: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Mattermark</title>
<style>
:root{
  --bg:#f7f6f3; --panel:#ffffff; --text:#1c1e22; --muted:#5c6270;
  --border:#e2dfd8; --accent:#2f5d8f; --accent-strong:#264b74; --accent-contrast:#ffffff;
  --ok-bg:#eef6ef; --ok-border:#4d8a5d; --ok-text:#245633;
  --warn-bg:#fdf6e4; --warn-border:#b3821f; --warn-text:#6e4e10;
  --bad-bg:#fbeeee; --bad-border:#a94444; --bad-text:#7c2626;
  --neutral-bg:#f1f1ef; --neutral-border:#9096a0; --neutral-text:#484d57;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#15171b; --panel:#1d2026; --text:#e8e8e5; --muted:#9aa0ab;
    --border:#32363e; --accent:#7fa9d8; --accent-strong:#9dbfe6; --accent-contrast:#10151c;
    --ok-bg:#1b2a1f; --ok-border:#548f63; --ok-text:#a9d8b3;
    --warn-bg:#2c2413; --warn-border:#c79a3d; --warn-text:#e7c884;
    --bad-bg:#2d1b1b; --bad-border:#c46a6a; --bad-text:#e9b0b0;
    --neutral-bg:#23262c; --neutral-border:#6b7280; --neutral-text:#b7bcc5;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text);
  font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  max-width:920px; margin:0 auto; padding:28px 20px 72px;
}
:focus-visible{outline:2px solid var(--accent); outline-offset:2px; border-radius:4px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

header.site{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;justify-content:space-between;margin-bottom:22px}
.brand h1{margin:0;font-size:1.7rem;letter-spacing:-.01em}
.brand .tagline{margin:2px 0 0;color:var(--muted)}
.chip{
  border:1px solid var(--border);background:var(--panel);border-radius:999px;
  padding:7px 16px;font-size:.86rem;color:var(--muted);white-space:nowrap
}
.chip strong{color:var(--text);font-weight:600}
.ok-inline{color:var(--ok-border);font-weight:600}
.bad-inline{color:var(--bad-border);font-weight:700}

.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:20px}
.tabs button{
  appearance:none;background:none;border:none;border-bottom:3px solid transparent;
  padding:10px 14px;margin-bottom:-1px;font:inherit;font-weight:600;color:var(--muted);cursor:pointer
}
.tabs button[aria-selected="true"]{color:var(--text);border-bottom-color:var(--accent)}
.tabs button:hover{color:var(--text)}

.lead{color:var(--muted);margin:0 0 14px;max-width:64ch}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:22px}

.dropzone{
  border:2px dashed var(--border);border-radius:10px;padding:26px 18px;text-align:center;
  color:var(--muted);cursor:pointer;transition:border-color .15s,background .15s
}
.dropzone strong{color:var(--text)}
.dropzone:hover,.dropzone.drag{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,transparent)}
.dropzone .hint{font-size:.85rem}
.filename{margin-top:10px;font-size:.9rem;color:var(--text);font-weight:600;word-break:break-all}

.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin-top:18px}
@media (max-width:640px){.grid{grid-template-columns:1fr}}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:.86rem;font-weight:600}
.field .req{color:var(--muted);font-weight:400}
input[type=text],select{
  font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);
  border-radius:8px;padding:9px 11px;width:100%
}
input[type=text]:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px}

.switch-row{display:flex;gap:12px;align-items:flex-start;margin-top:18px}
.switch{position:relative;display:inline-block;width:44px;height:24px;flex:none;margin-top:2px}
.switch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;margin:0}
.slider{
  position:absolute;inset:0;border-radius:999px;background:var(--border);transition:background .15s;pointer-events:none
}
.slider::before{
  content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;
  background:var(--panel);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.25)
}
.switch input:checked + .slider{background:var(--accent)}
.switch input:checked + .slider::before{transform:translateX(20px)}
.switch input:focus-visible + .slider{outline:2px solid var(--accent);outline-offset:2px}
.switch-row .switch-label{font-weight:600}
.switch-row .switch-sub{color:var(--muted);font-size:.88rem}

.note{border:1px solid;border-radius:10px;padding:12px 16px;margin-top:14px;font-size:.92rem}
.note.warn{background:var(--warn-bg);border-color:var(--warn-border);color:var(--warn-text)}
.note.neutral{background:var(--neutral-bg);border-color:var(--neutral-border);color:var(--neutral-text)}
.note.bad{background:var(--bad-bg);border-color:var(--bad-border);color:var(--bad-text)}
.note ul{margin:8px 0 0;padding-left:20px}
.note li{margin:4px 0}

button.primary{
  font:inherit;font-weight:600;color:var(--accent-contrast);background:var(--accent);
  border:none;border-radius:8px;padding:11px 22px;cursor:pointer;margin-top:18px
}
button.primary:hover{background:var(--accent-strong)}
button.primary:disabled{opacity:.6;cursor:default}
button.secondary{
  font:inherit;font-weight:600;color:var(--text);background:none;border:1px solid var(--border);
  border-radius:8px;padding:8px 16px;cursor:pointer
}
button.secondary:hover{border-color:var(--accent);color:var(--accent)}
button.linkish{
  font:inherit;font-size:.88rem;font-weight:600;color:var(--accent);background:none;border:none;
  padding:4px 6px;cursor:pointer;text-decoration:underline;text-underline-offset:3px
}

.verdict{border:1px solid var(--border);border-left-width:5px;border-radius:10px;padding:16px 20px;margin-top:20px;background:var(--panel)}
.verdict.ok{border-left-color:var(--ok-border);background:var(--ok-bg)}
.verdict.warn{border-left-color:var(--warn-border);background:var(--warn-bg)}
.verdict.neutral{border-left-color:var(--neutral-border);background:var(--neutral-bg)}
.verdict-head{display:flex;gap:10px;align-items:center;margin-bottom:6px}
.vicon{font-size:1.15rem;font-weight:700}
.verdict.ok .vicon,.verdict.ok .vtitle{color:var(--ok-text)}
.verdict.warn .vicon,.verdict.warn .vtitle{color:var(--warn-text)}
.verdict.neutral .vicon,.verdict.neutral .vtitle{color:var(--neutral-text)}
.vtitle{font-weight:700;letter-spacing:.04em}
.verdict p{margin:8px 0}

.kvs{display:grid;grid-template-columns:auto 1fr;gap:4px 18px;margin:10px 0}
.kvs dt{color:var(--muted);font-size:.88rem}
.kvs dd{margin:0;font-weight:600;word-break:break-word}

.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
.empty{color:var(--muted);text-align:center;padding:26px 0}

.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:22px;z-index:40}
.dialog{
  background:var(--panel);border:1px solid var(--border);border-radius:12px;
  max-width:780px;width:100%;max-height:86vh;display:flex;flex-direction:column
}
.dialog-head{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}
.dialog-head h2{margin:0;font-size:1.05rem}
.dialog-head .actions{display:flex;gap:8px}
.dialog-body{overflow:auto;padding:18px 22px}
.report h2{font-size:1.2rem;margin:4px 0 10px}
.report h3{font-size:1rem;margin:20px 0 8px}
.report p{margin:8px 0;font-size:.94rem}
.report code{background:var(--neutral-bg);border-radius:4px;padding:1px 5px;font-size:.82em;word-break:break-all}
.report table{margin:8px 0}
.report td,.report th{padding:6px 10px}
.report ul{margin:8px 0;padding-left:22px}

.toast{
  position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:60;
  background:var(--bad-bg);border:1px solid var(--bad-border);color:var(--bad-text);
  border-radius:10px;padding:12px 20px;max-width:min(560px,90vw);font-size:.93rem;
  box-shadow:0 6px 24px rgba(0,0,0,.18)
}

footer{margin-top:36px;color:var(--muted);font-size:.85rem;max-width:70ch}
section[role=tabpanel]{outline:none}
</style>
</head>
<body>

<header class="site">
  <div class="brand">
    <h1>Mattermark</h1>
    <p class="tagline">Mark outbound copies. Attribute leaks.</p>
  </div>
  <div id="status-chip" class="chip" role="status" aria-live="polite">Connecting to vault…</div>
</header>

<nav class="tabs" role="tablist" aria-label="Sections">
  <button id="tab-protect" role="tab" aria-selected="true" aria-controls="panel-protect">Protect a copy</button>
  <button id="tab-identify" role="tab" aria-selected="false" aria-controls="panel-identify" tabindex="-1">Identify a leak</button>
  <button id="tab-copies" role="tab" aria-selected="false" aria-controls="panel-copies" tabindex="-1">Protected copies</button>
</nav>

<main>

<section id="panel-protect" role="tabpanel" aria-labelledby="tab-protect">
  <p class="lead">Use this before a document goes out the door. It embeds an invisible, recipient-specific mark, so that if this copy ever surfaces where it should not, it can be traced back.</p>
  <div class="card">
    <div id="protect-drop" class="dropzone" role="button" tabindex="0"
         aria-label="Choose the document to protect. Accepts .txt and .docx files. Press Enter to open the file picker, or drag a file onto this area.">
      <strong>Drop the document here</strong> or click to choose a file<br>
      <span class="hint">.txt or .docx — PDFs cannot be marked; protect the DOCX source instead</span>
      <div id="protect-file" class="filename" hidden></div>
    </div>
    <input id="protect-input" type="file" accept=".txt,.docx" class="visually-hidden" aria-hidden="true" tabindex="-1">

    <div class="grid">
      <div class="field">
        <label for="f-matter">Matter <span class="req">(required)</span></label>
        <input id="f-matter" type="text" placeholder="e.g. M-2026-0142" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-recipient">Recipient <span class="req">(required)</span></label>
        <input id="f-recipient" type="text" placeholder="e.g. jane.doe@opposing.example" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-version">Version <span class="req">(optional)</span></label>
        <input id="f-version" type="text" placeholder="e.g. v3-redline" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-delivery">Delivery method</label>
        <select id="f-delivery">
          <option value="email">Email</option>
          <option value="secure-link">Secure link</option>
          <option value="portal">Client portal</option>
          <option value="physical">Physical</option>
          <option value="other">Other</option>
          <option value="unknown">Unknown / not decided</option>
        </select>
      </div>
      <div class="field">
        <label for="f-note">Delivery note <span class="req">(optional)</span></label>
        <input id="f-note" type="text" placeholder="e.g. sent under protective order" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-by">Prepared by <span class="req">(optional)</span></label>
        <input id="f-by" type="text" placeholder="Your name — recorded in the evidence ledger" autocomplete="off">
      </div>
    </div>

    <div class="switch-row">
      <span class="switch">
        <input id="searchsafe" type="checkbox" role="switch" aria-describedby="mode-note">
        <span class="slider" aria-hidden="true"></span>
      </span>
      <span>
        <label for="searchsafe" class="switch-label">Search-safe mode</label>
        <div class="switch-sub">Never alter the visible text — at the cost of a weaker mark.</div>
      </span>
    </div>
    <div id="mode-note" class="note warn"></div>

    <button id="protect-go" class="primary">Create protected copy</button>
    <div id="protect-result" aria-live="polite"></div>
  </div>
</section>

<section id="panel-identify" role="tabpanel" aria-labelledby="tab-identify" hidden>
  <p class="lead">Use this when a document has turned up somewhere it should not have. Drop the recovered file and Mattermark will look for a mark and tell you whose copy it was.</p>
  <div class="card">
    <div id="identify-drop" class="dropzone" role="button" tabindex="0"
         aria-label="Choose the recovered document to examine. Accepts .txt, .docx, and .pdf files. Press Enter to open the file picker, or drag a file onto this area.">
      <strong>Drop the recovered document here</strong> or click to choose a file<br>
      <span class="hint">.txt, .docx or .pdf</span>
      <div id="identify-file" class="filename" hidden></div>
    </div>
    <input id="identify-input" type="file" accept=".txt,.docx,.pdf" class="visually-hidden" aria-hidden="true" tabindex="-1">

    <div class="switch-row">
      <input id="record-check" type="checkbox" style="margin-top:5px">
      <span>
        <label for="record-check" class="switch-label">Record this check in the evidence ledger</label>
        <div class="switch-sub">Appends a tamper-evident investigation event if a match is found.</div>
      </span>
    </div>
    <div id="record-fields" class="grid" hidden>
      <div class="field">
        <label for="f-who">Checked by</label>
        <input id="f-who" type="text" placeholder="Your name" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-source">Where was it found? <span class="req">(source)</span></label>
        <input id="f-source" type="text" placeholder="e.g. attached to press inquiry, 27 Jul" autocomplete="off">
      </div>
    </div>

    <button id="identify-go" class="primary">Identify</button>
    <div id="identify-result" aria-live="polite"></div>
  </div>
</section>

<section id="panel-copies" role="tabpanel" aria-labelledby="tab-copies" hidden>
  <p class="lead">Every protected copy this vault has issued, most recent first. Open a copy&#8217;s evidence report when you need something to hand to counsel.</p>
  <div class="card">
    <div class="toolbar">
      <span id="copies-count" class="switch-sub"></span>
      <button id="copies-refresh" class="secondary">Refresh</button>
    </div>
    <div class="tablewrap">
      <table id="copies-table" hidden>
        <caption class="visually-hidden">Protected copies issued by this vault</caption>
        <thead>
          <tr><th scope="col">Issued</th><th scope="col">Matter</th><th scope="col">Recipient</th><th scope="col">Version</th><th scope="col">Mark</th><th scope="col">Investigations</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody id="copies-body"></tbody>
      </table>
    </div>
    <div id="copies-empty" class="empty" hidden>No protected copies yet. Protect one from the first tab.</div>
  </div>
</section>

</main>

<footer>
  Mattermark runs entirely on this computer — documents never leave it. The vault passphrase is the only
  way in: losing it permanently loses the ability to attribute past copies.
</footer>

<div id="modal" class="overlay" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="dialog-head">
      <h2 id="modal-title">Evidence report</h2>
      <div class="actions">
        <button id="report-dl" class="secondary">Download report (.md)</button>
        <button id="modal-close" class="secondary" aria-label="Close report">Close</button>
      </div>
    </div>
    <div id="report-body" class="dialog-body report"></div>
  </div>
</div>

<div id="toast" class="toast" role="alert" hidden></div>

<script>
(function () {
  'use strict';

  var K = new URLSearchParams(location.search).get('k') || '';
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function withKey(path) {
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(K);
  }

  function api(path, body) {
    var opts = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(withKey(path), opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          throw new Error(data && data.error ? data.error : 'Request failed (' + res.status + ')');
        }
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 8000);
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onerror = function () { reject(new Error('Could not read the file.')); };
      r.onload = function () {
        var s = String(r.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      r.readAsDataURL(file);
    });
  }

  function b64ToBlob(b64) {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'application/octet-stream' });
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function isDurableCopy(copy) {
    return (copy.channels || []).some(function (l) {
      return l.embedded && (l.codec === 'HG' || l.codec === 'LM');
    });
  }

  /* ------------------------------ status chip ---------------------------- */

  function loadStatus() {
    api('/api/status').then(function (st) {
      var n = st.copies;
      $('status-chip').innerHTML =
        '<strong>' + esc(st.config.orgName) + '</strong> &middot; ' +
        n + ' protected ' + (n === 1 ? 'copy' : 'copies') + ' &middot; ' +
        (st.chainOk
          ? '<span class="ok-inline">ledger verified &#10003;</span>'
          : '<span class="bad-inline">ledger check FAILED</span>');
    }).catch(function (e) {
      $('status-chip').textContent = 'Vault unavailable';
      toast(e.message);
    });
  }

  /* --------------------------------- tabs -------------------------------- */

  var TABS = ['protect', 'identify', 'copies'];
  function selectTab(name) {
    TABS.forEach(function (n) {
      var sel = n === name;
      var btn = $('tab-' + n);
      btn.setAttribute('aria-selected', sel ? 'true' : 'false');
      btn.tabIndex = sel ? 0 : -1;
      $('panel-' + n).hidden = !sel;
    });
    if (name === 'copies') loadCopies();
  }
  TABS.forEach(function (name, i) {
    var btn = $('tab-' + name);
    btn.addEventListener('click', function () { selectTab(name); });
    btn.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var next = TABS[(i + d + TABS.length) % TABS.length];
      selectTab(next);
      $('tab-' + next).focus();
    });
  });

  /* ------------------------------- dropzones ------------------------------ */

  function makeDrop(zoneId, inputId, nameId) {
    var zone = $(zoneId), input = $(inputId), nameEl = $(nameId);
    var current = null;
    function set(file) {
      if (!file) return;
      current = file;
      nameEl.hidden = false;
      nameEl.textContent = 'Selected: ' + file.name + ' (' + fmtSize(file.size) + ')';
    }
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () { set(input.files && input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      set(f);
    });
    return { file: function () { return current; } };
  }

  /* -------------------------------- protect ------------------------------- */

  var protectDrop = makeDrop('protect-drop', 'protect-input', 'protect-file');

  function renderModeNote() {
    var el = $('mode-note');
    if ($('searchsafe').checked) {
      el.className = 'note neutral';
      el.innerHTML =
        '<strong>Search-safe mode is on.</strong> The document text is never altered visibly, and ' +
        'search, spellcheck and review tools behave exactly as before. The trade-off: the mark is ' +
        '<strong>not durable</strong> — routine cleaning (paste into a web form, format stripping) ' +
        'can destroy it. Use this when the copy will be keyword-searched, e.g. in e-discovery review.';
    } else {
      el.className = 'note warn';
      el.innerHTML =
        '<strong>Durable mark (default).</strong> To survive cleaning, a small number of letters are ' +
        'replaced with identical-looking characters. The document looks the same on screen and in ' +
        'print, but <strong>Ctrl-F / exact-match search, spellcheck, and e-discovery keyword search ' +
        'will not match the altered words</strong> in this copy. If searchability of this exact copy ' +
        'matters, switch on Search-safe mode above.';
    }
  }
  $('searchsafe').addEventListener('change', renderModeNote);
  renderModeNote();

  $('protect-go').addEventListener('click', function () {
    var file = protectDrop.file();
    if (!file) { toast('Choose a .txt or .docx file to protect first.'); return; }
    var matter = $('f-matter').value.trim();
    var recipient = $('f-recipient').value.trim();
    if (!matter || !recipient) {
      toast('Matter and Recipient are required — they are what a recovered mark points back to.');
      return;
    }
    var btn = $('protect-go');
    btn.disabled = true;
    btn.textContent = 'Marking…';
    fileToBase64(file).then(function (b64) {
      var body = { name: file.name, dataBase64: b64, matter: matter, recipient: recipient };
      var v = $('f-version').value.trim(); if (v) body.version = v;
      var d = $('f-delivery').value; if (d) body.delivery = d;
      var n = $('f-note').value.trim(); if (n) body.note = n;
      var by = $('f-by').value.trim(); if (by) body.by = by;
      if ($('searchsafe').checked) body.searchSafe = true;
      return api('/api/protect', body);
    }).then(function (r) {
      renderProtectResult(r);
      loadStatus();
    }).catch(function (e) {
      $('protect-result').innerHTML =
        '<div class="note bad" role="alert"><strong>Could not protect this file.</strong><br>' +
        esc(e.message) + '</div>';
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Create protected copy';
    });
  });

  function renderProtectResult(r) {
    var tests = (r.copy && r.copy.transformTests) || [];
    var survived = tests.filter(function (t) { return t.recovered; }).length;
    var id = r.copy.identity;

    var html = '<div class="verdict ok">';
    html += '<div class="verdict-head"><span class="vicon" aria-hidden="true">&#10003;</span>' +
            '<span class="vtitle">Protected copy created</span></div>';
    html += '<dl class="kvs">' +
      '<dt>Recipient</dt><dd>' + esc(id.recipientId) + '</dd>' +
      '<dt>Matter</dt><dd>' + esc(id.matterRef) + '</dd>' +
      '<dt>Version</dt><dd>' + esc(id.version) + '</dd>' +
      '<dt>File</dt><dd>' + esc(r.suggestedName) + '</dd>' +
      '</dl>';
    if (r.durable) {
      html += '<p><strong>Durable mark.</strong> Survived ' + survived + ' of ' + tests.length +
              ' simulated transformations at issue time.</p>';
    } else {
      html += '<p><strong>Search-safe (non-durable) mark.</strong> Survived ' + survived + ' of ' +
              tests.length + ' simulated transformations — as expected, it does not survive ' +
              'aggressive cleaning.</p>';
    }
    html += '</div>';

    if (r.warnings && r.warnings.length) {
      html += '<div class="note warn"><strong>Advisories from the marking engine:</strong><ul>';
      r.warnings.forEach(function (w) { html += '<li>' + esc(w) + '</li>'; });
      html += '</ul></div>';
    }

    html += '<p style="margin-top:14px"><button id="dl-marked" class="primary" style="margin-top:0">' +
            'Download marked copy</button><br><span class="switch-sub">Deliver the downloaded file — ' +
            'the original on your computer is unmarked.</span></p>';

    $('protect-result').innerHTML = html;
    $('dl-marked').addEventListener('click', function () {
      downloadBlob(b64ToBlob(r.dataBase64), r.suggestedName);
    });
  }

  /* ------------------------------- identify ------------------------------- */

  var identifyDrop = makeDrop('identify-drop', 'identify-input', 'identify-file');

  $('record-check').addEventListener('change', function () {
    $('record-fields').hidden = !this.checked;
  });

  $('identify-go').addEventListener('click', function () {
    var file = identifyDrop.file();
    if (!file) { toast('Choose the recovered file first (.txt, .docx or .pdf).'); return; }
    var btn = $('identify-go');
    btn.disabled = true;
    btn.textContent = 'Examining…';
    var recording = $('record-check').checked;
    fileToBase64(file).then(function (b64) {
      var body = { name: file.name, dataBase64: b64 };
      if (recording) {
        body.record = true;
        var who = $('f-who').value.trim(); if (who) body.by = who;
        var src = $('f-source').value.trim(); if (src) body.source = src;
      }
      return api('/api/identify', body);
    }).then(function (out) {
      renderVerdict(out, recording);
      if (recording) loadStatus();
    }).catch(function (e) {
      $('identify-result').innerHTML =
        '<div class="note bad" role="alert">' + esc(e.message) + '</div>';
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Identify';
    });
  });

  function card(kind, icon, title, body) {
    return '<div class="verdict ' + kind + '"><div class="verdict-head">' +
      '<span class="vicon" aria-hidden="true">' + icon + '</span>' +
      '<span class="vtitle">' + title + '</span></div>' + body + '</div>';
  }

  function attributionDetails(a) {
    var id = a.copy.identity;
    return '<dl class="kvs">' +
      '<dt>Matter</dt><dd>' + esc(id.matterRef) + '</dd>' +
      '<dt>Recipient</dt><dd>' + esc(id.recipientId) + '</dd>' +
      '<dt>Version</dt><dd>' + esc(id.version) + '</dd>' +
      '<dt>Issued</dt><dd>' + esc(fmtDate(id.issuedAt)) + '</dd>' +
      '<dt>Recovered via</dt><dd>' + esc(a.channels.join(' + ')) + ' (' + a.frames +
      ' frame' + (a.frames === 1 ? '' : 's') + ')</dd>' +
      '</dl>';
  }

  function renderVerdict(out, recorded) {
    var a = out.attribution;
    var html;
    if (!out.anyRecovered) {
      html = card('neutral', '&ndash;', 'No mark recovered',
        '<p>No Mattermark identifier was found in this file. Either this document was never marked ' +
        'by this vault, or the mark did not survive: retyping, OCR, or aggressive sanitization can ' +
        'destroy a mark — a search-safe (non-durable) mark in particular does not survive routine ' +
        'cleaning. Absence of a mark is not proof the document never leaked.</p>');
    } else if (a && a.confidence === 'confirmed') {
      html = card('ok', '&#10003;', 'CONFIRMED',
        attributionDetails(a) +
        '<p><strong>Cryptographically verified.</strong> The recovered full-strength token was ' +
        're-verified against this vault&#8217;s sealed registry record. This copy was issued to the ' +
        'recipient above.</p>');
    } else if (a && a.confidence === 'corroborated') {
      html = card('warn', '&asymp;', 'CORROBORATED',
        attributionDetails(a) +
        '<p><strong>Treat as corroborating evidence, not a standalone claim.</strong> What survived ' +
        'is a 64-bit registry pointer — it matches the copy above, but it is not the full ' +
        'cryptographic token. Combine it with other evidence before acting on it.</p>');
    } else {
      html = card('neutral', '?', 'UNRECOGNIZED',
        '<p>A mark was found, but it was not issued by this vault. It may come from another ' +
        'organization&#8217;s marking tool, or from a different Mattermark vault. This vault cannot ' +
        'attribute it.</p>');
    }
    if (recorded && a && a.copy) {
      html += '<p class="switch-sub" style="margin-top:10px">This check was recorded in the evidence ledger.</p>';
    } else if (recorded) {
      html += '<p class="switch-sub" style="margin-top:10px">Nothing attributable was found, so no ledger event was recorded.</p>';
    }
    $('identify-result').innerHTML = html;
  }

  /* --------------------------- protected copies --------------------------- */

  var copiesCache = [];

  function loadCopies() {
    api('/api/copies').then(function (data) {
      copiesCache = data.copies || [];
      var tbody = $('copies-body');
      $('copies-count').textContent = copiesCache.length
        ? copiesCache.length + ' protected ' + (copiesCache.length === 1 ? 'copy' : 'copies')
        : '';
      if (!copiesCache.length) {
        $('copies-table').hidden = true;
        $('copies-empty').hidden = false;
        tbody.innerHTML = '';
        return;
      }
      $('copies-table').hidden = false;
      $('copies-empty').hidden = true;
      var html = '';
      copiesCache.forEach(function (c, i) {
        html += '<tr>' +
          '<td>' + esc(fmtDate(c.identity.issuedAt)) + '</td>' +
          '<td>' + esc(c.identity.matterRef) + '</td>' +
          '<td>' + esc(c.identity.recipientId) + '</td>' +
          '<td>' + esc(c.identity.version) + '</td>' +
          '<td>' + (isDurableCopy(c) ? 'Durable &#10003;' : 'Search-safe') + '</td>' +
          '<td>' + (c.investigations ? c.investigations.length : 0) + '</td>' +
          '<td><button class="linkish" data-idx="' + i + '">Evidence report</button></td>' +
          '</tr>';
      });
      tbody.innerHTML = html;
      Array.prototype.forEach.call(tbody.querySelectorAll('button[data-idx]'), function (b) {
        b.addEventListener('click', function () {
          var c = copiesCache[Number(b.getAttribute('data-idx'))];
          if (c) openReport(c.tokenHex);
        });
      });
    }).catch(function (e) { toast(e.message); });
  }
  $('copies-refresh').addEventListener('click', loadCopies);

  /* ----------------------------- report modal ----------------------------- */

  var reportMd = '';
  var reportName = 'mattermark-report.md';

  function mdToHtml(md) {
    var lines = md.split('\\n');
    var html = '';
    var inTable = false;
    var inList = false;
    function endTable() { if (inTable) { html += '</tbody></table></div>'; inTable = false; } }
    function endList() { if (inList) { html += '</ul>'; inList = false; } }
    function inline(s) {
      s = esc(s);
      s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      return s;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\\|/.test(line)) {
        endList();
        var cells = line.split('|').slice(1, -1).map(function (c) { return c.trim(); });
        var isSep = cells.length > 0 && cells.every(function (c) { return /^:?-+:?$/.test(c); });
        if (isSep) continue;
        var row = cells.map(inline);
        if (!inTable) {
          inTable = true;
          html += '<div class="tablewrap"><table><thead><tr>' +
            row.map(function (c) { return '<th>' + c + '</th>'; }).join('') +
            '</tr></thead><tbody>';
        } else {
          html += '<tr>' + row.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
        }
        continue;
      }
      endTable();
      if (/^### /.test(line)) { endList(); html += '<h4>' + inline(line.slice(4)) + '</h4>'; }
      else if (/^## /.test(line)) { endList(); html += '<h3>' + inline(line.slice(3)) + '</h3>'; }
      else if (/^# /.test(line)) { endList(); html += '<h2>' + inline(line.slice(2)) + '</h2>'; }
      else if (/^- /.test(line)) { if (!inList) { inList = true; html += '<ul>'; } html += '<li>' + inline(line.slice(2)) + '</li>'; }
      else if (line.trim() === '') { endList(); }
      else { endList(); html += '<p>' + inline(line) + '</p>'; }
    }
    endTable();
    endList();
    return html;
  }

  function openReport(tokenHex) {
    api('/api/report', { token: tokenHex }).then(function (r) {
      reportMd = r.markdown;
      reportName = 'mattermark-report-' + tokenHex.slice(0, 12) + '.md';
      $('report-body').innerHTML = mdToHtml(r.markdown);
      $('modal').hidden = false;
      $('modal-close').focus();
    }).catch(function (e) { toast(e.message); });
  }

  function closeModal() { $('modal').hidden = true; }
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('modal').hidden) closeModal();
  });
  $('report-dl').addEventListener('click', function () {
    downloadBlob(new Blob([reportMd], { type: 'text/markdown' }), reportName);
  });

  /* --------------------------------- boot --------------------------------- */

  loadStatus();
})();
</script>
</body>
</html>
`;
