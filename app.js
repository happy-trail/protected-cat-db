/* 保護猫DB PWA v1
 * Supabase CRUD + RLS + レスポンシブUI + 印刷/PDF + PWA
 * Google Drive連携は次フェーズで追加可能な設計。
 */
(() => {
  "use strict";

  const cfg = window.CAT_DB_CONFIG || {};
  const $ = id => document.getElementById(id);
  const state = {
    supabase: null,
    user: null,
    profile: null,
    cats: [],
    selectedCat: null,
    editing: false,
    deferredInstall: null,
    googleToken: null,
    googleTokenClient: null
  };

  const STATUS_LABEL = {
    protected: "保護中", adopted: "譲渡済", deceased: "死亡", missing: "行方不明", other: "その他"
  };
  const SEX_LABEL = { male: "オス", female: "メス", unknown: "不明" };
  const NEUTER_LABEL = { intact: "未手術", neutered: "去勢済", spayed: "避妊済", unknown: "不明" };
  const TEST_LABEL = { positive: "陽性", negative: "陰性", unknown: "不明", not_tested: "未検査" };

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[c]));
  }

  function formatDate(value) {
    if (!value) return "—";
    const [y,m,d] = String(value).split("-");
    return y && m && d ? `${y}/${m}/${d}` : value;
  }

  function show(view) {
    ["login-view","setup-view","app-view"].forEach(id => $(id).classList.add("hidden"));
    $(view).classList.remove("hidden");
  }

  function panel(name) {
    ["list-panel","detail-panel","cat-form-panel","observation-panel"].forEach(id => $(id).classList.add("hidden"));
    $(name).classList.remove("hidden");
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2600);
  }

  function message(id, text, type="") {
    const el = $(id);
    el.textContent = text;
    el.className = `message ${type}`;
  }

  function hasConfig() {
    return Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  }

  function saveConfig(url, key) {
    localStorage.setItem("catdb.supabaseUrl", url.trim());
    localStorage.setItem("catdb.supabaseAnonKey", key.trim());
  }

  function loadConfig() {
    if (!cfg.supabaseUrl) cfg.supabaseUrl = localStorage.getItem("catdb.supabaseUrl") || "";
    if (!cfg.supabaseAnonKey) cfg.supabaseAnonKey = localStorage.getItem("catdb.supabaseAnonKey") || "";
  }

  async function initSupabase() {
    loadConfig();
    if (!hasConfig()) {
      show("setup-view");
      $("config-url").value = cfg.supabaseUrl;
      $("config-key").value = cfg.supabaseAnonKey;
      $("connection-status").textContent = "Supabase未設定";
      return false;
    }
    if (!window.supabase?.createClient) {
      message("config-message", "Supabaseライブラリを読み込めません。ネットワークを確認してください。", "error");
      show("setup-view");
      return false;
    }
    state.supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    $("connection-status").textContent = "Supabase接続準備完了";
    return true;
  }

  async function loadSession() {
    if (!state.supabase) return;
    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    state.user = data.session?.user || null;
    if (!state.user) {
      show("login-view");
      return;
    }
    await loadProfile();
    show("app-view");
    $("user-label").textContent = `${state.profile?.display_name || state.user.email || ""} / ${state.profile?.role || "viewer"}`;
    await loadCats();
  }

  async function loadProfile() {
    const { data, error } = await state.supabase
      .from("profiles")
      .select("id,display_name,role,active")
      .eq("id", state.user.id)
      .single();
    if (error) throw error;
    if (!data.active) throw new Error("このアカウントは無効になっています。");
    state.profile = data;
    updateRoleControls();
  }

  function updateRoleControls() {
    const editable = canEdit();
    const newCatButton = $("new-cat-button");
    const editCatButton = $("edit-cat-button");
    if (newCatButton) newCatButton.classList.toggle("hidden", !editable);
    if (editCatButton) editCatButton.classList.toggle("hidden", !editable);
  }

  function canEdit() {
    return ["admin","staff"].includes(state.profile?.role);
  }

  function isAdmin() {
    return state.profile?.role === "admin";
  }

  async function deleteCatRecord() {
    const cat = state.selectedCat;
    if (!cat || !isAdmin()) return toast("猫の削除は管理者のみ実行できます。");
    const label = `${cat.management_no || "管理番号なし"} / ${cat.name || "名前未登録"}`;
    const ok = window.confirm(`次の猫を一覧から削除します。
${label}

記録は完全消去せず、非表示にします。続けますか？`);
    if (!ok) return;
    try {
      const { error } = await state.supabase.rpc("soft_delete_cat", {
        p_cat_id: cat.id
      });
      if (error) throw error;
      state.selectedCat = null;
      await loadCats();
      panel("list-panel");
      toast("猫を一覧から削除しました（記録は保持されています）。");
    } catch (e) {
      console.error("猫の論理削除に失敗しました", e);
      const detail = [e.message, e.code ? `code=${e.code}` : "", e.details, e.hint].filter(Boolean).join(" / ");
      toast(`猫を削除できませんでした：${detail || String(e)}`);
    }
  }

  async function deleteCatPhoto(fileId) {
    const cat = state.selectedCat;
    if (!cat || !isAdmin()) return toast("写真の削除は管理者のみ実行できます。");
    const file = cat.files.find(f => f.id === fileId);
    if (!file) return toast("写真情報が見つかりません。");
    if (!window.confirm(`写真「${file.file_name || "名称未設定"}」をGoogle Driveとデータベースから削除します。
この操作は元に戻せません。よろしいですか？`)) return;
    try {
      if (file.drive_file_id) {
        const response = await driveApi(`files/${encodeURIComponent(file.drive_file_id)}`, {method:"DELETE"});
        if (!response.ok && response.status !== 404) {
          const detail = await response.text();
          throw new Error(`Google Drive削除失敗 (${response.status})：${detail.slice(0, 180)}`);
        }
      }
      const { error } = await state.supabase.from("cat_files").delete().eq("id", file.id).eq("cat_id", cat.id);
      if (error) throw error;
      if (state.driveImageUrls?.[file.drive_file_id]) {
        URL.revokeObjectURL(state.driveImageUrls[file.drive_file_id]);
        delete state.driveImageUrls[file.drive_file_id];
      }
      const remaining = cat.files.filter(f => f.id !== file.id);
      const nextMain = remaining.find(f => f.is_main_photo) || remaining[0] || null;
      if (file.is_main_photo || cat.main_photo_file_id === file.id) {
        const { error: updateError } = await state.supabase.from("cats")
          .update({main_photo_file_id: nextMain?.id || null, updated_by: state.user.id})
          .eq("id", cat.id);
        if (updateError) throw updateError;
        if (nextMain && !nextMain.is_main_photo) {
          const { error: mainError } = await state.supabase.from("cat_files")
            .update({is_main_photo:true}).eq("id", nextMain.id).eq("cat_id", cat.id);
          if (mainError) throw mainError;
        }
      }
      toast("写真を削除しました。");
      await openCat(cat.id);
    } catch (e) {
      toast(`写真を削除できませんでした：${e.message || e}`);
    }
  }

  async function loadCats() {
    const { data, error } = await state.supabase
      .from("cats")
      .select("id,management_no,name,sex,breed,rescued_date,estimated_age_text,status,main_photo_file_id")
      .is("deleted_at", null)
      .order("management_no", { ascending: true });
    if (error) {
      $("connection-status").textContent = "DBエラー";
      throw error;
    }
    state.cats = data || [];
    renderCatList();
    $("connection-status").textContent = `接続中・${state.cats.length}匹`;
  }

  function filteredCats() {
    const q = $("search-input").value.trim().toLowerCase();
    const status = $("status-filter").value;
    return state.cats.filter(cat => {
      const hay = `${cat.management_no} ${cat.name} ${cat.breed}`.toLowerCase();
      return (!q || hay.includes(q)) && (!status || cat.status === status);
    });
  }

  function renderCatList() {
    const list = $("cat-list");
    const cats = filteredCats();
    if (!cats.length) {
      list.innerHTML = `<div class="empty">該当する猫がありません。</div>`;
      return;
    }
    list.innerHTML = cats.map(cat => `
      <article class="cat-card">
        <div class="cat-thumb">🐱</div>
        <div>
          <div class="cat-name">${esc(cat.name || "名前未登録")}</div>
          <div class="cat-meta">${esc(cat.management_no)} ・ ${esc(SEX_LABEL[cat.sex] || "不明")} ・ ${esc(cat.breed || "品種未登録")}</div>
          <div class="cat-meta">保護日 ${esc(formatDate(cat.rescued_date))}</div>
        </div>
        <button class="secondary open-cat" data-id="${esc(cat.id)}" type="button">詳細</button>
      </article>
    `).join("");
    list.querySelectorAll(".open-cat").forEach(btn =>
      btn.addEventListener("click", () => openCat(btn.dataset.id))
    );
  }

  async function openCat(id) {
    const { data, error } = await state.supabase
      .from("cats")
      .select("*")
      .eq("id", id)
      .single();
    if (error) return toast(error.message);

    const [vaccinations, virusTests, surgeries, observations, transfers, files] = await Promise.all([
      state.supabase.from("vaccinations").select("*").eq("cat_id", id).order("vaccination_date", {ascending:false}),
      state.supabase.from("virus_tests").select("*").eq("cat_id", id).order("test_date", {ascending:false}),
      state.supabase.from("surgeries").select("*").eq("cat_id", id).order("surgery_date", {ascending:false}),
      state.supabase.from("observations").select("*").eq("cat_id", id).order("observation_date", {ascending:false}).order("created_at", {ascending:false}),
      state.supabase.from("transfers").select("*").eq("cat_id", id).order("transfer_date", {ascending:false}),
      state.supabase.from("cat_files").select("*").eq("cat_id", id).order("is_main_photo", {ascending:false}).order("taken_at", {ascending:false})
    ]);

    state.selectedCat = {
      ...data,
      vaccinations: vaccinations.data || [],
      virusTests: virusTests.data || [],
      surgeries: surgeries.data || [],
      observations: observations.data || [],
      transfers: transfers.data || [],
      files: files.data || []
    };
    renderDetail();
    updateRoleControls();
    panel("detail-panel");
  }

  function latest(arr) { return arr?.[0] || null; }

  async function loadDriveImageUrl(driveFileId) {
    if (!driveFileId) return "";
    state.driveImageUrls = state.driveImageUrls || {};
    if (state.driveImageUrls[driveFileId]) return state.driveImageUrls[driveFileId];

    const token = await ensureGoogleToken();
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
      cache: "no-store"
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`写真取得失敗 (${response.status}): ${body.slice(0, 300)}`);
    }
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      throw new Error(`画像ではないデータが返りました: ${blob.type || "unknown"}`);
    }
    const url = URL.createObjectURL(blob);
    state.driveImageUrls[driveFileId] = url;
    return url;
  }

  async function renderDetail() {
    const c = state.selectedCat;
    const vaccine = latest(c.vaccinations);
    const test = latest(c.virusTests);
    const surgery = latest(c.surgeries);
    const mainFile = c.files.find(f => f.is_main_photo) || c.files[0];
    let mainImageUrl = "";
    let mainImageError = "";
    if (mainFile?.drive_file_id) {
      try { mainImageUrl = await loadDriveImageUrl(mainFile.drive_file_id); } catch (e) { console.warn(e); mainImageError = e.message || String(e); }
    }
    const img = mainImageUrl
      ? `<img class="detail-photo" src="${esc(mainImageUrl)}" alt="${esc(c.name)}の写真">`
      : `<div class="detail-photo" aria-label="写真未登録" style="display:grid;place-items:center;font-size:64px">🐱</div>`;
    const mainImageStatus = mainImageError ? `<div class="photo-error">写真を表示できません：${esc(mainImageError)}<br><button type="button" id="retry-drive-photo" class="secondary">Drive再接続して再表示</button></div>` : "";

    $("cat-detail").innerHTML = `
      <div class="detail-grid">
        <div>${img}${mainImageStatus}</div>
        <div>
          <h2>${esc(c.name || "名前未登録")} <span class="status">${esc(STATUS_LABEL[c.status])}</span></h2>
          <p class="muted">${esc(c.management_no)}</p>
          <div class="info-grid">
            <div class="key">性別</div><div>${esc(SEX_LABEL[c.sex])}</div>
            <div class="key">品種等</div><div>${esc(c.breed || "—")}</div>
            <div class="key">保護日</div><div>${esc(formatDate(c.rescued_date))}</div>
            <div class="key">推定年齢</div><div>${esc(c.estimated_age_text || "—")}</div>
            <div class="key">不妊・去勢</div><div>${esc(NEUTER_LABEL[c.neuter_status])}</div>
            <div class="key">ワクチン</div><div>${vaccine ? `${esc(vaccine.vaccine_type)} / ${esc(formatDate(vaccine.vaccination_date))}` : "—"}</div>
            <div class="key">FIV</div><div>${test ? esc(TEST_LABEL[test.fiv_result]) : "—"}</div>
            <div class="key">FeLV</div><div>${test ? esc(TEST_LABEL[test.felv_result]) : "—"}</div>
            <div class="key">手術</div><div>${surgery ? `${esc(surgery.surgery_type)} / ${esc(formatDate(surgery.surgery_date))}` : "—"}</div>
          </div>
        </div>
      </div>

      <h3 class="section-title">観察日記
        ${canEdit() ? '<button id="add-observation" class="primary" type="button">＋ 追加</button>' : ""}
      </h3>
      <div class="timeline">
        ${c.observations.length ? c.observations.map(o => `
          <div class="timeline-item">
            <div class="timeline-date">${esc(formatDate(o.observation_date))}</div>
            <div><strong>体調：</strong>${esc(o.condition || "—")}　<strong>食欲：</strong>${esc(o.appetite || "—")}</div>
            <div><strong>排便：</strong>${esc(o.stool || "—")}　<strong>排尿：</strong>${esc(o.urine || "—")}</div>
            <div><strong>様子：</strong>${esc(o.behavior || "—")}</div>
            <div>${esc(o.memo || "")}</div>
            ${o.weight_kg ? `<div class="muted">体重 ${esc(o.weight_kg)} kg${o.temperature_c ? ` / 体温 ${esc(o.temperature_c)} ℃` : ""}</div>` : ""}
            ${o.entry_type && o.entry_type !== "daily" ? `<div><strong>記録区分：</strong>${esc(o.entry_type === "rescue" ? "保護時" : "死亡記録")}</div>` : ""}
            ${o.rescue_location ? `<div><strong>保護場所：</strong>${esc(o.rescue_location)}</div>` : ""}
            ${o.rescue_details ? `<div><strong>保護時の状況：</strong>${esc(o.rescue_details)}</div>` : ""}
            ${o.death_date ? `<div><strong>死亡日：</strong>${esc(formatDate(o.death_date))}</div>` : ""}
            ${o.death_cause ? `<div><strong>死因：</strong>${esc(o.death_cause)}</div>` : ""}
            ${o.veterinary_hospital ? `<div><strong>動物病院：</strong>${esc(o.veterinary_hospital)}</div>` : ""}
            ${o.death_note ? `<div><strong>死亡時メモ：</strong>${esc(o.death_note)}</div>` : ""}
          </div>
        `).join("") : '<div class="empty">観察日記はまだありません。</div>'}
      </div>

      <h3 class="section-title">医療履歴</h3>
      <div class="timeline">
        ${c.vaccinations.map(v => `<div class="timeline-item"><div class="timeline-date">${esc(formatDate(v.vaccination_date))}</div><strong>ワクチン</strong> ${esc(v.vaccine_type)} ${esc(v.veterinary_hospital)}</div>`).join("")}
        ${c.virusTests.map(t => `<div class="timeline-item"><div class="timeline-date">${esc(formatDate(t.test_date))}</div><strong>検査</strong> FIV ${esc(TEST_LABEL[t.fiv_result])} / FeLV ${esc(TEST_LABEL[t.felv_result])}</div>`).join("")}
        ${c.surgeries.map(s => `<div class="timeline-item"><div class="timeline-date">${esc(formatDate(s.surgery_date))}</div><strong>手術</strong> ${esc(s.surgery_type)} ${esc(s.veterinary_hospital)}</div>`).join("")}
        ${(!c.vaccinations.length && !c.virusTests.length && !c.surgeries.length) ? '<div class="empty">医療履歴はありません。</div>' : ""}
      </div>

      <!-- 写真一覧は画面下部の drive-files に一本化。ここで重複表示しない。 -->

      <h3 class="section-title">譲渡情報</h3>
      <div class="info-grid"><div class="key">譲渡</div><div>${c.transfers.length ? esc(formatDate(c.transfers[0].transfer_date)) : "未登録"}</div></div>
      ${isAdmin() ? `<div class="danger-zone"><p>管理者操作</p><button type="button" id="delete-cat-button" class="danger">この猫を一覧から削除</button></div>` : ""}
    `;
    const photoCards = document.querySelectorAll("[data-drive-file-id]");
    photoCards.forEach(async card => {
      const id = card.dataset.driveFileId;
      if (!id) return;
      try {
        const url = await loadDriveImageUrl(id);
        const loading = card.querySelector(".photo-loading");
        if (loading) loading.outerHTML = `<img src="${esc(url)}" alt="${esc(card.querySelector("small")?.textContent || "写真")}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px">`;
      } catch (e) { console.warn(e); }
    });

    const dc = $("drive-controls");
    if (dc) {
      dc.classList.toggle("hidden", !canEdit());
      renderDriveFiles();
    }
    const retryPhoto = $("retry-drive-photo");
    if (retryPhoto) retryPhoto.addEventListener("click", async () => {
      try {
        state.googleToken = null;
        sessionStorage.removeItem("catdb_google_drive_token");
        if (state.googleTokenClient) state.googleTokenClient.requestAccessToken({ prompt: "consent" });
        await new Promise(r => setTimeout(r, 500));
        await openCat(state.selectedCat.id);
      } catch (e) {
        setDriveMessage(e.message || String(e), "error");
      }
    });
    const add = $("add-observation");
    if (add) add.addEventListener("click", openObservationForm);
    const deleteCatButton = $("delete-cat-button");
    if (deleteCatButton) deleteCatButton.addEventListener("click", deleteCatRecord);
    document.querySelectorAll(".photo-delete-button").forEach(btn => {
      btn.addEventListener("click", () => deleteCatPhoto(btn.dataset.fileId));
    });
  }

  function openCatForm(cat=null) {
    state.editing = Boolean(cat);
    $("cat-form-title").textContent = cat ? "猫情報を編集" : "猫を登録";
    $("cat-id").value = cat?.id || "";
    $("management-no").value = cat?.management_no || "";
    $("cat-name").value = cat?.name || "";
    $("cat-sex").value = cat?.sex || "unknown";
    $("cat-breed").value = cat?.breed || "雑種";
    $("rescued-date").value = cat?.rescued_date || "";
    $("estimated-birth-date").value = cat?.estimated_birth_date || "";
    $("estimated-age").value = cat?.estimated_age_text || "";
    $("cat-status").value = cat?.status || "protected";
    $("neuter-status").value = cat?.neuter_status || "unknown";
    $("current-note").value = cat?.current_note || "";
    message("cat-form-message","");
    panel("cat-form-panel");
  }

  async function saveCat(e) {
    e.preventDefault();
    if (!canEdit()) return message("cat-form-message","閲覧権限では編集できません。","error");

    const id = $("cat-id").value || null;
    const desiredStatus = $("cat-status").value;
    const payload = {
      management_no: $("management-no").value.trim() || null,
      name: $("cat-name").value.trim(),
      sex: $("cat-sex").value,
      breed: $("cat-breed").value.trim(),
      rescued_date: $("rescued-date").value || null,
      estimated_birth_date: $("estimated-birth-date").value || null,
      estimated_age_text: $("estimated-age").value.trim(),
      status: desiredStatus,
      neuter_status: $("neuter-status").value,
      current_note: $("current-note").value.trim(),
      updated_by: state.user.id
    };

    if (!payload.name) return message("cat-form-message","名前を入力してください。","error");

    let result;
    if (id) {
      result = await state.supabase.from("cats").update(payload).eq("id", id).select().single();
    } else {
      payload.created_by = state.user.id;
      result = await state.supabase.from("cats").insert(payload).select().single();
    }
    if (result.error) return message("cat-form-message", result.error.message, "error");

    toast(id ? "猫情報を更新しました" : `猫を登録しました（${result.data.management_no}）`);
    await loadCats();
    await openCat(result.data.id);
  }

  function openObservationForm() {
    if (!state.selectedCat || !canEdit()) return;
    $("obs-date").value = today();
    $("obs-entry-type").value = "daily";
    updateObservationTypeFields();
    ["obs-condition","obs-appetite","obs-stool","obs-urine","obs-behavior","obs-weight","obs-temperature","obs-memo","obs-rescue-location","obs-rescue-details","obs-death-date","obs-death-cause","obs-death-hospital","obs-death-note"].forEach(id => $(id).value = "");
    message("observation-message","");
    panel("observation-panel");
  }

  function updateObservationTypeFields() {
    const type = $("obs-entry-type").value;
    $("obs-rescue-fields").classList.toggle("hidden", type !== "rescue");
    $("obs-death-fields").classList.toggle("hidden", type !== "death");
    $("obs-daily-fields").classList.toggle("hidden", type !== "daily");
    if (type === "death" && !$("obs-death-date").value) $("obs-death-date").value = $("obs-date").value || today();
  }

  async function saveObservation(e) {
    e.preventDefault();
    if (!state.selectedCat || !canEdit()) return;
    const payload = {
      cat_id: state.selectedCat.id,
      observation_date: $("obs-date").value,
      entry_type: $("obs-entry-type").value,
      rescue_location: $("obs-rescue-location").value.trim(),
      rescue_details: $("obs-rescue-details").value.trim(),
      death_date: $("obs-death-date").value || null,
      death_cause: $("obs-death-cause").value.trim(),
      veterinary_hospital: $("obs-death-hospital").value.trim(),
      death_note: $("obs-death-note").value.trim(),
      observer_id: state.user.id,
      condition: $("obs-condition").value.trim(),
      appetite: $("obs-appetite").value.trim(),
      stool: $("obs-stool").value.trim(),
      urine: $("obs-urine").value.trim(),
      behavior: $("obs-behavior").value.trim(),
      weight_kg: $("obs-weight").value ? Number($("obs-weight").value) : null,
      temperature_c: $("obs-temperature").value ? Number($("obs-temperature").value) : null,
      memo: $("obs-memo").value.trim()
    };
    if (!payload.observation_date) return message("observation-message","記録日を入力してください。","error");
    if (payload.entry_type === "death" && !payload.death_date) return message("observation-message","死亡記録では死亡日を入力してください。","error");
    const { error } = await state.supabase.from("observations").insert(payload);
    if (error) return message("observation-message", error.message, "error");
    if (payload.entry_type === "death") {
      const statusUpdate = await state.supabase.from("cats").update({status: "deceased", updated_by: state.user.id}).eq("id", state.selectedCat.id);
      if (statusUpdate.error) return message("observation-message", "死亡記録は保存しましたが、猫の状態を死亡に変更できませんでした：" + statusUpdate.error.message, "error");
    }
    toast("観察日記を保存しました");
    await openCat(state.selectedCat.id);
  }


  // ---------------- Google Drive ----------------

  function driveConfigured() {
    return Boolean(window.CAT_DB_CONFIG?.googleClientId);
  }

  function setDriveMessage(text, type="") {
    const el = $("drive-message");
    if (el) {
      el.textContent = text;
      el.className = `message ${type}`;
    }
  }

  function loadStoredGoogleToken() {
    try {
      const raw = sessionStorage.getItem("catdb_google_drive_token");
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.access_token && saved?.expires_at && Date.now() < saved.expires_at - 30000) {
        state.googleToken = saved.access_token;
      } else {
        sessionStorage.removeItem("catdb_google_drive_token");
      }
    } catch (_) {}
  }

  function storeGoogleToken(response) {
    state.googleToken = response.access_token;
    try {
      sessionStorage.setItem("catdb_google_drive_token", JSON.stringify({
        access_token: response.access_token,
        expires_at: Date.now() + ((response.expires_in || 3600) * 1000)
      }));
    } catch (_) {}
  }

  function initGoogleDrive() {
    if (!driveConfigured()) return;
    loadStoredGoogleToken();
    if (!window.google?.accounts?.oauth2) {
      setTimeout(initGoogleDrive, 700);
      return;
    }
    state.googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: window.CAT_DB_CONFIG.googleClientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (response) => {
        if (response.error) {
          setDriveMessage(`Google接続エラー: ${response.error}`, "error");
          return;
        }
        storeGoogleToken(response);
        setDriveMessage("Google Driveに接続しました。", "success");
        const btn = $("google-connect-button");
        if (btn) btn.textContent = "Google Drive接続済み";
      }
    });
    if (state.googleToken) {
      const btn = $("google-connect-button");
      if (btn) btn.textContent = "Google Drive接続済み";
    }
  }

  function ensureGoogleToken() {
    return new Promise((resolve, reject) => {
      if (state.googleToken) return resolve(state.googleToken);
      if (!state.googleTokenClient) {
        initGoogleDrive();
        return reject(new Error("Google Driveに接続してください。"));
      }

      const client = state.googleTokenClient;
      const original = client.callback;
      client.callback = (response) => {
        client.callback = original;
        if (response.error) return reject(new Error(response.error));
        storeGoogleToken(response);
        resolve(response.access_token);
      };
      try {
        client.requestAccessToken({ prompt: "" });
      } catch (e) {
        client.callback = original;
        reject(e);
      }
    });
  }

  async function driveApi(path, options={}) {
    const token = await ensureGoogleToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(`https://www.googleapis.com/drive/v3/${path}`, {...options, headers});
  }

  async function getOrCreateDriveFolder(cat) {
    const folderName = `${cat.management_no}_${cat.name || "名前未登録"}`;
    const q = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const search = await driveApi(`files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name,webViewLink)`);
    if (!search.ok) throw new Error(`Driveフォルダ検索失敗: ${await search.text()}`);
    const found = await search.json();
    if (found.files?.length) return found.files[0];

    const create = await driveApi("files", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        name: folderName,
        mimeType:"application/vnd.google-apps.folder"
      })
    });
    if (!create.ok) throw new Error(`Driveフォルダ作成失敗: ${await create.text()}`);
    return await create.json();
  }

  async function uploadPhotoToDrive(file, cat) {
    if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選択してください。");
    const folder = await getOrCreateDriveFolder(cat);
    const metadata = {
      name: `${new Date().toISOString().replace(/[:.]/g,"-")}_${file.name}`,
      parents: [folder.id],
      description: `保護猫DB ${cat.management_no} ${cat.name || ""}`
    };
    const boundary = "catdb_" + crypto.randomUUID();
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata), "\r\n",
      `--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
      file, "\r\n",
      `--${boundary}--`
    ]);
    const token = await ensureGoogleToken();
    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents", {
      method:"POST",
      headers:{"Authorization": `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}`},
      body
    });
    if (!response.ok) throw new Error(`Driveアップロード失敗: ${await response.text()}`);
    return await response.json();
  }

  async function saveDriveMetadata(cat, driveFile, file, isMain) {
    const payload = {
      cat_id: cat.id,
      drive_file_id: driveFile.id,
      drive_folder_id: driveFile.parents?.[0] || "",
      file_name: driveFile.name || file.name,
      mime_type: driveFile.mimeType || file.type,
      file_url: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
      category: "photo",
      taken_at: today(),
      is_main_photo: Boolean(isMain),
      uploaded_by: state.user.id
    };

    if (isMain) {
      // DBの部分ユニークインデックスにより1枚だけ代表写真。
      // 既存代表写真を先に解除する。
      await state.supabase.from("cat_files")
        .update({is_main_photo:false})
        .eq("cat_id", cat.id)
        .eq("is_main_photo", true);
    }

    const {data, error} = await state.supabase.from("cat_files").insert(payload).select().single();
    if (error) throw error;

    if (isMain) {
      await state.supabase.from("cats")
        .update({main_photo_file_id:data.id, updated_by:state.user.id})
        .eq("id",cat.id);
    }
    return data;
  }

  async function uploadSelectedPhotos(files) {
    if (!state.selectedCat) return;
    try {
      await ensureGoogleToken();
      setDriveMessage(`${files.length}枚をアップロード中…`);
      for (let i=0; i<files.length; i++) {
        const driveFile = await uploadPhotoToDrive(files[i], state.selectedCat);
        // 最初の画像を代表写真にする
        await saveDriveMetadata(state.selectedCat, driveFile, files[i], i === 0 && state.selectedCat.files.length === 0);
      }
      toast("Google Driveへ写真を保存しました");
      await openCat(state.selectedCat.id);
      renderDriveFiles();
    } catch (e) {
      setDriveMessage(e.message || String(e), "error");
    }
  }

  async function renderDriveFiles() {
    const box = $("drive-files");
    if (!box || !state.selectedCat) return;
    const files = state.selectedCat.files || [];
    if (!files.length) { box.innerHTML = '<div class="muted">写真はまだありません。</div>'; return; }
    box.innerHTML = files.map(f => `
      <div class="file-card" data-drive-file-id="${esc(f.drive_file_id || "")}">
        <div class="photo-loading">📷</div>
        <small>${esc(f.file_name)}</small>
        ${isAdmin() ? `<button type="button" class="danger photo-delete-button" data-file-id="${esc(f.id)}">写真を削除</button>` : ""}
      </div>
    `).join("");
    box.querySelectorAll("[data-drive-file-id]").forEach(async card => {
      const id = card.dataset.driveFileId;
      if (!id) return;
      try {
        const url = await loadDriveImageUrl(id);
        const loading = card.querySelector(".photo-loading");
        if (loading) loading.outerHTML = `<img src="${esc(url)}" alt="${esc(card.querySelector("small")?.textContent || "写真")}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px">`;
      } catch (e) {
        console.warn(e);
        const loading = card.querySelector(".photo-loading");
        if (loading) loading.textContent = "写真を表示できません";
      }
    });
    box.querySelectorAll(".photo-delete-button").forEach(btn => {
      btn.addEventListener("click", () => deleteCatPhoto(btn.dataset.fileId));
    });
  }

  // ---------------- 保健所提出用PDF ----------------

  function buildHealthForm(cat, photoUrl = "") {
    const vaccine = latest(cat.vaccinations);
    const test = latest(cat.virusTests);
    const surgery = latest(cat.surgeries);
    const main = cat.files.find(f => f.is_main_photo) || cat.files[0];
    const photo = photoUrl
      ? `<img class="record-photo" src="${esc(photoUrl)}" alt="${esc(cat.name || "保護猫")}の写真">`
      : `<div class="record-photo record-photo-empty">写真未登録</div>`;
    const observationText = (cat.observations || []).slice().reverse().map(o => {
      const parts = [
        formatDate(o.observation_date),
        o.condition ? `体調：${o.condition}` : "",
        o.appetite ? `食欲：${o.appetite}` : "",
        o.stool ? `排便：${o.stool}` : "",
        o.urine ? `排尿：${o.urine}` : "",
        o.behavior ? `様子：${o.behavior}` : "",
        o.weight_kg ? `体重：${o.weight_kg}kg` : "",
        o.temperature_c ? `体温：${o.temperature_c}℃` : "",
        o.entry_type && o.entry_type !== "daily" ? `記録区分：${o.entry_type === "rescue" ? "保護時" : "死亡記録"}` : "",
        o.rescue_location ? `保護場所：${o.rescue_location}` : "",
        o.rescue_details ? `保護時の状況：${o.rescue_details}` : "",
        o.death_date ? `死亡日：${formatDate(o.death_date)}` : "",
        o.death_cause ? `死因：${o.death_cause}` : "",
        o.veterinary_hospital ? `動物病院：${o.veterinary_hospital}` : "",
        o.death_note ? `死亡時メモ：${o.death_note}` : "",
        o.memo || ""
      ].filter(Boolean);
      return parts.join(" / ");
    }).join("\n");
    const transfer = latest(cat.transfers);
    const diary = observationText;
    return `
      <section class="individual-record">
        <div class="record-left">
          <div class="record-profile">
            <div class="record-photo-wrap">${photo}</div>
            <div class="record-facts">
              <div class="record-title-row"><strong>保護猫</strong><span>管理番号</span><b>${esc(cat.management_no || "")}</b></div>
              <div class="record-field"><b>名前</b><span>${esc(cat.name || "")}</span></div>
              <div class="record-field"><b>性別</b><span>${esc(SEX_LABEL[cat.sex] || "不明")}</span></div>
              <div class="record-field"><b>保護日</b><span>${esc(formatDate(cat.rescued_date))}</span></div>
              <div class="record-field"><b>品種等</b><span>${esc(cat.breed || "")}</span></div>
              <div class="record-field"><b>保護時年齢・生まれ（推定）</b><span>${esc(cat.estimated_age_text || formatDate(cat.estimated_birth_date) || "")}</span></div>
              <div class="record-field"><b>ワクチン</b><span>${vaccine ? `${esc(vaccine.vaccine_type || "接種済")} ${esc(formatDate(vaccine.vaccination_date))}` : ""}</span></div>
              <div class="record-field"><b>不妊去勢手術日</b><span>${surgery ? esc(formatDate(surgery.surgery_date)) : ""}</span></div>
              <div class="record-field"><b>ウイルス検査日</b><span>${test ? esc(formatDate(test.test_date)) : ""}</span></div>
              <div class="record-field"><b>FIV</b><span>${test ? esc(TEST_LABEL[test.fiv_result] || "") : ""}</span></div>
              <div class="record-field"><b>FeLV</b><span>${test ? esc(TEST_LABEL[test.felv_result] || "") : ""}</span></div>
            </div>
          </div>
          <div class="record-diary-title">保護した時の状況・体調など　観察日記</div>
          <div class="record-diary">${esc(diary)}</div>
        </div>
        <div class="record-right">
          <div class="record-adoption">
            <div class="record-adoption-title">譲渡日　　　　　　　　　　　譲渡先</div>
            <div class="record-adoption-content">
              <div><b>譲渡日</b><span>${transfer ? esc(formatDate(transfer.transfer_date)) : ""}</span></div>
              <div><b>譲渡先</b><span>${transfer ? esc(transfer.recipient_name || "") : ""}</span></div>
            </div>
          </div>
          <div class="record-continuation-title">観察日記の続き（左下から続けて記入）</div>
          <div class="record-continuation"></div>
          <div class="record-bottom-number">管理番号：${esc(cat.management_no || "")}</div>
        </div>
      </section>
    `;
  }

  async function printHealthForm() {
    if (!state.selectedCat) return;
    const cat = state.selectedCat;
    // Open the print window immediately from the click gesture. Keep the live PWA
    // DOM untouched so Chromium cannot fall back to printing the normal screen.
    const printWindow = window.open("about:blank", "_blank");
    if (!printWindow) {
      alert("印刷用ウィンドウが開けませんでした。ブラウザでポップアップを許可して、もう一度お試しください。");
      return;
    }
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>個体情報記録票</title><link rel="stylesheet" href="${new URL("styles.css", location.href).href}"><style>html,body{margin:0;padding:0;background:#fff!important}body{width:100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}.health-actions{display:none!important}@page{size:A4 landscape;margin:8mm}@media print{html,body{width:281mm!important;height:194mm!important;margin:0!important;padding:0!important}.individual-record{width:281mm!important;height:194mm!important;margin:0!important;break-inside:avoid;page-break-inside:avoid}}</style></head><body><p style="font:14px sans-serif;padding:16px">帳票を準備しています…</p></body></html>`);
    printWindow.document.close();

    let photoUrl = "";
    const main = cat.files.find(f => f.is_main_photo) || cat.files[0];
    if (main?.drive_file_id) {
      try { photoUrl = await loadDriveImageUrl(main.drive_file_id); }
      catch (e) { console.warn("帳票写真を読み込めませんでした", e); }
    } else if (main?.file_url) {
      photoUrl = main.file_url;
    }

    const form = buildHealthForm(cat, photoUrl);
    printWindow.document.body.innerHTML = form;
    const img = printWindow.document.querySelector(".record-photo[src]");
    if (img && !img.complete) {
      await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
    }
    // Wait for the stylesheet and layout to settle before printing.
    await new Promise(resolve => {
      if (printWindow.document.readyState === "complete") resolve();
      else printWindow.addEventListener("load", resolve, { once: true });
    });
    await new Promise(resolve => printWindow.requestAnimationFrame(() => printWindow.requestAnimationFrame(resolve)));
    printWindow.focus();
    printWindow.print();
  }

  function setupEvents() {
    $("config-form").addEventListener("submit", async e => {
      e.preventDefault();
      cfg.supabaseUrl = $("config-url").value.trim();
      cfg.supabaseAnonKey = $("config-key").value.trim();
      saveConfig(cfg.supabaseUrl, cfg.supabaseAnonKey);
      try {
        if (!await initSupabase()) return;
        await loadSession();
        message("config-message","接続しました。","success");
      } catch (err) {
        message("config-message", err.message || String(err), "error");
      }
    });

    $("login-form").addEventListener("submit", async e => {
      e.preventDefault();
      message("login-message","ログイン中…");
      const { data, error } = await state.supabase.auth.signInWithPassword({
        email: $("login-email").value.trim(),
        password: $("login-password").value
      });
      if (error) return message("login-message", error.message, "error");
      state.user = data.user;
      await loadProfile();
      show("app-view");
      $("user-label").textContent = `${state.profile?.display_name || state.user.email} / ${state.profile?.role}`;
      await loadCats();
    });

    $("new-cat-button").addEventListener("click", () => { if (canEdit()) openCatForm(); });
    $("refresh-button").addEventListener("click", () => loadCats().catch(err => toast(err.message)));
    $("logout-button").addEventListener("click", async () => {
      await state.supabase.auth.signOut();
      state.user = null; state.profile = null; state.cats = [];
      show("login-view");
    });
    $("search-input").addEventListener("input", renderCatList);
    $("status-filter").addEventListener("change", renderCatList);
    $("back-button").addEventListener("click", () => panel("list-panel"));
    $("edit-cat-button").addEventListener("click", () => { if (canEdit()) openCatForm(state.selectedCat); });
    $("cancel-cat-button").addEventListener("click", () => panel("detail-panel"));
    $("cancel-cat-button-2").addEventListener("click", () => panel("detail-panel"));
    $("cat-form").addEventListener("submit", saveCat);
    $("cat-status").addEventListener("change", () => {
  
    });
    $("back-to-detail-button").addEventListener("click", () => panel("detail-panel"));
    $("cancel-observation-button").addEventListener("click", () => panel("detail-panel"));
    $("observation-form").addEventListener("submit", saveObservation);
    $("obs-entry-type").addEventListener("change", updateObservationTypeFields);
    $("print-button").addEventListener("click", printHealthForm);
    $("google-connect-button").addEventListener("click", async () => {
      try {
        await ensureGoogleToken();
        setDriveMessage("Google Driveに接続しました。", "success");
      } catch (e) { setDriveMessage(e.message || String(e), "error"); }
    });
    $("photo-input").addEventListener("change", e => {
      const files = [...e.target.files];
      if (files.length) uploadSelectedPhotos(files);
      e.target.value = "";
    });
  }

  function setupInstall() {
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      state.deferredInstall = e;
      $("install-button").classList.remove("hidden");
    });
    $("install-button").addEventListener("click", async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      $("install-button").classList.add("hidden");
    });
  }

  async function init() {
    setupEvents();
    setupInstall();
    initGoogleDrive();

    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js"); } catch (_) {}
    }

    try {
      const ok = await initSupabase();
      if (ok) await loadSession();
    } catch (err) {
      show("login-view");
      message("login-message", err.message || String(err), "error");
    }
  }

  init();
})();
