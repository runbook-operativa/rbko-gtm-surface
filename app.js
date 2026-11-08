/* Lote surface — plain JS + supabase-js. Reads with RLS as miguel@runbook.es; every tap inserts a touches row (by=miguel). */
(function () {
  "use strict";
  const CFG = window.RBKO_SURFACE || {};
  const USER = "miguel@runbook.es";
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.anonKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  const $ = (id) => document.getElementById(id);
  const state = { config: {}, bd: null, packets: [], videos: {}, touches: [], accounts: {}, folderUrl: null };

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200); }
  function madridDate(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d || new Date()); }
  function mondayISO() {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d.toISOString();
  }
  const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  function fecha(iso) { const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return `${DIAS[dt.getUTCDay()]} ${d}/${m}`; }
  function ago(ts) { const days = Math.floor((Date.now() - new Date(ts)) / 864e5); return days <= 0 ? "hoy" : days === 1 ? "ayer" : `hace ${days} días`; }

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copiado`); }
    catch (e) { window.prompt("Copia el texto:", text); }
  }

  async function q(promise) { const { data, error } = await promise; if (error) throw error; return data; }

  async function load() {
    const cfgRows = await q(sb.from("config").select("key,value"));
    state.config = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));
    const today = madridDate();
    const past = await q(sb.from("batches").select("*").lte("batch_date", today).order("batch_date", { ascending: false }).limit(1));
    const next = await q(sb.from("batches").select("*").gt("batch_date", today).order("batch_date", { ascending: true }).limit(1));
    state.batch = (past[0] && past[0].batch_date === today ? past[0] : next[0] || past[0]) || null;
    state.bd = state.batch ? state.batch.batch_date : null;
    state.folderUrl = state.bd ? state.config["drive_folder_" + state.bd] || null : null;
    if (state.bd) {
      const assets = await q(sb.from("assets").select("asset_id,account_id,type,content,path_drive,render_status,duration_seconds").eq("batch_date", state.bd));
      const byAcc = Object.fromEntries(assets.filter((a) => a.type === "packet" && a.content && a.content.summary).map((a) => [a.account_id, a]));
      state.packets = (state.batch.account_ids || []).map((id) => byAcc[id]).filter(Boolean);
      state.videos = Object.fromEntries(assets.filter((a) => a.type === "vsl" && a.render_status === "rendered").map((a) => [a.account_id, a]));
    }
    state.touches = await q(sb.from("touches").select("touch_id,account_id,channel,direction,outcome,ts,reply_text").eq("by", "miguel").order("ts", { ascending: true }));
    const ids = [...new Set(state.touches.map((t) => t.account_id))];
    state.accounts = {};
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await q(sb.from("accounts").select("account_id,name,district,stage,phone_business").in("account_id", ids.slice(i, i + 100)));
      rows.forEach((r) => (state.accounts[r.account_id] = r));
    }
    render();
  }

  function touchesFor(id) { return state.touches.filter((t) => t.account_id === id); }
  function has(id, outcome, channel) { return touchesFor(id).some((t) => t.outcome === outcome && (!channel || t.channel === channel)); }

  async function tap(p, kind, extra) {
    const c = p.content;
    const repeat = { enviado: "sent", aceptado: "accepted" }[kind];
    if (repeat && has(p.account_id, repeat) && !window.confirm("Ya está registrado. ¿Registrar otra vez?")) return;
    const mins = state.config.minutes_miguel || {};
    const map = {
      enviado: { channel: c.e2_arm === "message_first" ? "linkedin_message" : "linkedin_connect", direction: "out", outcome: "sent", m: mins.enviado },
      aceptado: { channel: "linkedin_connect", direction: "in", outcome: "accepted", m: mins.aceptado },
      respondio: { channel: "linkedin_message", direction: "in", outcome: "replied", m: mins.respondio },
      llamada_sin_respuesta: { channel: "phone", direction: "out", outcome: "no_answer", m: mins.llamada_sin_respuesta },
      llamada_hable: { channel: "phone", direction: "out", outcome: "spoke", m: mins.llamada_hable },
    }[kind];
    const video = state.videos[p.account_id];
    const row = {
      account_id: p.account_id, contact_id: c.contact_id || null, channel: map.channel, direction: map.direction,
      by: "miguel", outcome: map.outcome, minutes_miguel: map.m ?? null,
      asset_id: kind === "enviado" && c.e2_arm === "message_first" && video ? video.asset_id : null,
      reply_text: extra || null,
    };
    const { data, error } = await sb.from("touches").insert(row).select().single();
    if (error) { toast("No se pudo guardar: " + error.message); return; }
    state.touches.push(data);
    toast("Guardado");
    render();
  }

  function videoDraft(v) {
    const ec = state.config.end_card || {};
    const c = (v && v.content) || {};
    const why = [];
    if (!c.placeholders || c.placeholders.length) why.push("módulos sin grabar");
    if (!(ec.booking_link && ec.whatsapp) || !c.end_card_set) why.push("tarjeta final sin configurar");
    return why.join(" + ");
  }

  function videoBlock(p) {
    const v = state.videos[p.account_id];
    const c = p.content;
    if (v) {
      const url = (v.content && (v.content.drive_url || v.content.folder_url)) || state.folderUrl;
      const draft = videoDraft(v);
      const label = draft ? "Ver vídeo (borrador — no enviar)" : `Abrir vídeo · ${Math.round(v.duration_seconds || 0)} s`;
      const link = url ? el("a", { class: draft ? "btn" : "btn primary", href: url, target: "_blank", rel: "noopener" }, label)
                       : el("div", { class: "muted" }, "Vídeo en Drive: " + v.path_drive);
      return draft ? el("div", { style: "flex:1 1 100%" }, el("div", { class: "notice" }, `Vídeo en borrador — no enviar (${draft}). Solo nota de conexión.`), el("div", { class: "row" }, link)) : link;
    }
    return el("div", { class: "notice" }, (c.video && c.video.notice) || "vídeo no disponible hoy — el render no se ejecutó");
  }

  function card(p) {
    const c = p.content, id = p.account_id;
    const sent = has(id, "sent"), acc = has(id, "accepted"), rep = has(id, "replied");
    const reply = el("textarea", { placeholder: "Pega aquí la respuesta…" });
    const replyBox = el("div", { class: "block", hidden: true }, reply,
      el("div", { class: "row" }, el("button", { class: "primary", on: { click: () => reply.value.trim() ? tap(p, "respondio", reply.value.trim()) : toast("Pega la respuesta primero") } }, "Guardar respuesta")));
    const status = [sent && "enviado", acc && "aceptado", rep && "respondió"].filter(Boolean).join(" · ");
    return el("article", { class: "card" },
      el("h2", {}, c.clinic || id),
      el("div", { class: "meta" }, [c.district, c.e2_forced ? "conectar primero (vídeo en borrador)" : c.e2_arm === "message_first" ? "E2: mensaje primero" : "E2: conectar primero"].filter(Boolean).join(" · ")),
      el("div", { class: "signal" }, c.signal_line || ""),
      status ? el("div", { class: "state" }, status) : null,
      el("details", {}, el("summary", {}, "Resumen de 60 segundos"), el("pre", {}, c.summary)),
      el("div", { class: "block" }, el("div", { class: "label" }, "Nota de conexión"), el("div", { class: "text" }, c.connection_note),
        el("div", { class: "row" }, el("button", { on: { click: () => copy(c.connection_note, "Nota") } }, "Copiar nota"))),
      el("div", { class: "block" }, el("div", { class: "label" }, c.e2_forced ? "Mensaje (tras aceptar; el vídeo aún no se envía)" : "Mensaje (con el vídeo)"), el("div", { class: "text" }, c.message_text.replace("[vídeo]\n", "")),
        el("div", { class: "row" }, el("button", { on: { click: () => copy(c.message_text.replace("[vídeo]\n", ""), "Mensaje") } }, "Copiar mensaje"))),
      el("div", { class: "row" }, videoBlock(p),
        c.linkedin_url ? el("a", { class: "btn", href: c.linkedin_url, target: "_blank", rel: "noopener" }, "Perfil LinkedIn")
          : c.linkedin_search_url ? el("a", { class: "btn", href: c.linkedin_search_url, target: "_blank", rel: "noopener" }, "Buscar en LinkedIn") : null),
      el("div", { class: "row" },
        el("button", { class: sent ? "done" : "primary", on: { click: () => tap(p, "enviado") } }, sent ? "Enviado ✓" : "Enviado"),
        el("button", { class: acc ? "done" : "", on: { click: () => tap(p, "aceptado") } }, acc ? "Aceptado ✓" : "Aceptado"),
        el("button", { class: rep ? "done" : "", on: { click: () => (replyBox.hidden = !replyBox.hidden) } }, rep ? "Respondió ✓" : "Respondió")),
      replyBox,
      el("details", {}, el("summary", {}, `Llamada · ${c.phone_business || "sin teléfono"}`),
        c.screen_on_call ? el("div", { class: "muted" }, "Confirmar en la llamada qué programa de gestión y qué número de WhatsApp usan.") : null,
        el("pre", {}, c.call_script),
        el("div", { class: "row" },
          c.phone_business ? el("a", { class: "btn", href: "tel:" + c.phone_business.replace(/\s/g, "") }, "Llamar") : null,
          el("button", { on: { click: () => tap(p, "llamada_sin_respuesta") } }, "Sin respuesta"),
          el("button", { on: { click: () => tap(p, "llamada_hable") } }, "Hablé")))
    );
  }

  function renderWeek() {
    const since = mondayISO();
    const cap = Number(state.config.weekly_invite_cap || 100);
    const n = state.touches.filter((t) => t.outcome === "sent" && t.ts >= since && (t.channel === "linkedin_connect" || t.channel === "linkedin_message")).length;
    const w = $("week");
    w.hidden = false;
    w.replaceChildren(el("div", {}, `Semana: ${n} invitaciones enviadas de ${cap}`), el("div", { class: "bar" }, el("i", { style: `width:${Math.min(100, (100 * n) / cap)}%` })));
  }

  function renderPendientes() {
    const byAcc = {};
    state.touches.forEach((t) => (byAcc[t.account_id] = byAcc[t.account_id] || []).push(t));
    const rows = Object.entries(byAcc)
      .filter(([, ts]) => ts.some((t) => t.outcome === "sent") && !ts.some((t) => ["replied", "booked", "spoke"].includes(t.outcome)))
      .map(([id, ts]) => ({ id, first: ts.find((t) => t.outcome === "sent").ts, accepted: ts.some((t) => t.outcome === "accepted"), n: ts.length }))
      .sort((a, b) => a.first.localeCompare(b.first));
    const box = $("pendientes");
    if (!rows.length) { box.replaceChildren(el("div", { class: "empty" }, "Nada pendiente.")); return; }
    box.replaceChildren(...rows.map((r) => {
      const a = state.accounts[r.id] || {};
      return el("article", { class: "card" }, el("h2", {}, a.name || r.id),
        el("div", { class: "meta" }, `${a.district || ""} · enviado ${ago(r.first)} · ${r.accepted ? "aceptado, sin respuesta" : "sin aceptar"} · ${r.n} toques`),
        a.phone_business ? el("div", { class: "row" }, el("a", { class: "btn", href: "tel:" + a.phone_business.replace(/\s/g, "") }, "Llamar " + a.phone_business)) : null);
    }));
  }

  function render() {
    $("title").textContent = state.bd ? `Lote de hoy — ${fecha(state.bd)}` : "Lote de hoy";
    renderWeek();
    const box = $("lote");
    const head = [];
    if (state.batch && state.bd > madridDate()) head.push(el("div", { class: "signal" }, `Lote preparado para el ${fecha(state.bd)}.`));
    else if (state.batch && state.bd !== madridDate()) head.push(el("div", { class: "notice" }, `No hay lote de hoy; mostrando el del ${fecha(state.bd)}.`));
    if (state.batch && state.batch.notes) head.push(el("div", { class: "muted" }, state.batch.notes));
    if (!state.packets.length) box.replaceChildren(...head, el("div", { class: "empty" }, "Todavía no hay lote."));
    else box.replaceChildren(...head, ...state.packets.map(card));
    renderPendientes();
  }

  function showTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    $("lote").hidden = name !== "lote"; $("pendientes").hidden = name !== "pendientes";
  }

  async function start() {
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
    $("send-link").addEventListener("click", async () => {
      const { error } = await sb.auth.signInWithOtp({ email: USER, options: { shouldCreateUser: false, emailRedirectTo: location.href.split("#")[0] } });
      $("login-msg").textContent = error ? "Error: " + error.message : "Enlace enviado a " + USER + ". Ábrelo en este móvil.";
    });
    const { data } = await sb.auth.getSession();
    const email = data.session && data.session.user && data.session.user.email;
    if (email !== USER) { $("login").hidden = false; return; }
    $("who").textContent = email; $("logout").hidden = false; $("tabs").hidden = false;
    try { await load(); } catch (e) { $("lote").replaceChildren(el("div", { class: "notice" }, "Error al cargar: " + e.message)); }
  }
  start();
})();
