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
    editingObservationId: null,
    editingTransferId: null,
    editingMedicalId: null,
    editingMedicalType: null,
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
    ["list-panel","detail-panel","cat-form-panel","observation-panel","staff-management-panel"].forEach(id => $(id).classList.add("hidden"));
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
    const staffButton = $("staff-management-button");
    if (staffButton) staffButton.classList.toggle("hidden", !isAdmin());
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
    if (!cat || !canEdit()) return toast("写真の削除はスタッフ・管理者のみ実行できます。");
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
      <article class="cat-card open-cat" data-id="${esc(cat.id)}" role="button" tabindex="0" aria-label="${esc(cat.name || "名前未登録")}の詳細を開く">
        <div class="cat-thumb" aria-hidden="true">🐱</div>
        <div>
          <div class="cat-name">${esc(cat.name || "名前未登録")}</div>
          <div class="cat-meta">${esc(cat.management_no)} ・ ${esc(SEX_LABEL[cat.sex] || "不明")} ・ ${esc(cat.breed || "品種未登録")}</div>
          <div class="cat-meta">保護日 ${esc(formatDate(cat.rescued_date))}</div>
        </div>
      </article>
    `).join("");
    list.querySelectorAll(".open-cat").forEach(card => {
      card.addEventListener("click", () => openCat(card.dataset.id));
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCat(card.dataset.id);
        }
      });
    });
  }

  async function openCat(id) {
    const { data, error } = await state.supabase
      .from("cats")
      .select("*")
      .eq("id", id)
      .single();
    if (error) return toast(error.message);

    const [observations, files] = await Promise.all([
      state.supabase.from("observations").select("*").eq("cat_id", id).order("observation_date", {ascending:false}).order("created_at", {ascending:false}),
      state.supabase.from("cat_files").select("*").eq("cat_id", id).order("is_main_photo", {ascending:false}).order("taken_at", {ascending:false})
    ]);

    state.selectedCat = {
      ...data,
      vaccinations: [], virusTests: [], surgeries: [],
      observations: observations.data || [],
      transfers: [],
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
    const vaccine = c;
    const test = c;
    const surgery = c;
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
            <div class="key">ワクチン</div><div>${vaccine.vaccine_type ? `${esc(vaccine.vaccine_type)} / ${esc(formatDate(vaccine.vaccination_date))}` : "—"}</div>
            <div class="key">FIV</div><div>${esc(TEST_LABEL[test.fiv_result] || "—")}${test.virus_test_date ? `（${esc(formatDate(test.virus_test_date))}）` : ""}</div>
            <div class="key">FeLV</div><div>${esc(TEST_LABEL[test.felv_result] || "—")}</div>
            <div class="key">不妊去勢手術日</div><div>${surgery.surgery_date ? esc(formatDate(surgery.surgery_date)) : "—"}</div>
            <div class="key">譲渡日</div><div>${c.transfer_date ? esc(formatDate(c.transfer_date)) : "—"}</div>
            <div class="key">譲渡先</div><div>${esc(c.transfer_recipient || "—")}</div>
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
            ${canEdit() ? `<div class="record-actions"><button type="button" class="secondary edit-observation-button" data-id="${esc(o.id)}">編集</button>${canEdit() ? `<button type="button" class="danger delete-observation-button" data-id="${esc(o.id)}">削除</button>` : ""}</div>` : ""}
          </div>
        `).join("") : '<div class="empty">観察日記はまだありません。</div>'}
      </div>

      <!-- 医療情報は上部の基本情報一覧に表示済みのため、ここでは重複表示しない。 -->

      <!-- 写真一覧は画面下部の drive-files に一本化。ここで重複表示しない。 -->

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
    if (add) add.addEventListener("click", () => openObservationForm());
    document.querySelectorAll(".edit-observation-button").forEach(btn => btn.addEventListener("click", () => {
      const record = state.selectedCat?.observations.find(o => String(o.id) === btn.dataset.id);
      if (record) openObservationForm(record);
    }));
    document.querySelectorAll(".delete-observation-button").forEach(btn => btn.addEventListener("click", () => deleteObservation(btn.dataset.id)));
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
    $("cat-vaccine-date").value = cat?.vaccination_date || "";
    $("cat-vaccine-type").value = cat?.vaccine_type || "";
    $("cat-virus-date").value = cat?.virus_test_date || "";
    $("cat-fiv-result").value = cat?.fiv_result || "unknown";
    $("cat-felv-result").value = cat?.felv_result || "unknown";
    $("cat-surgery-date").value = cat?.surgery_date || "";
    $("cat-medical-hospital").value = cat?.medical_hospital || "";
    $("cat-medical-note").value = cat?.medical_note || "";
    $("cat-transfer-date").value = cat?.transfer_date || "";
    $("cat-transfer-recipient").value = cat?.transfer_recipient || "";
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
      vaccination_date: $("cat-vaccine-date").value || null,
      vaccine_type: $("cat-vaccine-type").value.trim(),
      virus_test_date: $("cat-virus-date").value || null,
      fiv_result: $("cat-fiv-result").value,
      felv_result: $("cat-felv-result").value,
      surgery_date: $("cat-surgery-date").value || null,
      medical_hospital: $("cat-medical-hospital").value.trim(),
      medical_note: $("cat-medical-note").value.trim(),
      transfer_date: $("cat-transfer-date").value || null,
      transfer_recipient: $("cat-transfer-recipient").value.trim(),
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

  function openObservationForm(observation=null) {
    if (!state.selectedCat || !canEdit()) return;
    state.editingObservationId = observation?.id || null;
    const formTitle = document.querySelector("#observation-panel .detail-head h2");
    if (formTitle) formTitle.textContent = observation ? "観察日記を編集" : "観察日記を追加";
    $("obs-date").value = observation?.observation_date || today();
    $("obs-entry-type").value = observation?.entry_type || "daily";
    $("obs-condition").value = observation?.condition || "";
    $("obs-appetite").value = observation?.appetite || "";
    $("obs-stool").value = observation?.stool || "";
    $("obs-urine").value = observation?.urine || "";
    $("obs-behavior").value = observation?.behavior || "";
    $("obs-weight").value = observation?.weight_kg ?? "";
    $("obs-temperature").value = observation?.temperature_c ?? "";
    $("obs-memo").value = observation?.memo || "";
    $("obs-rescue-location").value = observation?.rescue_location || "";
    $("obs-rescue-details").value = observation?.rescue_details || "";
    $("obs-death-date").value = observation?.death_date || "";
    $("obs-death-cause").value = observation?.death_cause || "";
    $("obs-death-hospital").value = observation?.veterinary_hospital || "";
    $("obs-death-note").value = observation?.death_note || "";
    const saveButton = document.querySelector('#observation-form button[type="submit"]');
    if (saveButton) saveButton.textContent = observation ? "観察日記を更新" : "観察日記を保存";
    message("observation-message", "");
    updateObservationTypeFields();
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
    if (!payload.observation_date) return message("observation-message", "記録日を入力してください。", "error");
    if (payload.entry_type === "death" && !payload.death_date) return message("observation-message", "死亡記録では死亡日を入力してください。", "error");
    let result;
    if (state.editingObservationId) {
      result = await state.supabase.from("observations").update(payload).eq("id", state.editingObservationId).eq("cat_id", state.selectedCat.id);
    } else {
      result = await state.supabase.from("observations").insert(payload);
    }
    if (result.error) return message("observation-message", result.error.message, "error");
    if (payload.entry_type === "death") {
      const statusUpdate = await state.supabase.from("cats").update({status: "deceased", updated_by: state.user.id}).eq("id", state.selectedCat.id);
      if (statusUpdate.error) return message("observation-message", "観察日記は保存しましたが、猫の状態を死亡に変更できませんでした：" + statusUpdate.error.message, "error");
    }
    state.editingObservationId = null;
    toast(payload.entry_type === "death" ? "観察日記を保存しました" : "観察日記を保存しました");
    await openCat(state.selectedCat.id);
  }

  async function deleteObservation(id) {
    if (!state.selectedCat || !canEdit()) return toast("観察日記の削除はスタッフまたは管理者のみ実行できます。");
    const record = state.selectedCat.observations.find(o => String(o.id) === String(id));
    if (!record || !window.confirm(`${formatDate(record.observation_date)} の観察日記を削除しますか？この操作は元に戻せません。`)) return;
    const { error } = await state.supabase.from("observations").delete().eq("id", id).eq("cat_id", state.selectedCat.id);
    if (error) return toast("削除できませんでした：" + error.message);
    toast("観察日記を削除しました");
    await openCat(state.selectedCat.id);
  }

  function updateMedicalFormFields() {
    const type = $("medical-type")?.value || "vaccination";
    const nameLabel = $("medical-name-label");
    const fivLabel = $("medical-fiv-label");
    const felvLabel = $("medical-felv-label");
    if (nameLabel) {
      nameLabel.classList.toggle("hidden", type === "virus_test");
      nameLabel.querySelector("input").previousSibling.textContent = type === "surgery" ? "手術名" : "ワクチン名";
    }
    if (fivLabel) fivLabel.classList.toggle("hidden", type !== "virus_test");
    if (felvLabel) felvLabel.classList.toggle("hidden", type !== "virus_test");
    const title = $("medical-form-title");
    if (title) title.textContent = type === "vaccination" ? "ワクチン履歴" : type === "virus_test" ? "ウイルス検査履歴" : "手術履歴";
  }

  function openMedicalForm(type, record=null) {
    if (!state.selectedCat || !canEdit()) return;
    const form = $("medical-form");
    if (!form) return;
    state.editingMedicalType = type;
    state.editingMedicalId = record?.id || null;
    $("medical-id").value = record?.id || "";
    $("medical-type").value = type;
    $("medical-date").value = record?.vaccination_date || record?.test_date || record?.surgery_date || today();
    $("medical-name").value = record?.vaccine_type || record?.surgery_type || "";
    $("medical-fiv").value = record?.fiv_result || "unknown";
    $("medical-felv").value = record?.felv_result || "unknown";
    $("medical-hospital").value = record?.veterinary_hospital || "";
    $("medical-note").value = record?.note || "";
    $("medical-save-button").textContent = record ? "医療履歴を更新" : "医療履歴を保存";
    message("medical-message", "");
    updateMedicalFormFields();
    form.classList.remove("hidden");
    form.scrollIntoView({behavior:"smooth", block:"nearest"});
  }

  function resetMedicalForm() {
    const form = $("medical-form");
    if (!form) return;
    state.editingMedicalType = null;
    state.editingMedicalId = null;
    form.reset();
    $("medical-type").value = "vaccination";
    $("medical-date").value = today();
    $("medical-fiv").value = "unknown";
    $("medical-felv").value = "unknown";
    $("medical-save-button").textContent = "医療履歴を保存";
    form.classList.add("hidden");
    message("medical-message", "");
  }

  async function saveMedicalRecord(e) {
    e.preventDefault();
    if (!state.selectedCat || !canEdit()) return;
    const type = state.editingMedicalType || $("medical-type").value;
    const date = $("medical-date").value;
    if (!date) return message("medical-message", "実施日を入力してください。", "error");
    let table, dateColumn, payload;
    if (type === "vaccination") {
      table = "vaccinations"; dateColumn = "vaccination_date";
      payload = {cat_id:state.selectedCat.id, vaccination_date:date, vaccine_type:$("medical-name").value.trim(), veterinary_hospital:$("medical-hospital").value.trim(), note:$("medical-note").value.trim()};
      if (!payload.vaccine_type) return message("medical-message", "ワクチン名を入力してください。", "error");
    } else if (type === "virus_test") {
      table = "virus_tests"; dateColumn = "test_date";
      payload = {cat_id:state.selectedCat.id, test_date:date, fiv_result:$("medical-fiv").value, felv_result:$("medical-felv").value, veterinary_hospital:$("medical-hospital").value.trim(), note:$("medical-note").value.trim()};
    } else {
      table = "surgeries"; dateColumn = "surgery_date";
      payload = {cat_id:state.selectedCat.id, surgery_date:date, surgery_type:$("medical-name").value.trim(), veterinary_hospital:$("medical-hospital").value.trim(), note:$("medical-note").value.trim()};
      if (!payload.surgery_type) return message("medical-message", "手術名を入力してください。", "error");
    }
    const result = state.editingMedicalId
      ? await state.supabase.from(table).update(payload).eq("id", state.editingMedicalId).eq("cat_id", state.selectedCat.id)
      : await state.supabase.from(table).insert(payload);
    if (result.error) return message("medical-message", result.error.message, "error");
    const catId = state.selectedCat.id;
    resetMedicalForm();
    toast("医療履歴を保存しました");
    await openCat(catId);
  }

  function resetTransferForm() {
    if (!$("transfer-form")) return;
    state.editingTransferId = null;
    $("transfer-id").value = "";
    $("transfer-date").value = today();
    $("transfer-recipient").value = "";
    $("transfer-save-button").textContent = "譲渡情報を保存";
    $("transfer-cancel-edit").classList.add("hidden");
    message("transfer-message", "");
  }

  function editTransferForm(record) {
    state.editingTransferId = record.id;
    $("transfer-id").value = record.id;
    $("transfer-date").value = record.transfer_date || "";
    $("transfer-recipient").value = record.recipient_name || "";
    $("transfer-save-button").textContent = "譲渡情報を更新";
    $("transfer-cancel-edit").classList.remove("hidden");
    message("transfer-message", "");
    $("transfer-form").scrollIntoView({behavior:"smooth", block:"nearest"});
  }

  async function saveTransfer(e) {
    e.preventDefault();
    if (!state.selectedCat || !canEdit()) return;
    const payload = {
      cat_id: state.selectedCat.id,
      transfer_date: $("transfer-date").value,
      recipient_name: $("transfer-recipient").value.trim()
    };
    if (!payload.transfer_date) return message("transfer-message", "譲渡日を入力してください。", "error");
    const result = state.editingTransferId
      ? await state.supabase.from("transfers").update(payload).eq("id", state.editingTransferId).eq("cat_id", state.selectedCat.id)
      : await state.supabase.from("transfers").insert(payload);
    if (result.error) return message("transfer-message", result.error.message, "error");
    resetTransferForm();
    toast("譲渡情報を保存しました");
    await openCat(state.selectedCat.id);
  }

  async function deleteTransfer(id) {
    if (!state.selectedCat || !isAdmin()) return toast("譲渡情報の削除は管理者のみ実行できます。");
    const record = state.selectedCat.transfers.find(t => String(t.id) === String(id));
    if (!record || !window.confirm(`${formatDate(record.transfer_date)} の譲渡情報を削除しますか？この操作は元に戻せません。`)) return;
    const { error } = await state.supabase.from("transfers").delete().eq("id", id).eq("cat_id", state.selectedCat.id);
    if (error) return toast("削除できませんでした：" + error.message);
    toast("譲渡情報を削除しました");
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
        ${canEdit() ? `<button type="button" class="danger photo-delete-button" data-file-id="${esc(f.id)}">写真を削除</button>` : ""}
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
    const vaccine = cat, test = cat, surgery = cat;
    const main = cat.files.find(f => f.is_main_photo) || cat.files[0];
    const photo = photoUrl
      ? `<img class="record-photo" src="${esc(photoUrl)}" alt="${esc(cat.name || "保護猫")}の写真">`
      : `<div class="record-photo record-photo-empty">写真未登録</div>`;
    const diaryRows = (cat.observations || []).slice().reverse().map(o => {
      const parts = [
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
      return `<div class="record-diary-row"><div class="record-diary-date">${esc(formatDate(o.observation_date))}</div><div class="record-diary-content">${esc(parts.join(" / "))}</div></div>`;
    }).join("");
    const transfer = { transfer_date: cat.transfer_date, recipient_name: cat.transfer_recipient };
    const diary = `<div class="record-diary-empty" aria-hidden="true"></div>${diaryRows}`;
    return `
      <section class="individual-record">
        <div class="record-left">
          <div class="record-profile">
            <div class="record-photo-wrap">
              <div class="record-photo-title">保護猫</div>
              <div class="record-photo-frame">${photo}</div>
            </div>
            <div class="record-facts">
              <div class="record-field record-management"><b>管理番号</b><span>${esc(cat.management_no || "")}</span></div>
              <div class="record-field"><b>名前</b><span>${esc(cat.name || "")}</span></div>
              <div class="record-field"><b>性別</b><span>${esc(SEX_LABEL[cat.sex] || "不明")}</span></div>
              <div class="record-field"><b>保護日</b><span>${esc(formatDate(cat.rescued_date))}</span></div>
              <div class="record-field"><b>品種等</b><span>${esc(cat.breed || "")}</span></div>
              <div class="record-field record-age"><b>保護時年齢・生まれ（推定）</b><span>${esc(cat.estimated_age_text || formatDate(cat.estimated_birth_date) || "")}</span></div>
              <div class="record-field"><b>ワクチン</b><span>${vaccine.vaccine_type ? `${esc(vaccine.vaccine_type || "接種済")} ${esc(formatDate(vaccine.vaccination_date))}` : ""}</span></div>
              <div class="record-field"><b>不妊去勢手術日</b><span>${surgery.surgery_date ? esc(formatDate(surgery.surgery_date)) : ""}</span></div>
              <div class="record-field"><b>ウイルス検査日</b><span>${test.virus_test_date ? esc(formatDate(test.virus_test_date)) : ""}</span></div>
              <div class="record-field"><b>FIV</b><span class="record-virus-options"><span class="${test.fiv_result === "positive" ? "virus-selected" : ""}">＋</span><span class="${test.fiv_result === "negative" ? "virus-selected" : ""}">−</span></span></div>
              <div class="record-field"><b>FeLV</b><span class="record-virus-options"><span class="${test.felv_result === "positive" ? "virus-selected" : ""}">＋</span><span class="${test.felv_result === "negative" ? "virus-selected" : ""}">−</span></span></div>
            </div>
          </div>
          <div class="record-diary-title">保護した時の状況・体調など　観察日記</div>
          <div class="record-diary">${diary}</div>
          <div class="record-death">（死亡した場合は死亡日、原因）</div>
        </div>
        <div class="record-right">
          <div class="record-adoption">
            <div class="record-adoption-content">
              <div class="record-transfer-date"><b>譲渡日</b><span>${transfer ? esc(formatDate(transfer.transfer_date)) : ""}</span></div>
              <div class="record-transfer-recipient"><b>譲渡先</b><span>${transfer ? esc(transfer.recipient_name || "") : ""}</span></div>
            </div>
          </div>
          <div class="record-continuation" aria-label="観察日記の記入欄"><div class="record-continuation-lines" aria-hidden="true"></div></div>
          <div class="record-bottom-number">${esc(cat.management_no || "")}</div>
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
    printWindow.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>個体情報記録票</title><link rel="stylesheet" href="${new URL("styles.css", location.href).href}"><style>html,body{margin:0;padding:0;background:#fff!important}body{width:100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}.health-actions{display:none!important}@page{size:A4 landscape;margin:25mm 8mm 10mm}@media print{html,body{width:281mm!important;height:175mm!important;margin:0!important;padding:0!important}.individual-record{width:281mm!important;height:175mm!important;margin:0!important;break-inside:avoid;page-break-inside:avoid}}</style></head><body><p style="font:14px sans-serif;padding:16px">帳票を準備しています…</p></body></html>`);
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

    // Move whole diary rows that do not fit in the left diary area into the
    // continuation area below the adoption/rescue record on the right.
    // If there is no overflow, leave that area empty (no decorative blank lines).
    const diary = printWindow.document.querySelector(".record-diary");
    const continuation = printWindow.document.querySelector(".record-continuation");
    if (diary && continuation) {
      const rows = Array.from(diary.querySelectorAll(".record-diary-row"));
      const available = diary.clientHeight;
      let used = 0;
      for (const row of rows) {
        const rowHeight = row.getBoundingClientRect().height;
        if (used + rowHeight <= available + 1) {
          used += rowHeight;
        } else {
          continuation.insertBefore(row, continuation.querySelector(".record-continuation-lines"));
        }
      }
      if (continuation.querySelector(".record-diary-row")) {
        continuation.classList.add("has-diary-continuation");
      }
    }
    await new Promise(resolve => printWindow.requestAnimationFrame(() => printWindow.requestAnimationFrame(resolve)));
    printWindow.focus();
    printWindow.print();
  }

async function testCatPhotoProxy() {
  const { data, error } =
    await state.supabase.functions.invoke(
      "cat-photo-proxy",
      { body: {} }
    );

  if (error) {
    let detail = error.message || "呼び出しに失敗しました。";
    try {
      const context = error.context;
      if (context?.json) {
        const body = await context.json();
        if (body?.error) detail = body.error;
      }
    } catch (_) {}
    throw new Error(detail);
  }

  if (data?.error) throw new Error(data.error);

  console.log("cat-photo-proxy テスト結果:", data);
  return data;
}

  async function callStaffAdmin(payload) {
    if (!isAdmin()) throw new Error("スタッフ管理は管理者のみ利用できます。");
    const { data, error } = await state.supabase.functions.invoke("cat-user-admin", { body: payload });
    if (error) {
      let detail = error.message || "Edge Functionの呼び出しに失敗しました。";
      try { const context = error.context; if (context?.json) { const body = await context.json(); if (body?.error) detail = body.error; } } catch (_) {}
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function testCatPhotoProxy() {
    if (!state.supabase) {
      throw new Error("Supabaseが初期化されていません。");
    }
  
    const { data, error } =
      await state.supabase.functions.invoke(
        "cat-photo-proxy",
        { body: {} }
      );
  
    if (error) {
      console.error("cat-photo-proxy 呼び出しエラー:", error);
      throw new Error(
        error.message || "写真プロキシの呼び出しに失敗しました。"
      );
    }
  
    console.log("cat-photo-proxy テスト結果:", data);
    return data;
  }

  function openStaffManagement() {
    if (!isAdmin()) return toast("スタッフ管理は管理者のみ利用できます。");
    panel("staff-management-panel");
    $("page-title").textContent = "スタッフ管理";
    loadStaffList().catch(e => message("staff-list-message", e.message || String(e), "error"));
  }

  async function loadStaffList() {
    if (!isAdmin()) return;
    const list = $("staff-list");
    list.innerHTML = '<p class="muted">読み込み中…</p>';
    message("staff-list-message", "");
    const result = await callStaffAdmin({ action: "list" });
    const users = result.users || [];
    if (!users.length) { list.innerHTML = '<p class="muted">ユーザーがいません。</p>'; return; }
    list.innerHTML = users.map(u => `
      <article class="staff-item">
        <div class="staff-item-info"><strong>${esc(u.display_name || "名前未設定")}</strong><div>${esc(u.email || "メール未登録")}</div><small>権限：${u.role === "admin" ? "管理者" : u.role === "staff" ? "スタッフ" : "閲覧者"} ／ ${u.active ? "利用中" : "停止中"}</small></div>
        <div class="staff-item-actions">
          ${u.id === state.user.id ? '<span class="muted">ログイン中</span>' : `
            <label class="staff-inline-label">権限<select data-staff-role="${esc(u.id)}" ${u.role === "admin" ? "disabled" : ""}><option value="staff" ${u.role === "staff" ? "selected" : ""}>スタッフ</option><option value="viewer" ${u.role === "viewer" ? "selected" : ""}>閲覧者</option></select></label>
            <button type="button" class="secondary" data-staff-save="${esc(u.id)}" ${u.role === "admin" ? "disabled" : ""}>変更</button>
            <button type="button" class="${u.active ? "danger" : "secondary"}" data-staff-active="${esc(u.id)}" data-active="${u.active ? "true" : "false"}" ${u.role === "admin" ? "disabled" : ""}>${u.active ? "利用停止" : "利用再開"}</button>`}
        </div>
      </article>`).join("");
    list.querySelectorAll("[data-staff-save]").forEach(btn => btn.addEventListener("click", async () => {
      const id = btn.dataset.staffSave;
      const select = list.querySelector(`[data-staff-role="${CSS.escape(id)}"]`);
      if (!select) return;
      btn.disabled = true;
      try { await callStaffAdmin({ action: "update", user_id: id, role: select.value }); toast("権限を変更しました。"); await loadStaffList(); }
      catch (e) { message("staff-list-message", e.message || String(e), "error"); btn.disabled = false; }
    }));
    list.querySelectorAll("[data-staff-active]").forEach(btn => btn.addEventListener("click", async () => {
      const id = btn.dataset.staffActive, currentlyActive = btn.dataset.active === "true";
      if (!window.confirm(currentlyActive ? "このユーザーを利用停止にしますか？次回からログイン後に利用できなくなります。" : "このユーザーの利用を再開しますか？")) return;
      btn.disabled = true;
      try { await callStaffAdmin({ action: "update", user_id: id, active: !currentlyActive }); toast(currentlyActive ? "利用停止にしました。" : "利用を再開しました。"); await loadStaffList(); }
      catch (e) { message("staff-list-message", e.message || String(e), "error"); btn.disabled = false; }
    }));
  }

  async function createStaffAccount(e) {
    e.preventDefault();
    const out = $("staff-create-message");
    message("staff-create-message", "アカウントを作成しています…");
    const display_name = $("staff-display-name").value.trim();
    const email = $("staff-email").value.trim();
    const password = $("staff-password").value;
    const role = $("staff-role").value;
    if (password.length < 10) return message("staff-create-message", "初期パスワードは10文字以上にしてください。", "error");
    try {
      await callStaffAdmin({ action: "create", display_name, email, password, role });
      $("staff-create-form").reset();
      message("staff-create-message", "アカウントを作成しました。本人へログイン情報を安全な方法で伝えてください。", "success");
      await loadStaffList();
    } catch (e) {
      message("staff-create-message", e.message || String(e), "error");
    }
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
    $("staff-management-button").addEventListener("click", openStaffManagement);
    $("staff-back-button").addEventListener("click", () => { panel("list-panel"); $("page-title").textContent = "猫一覧"; });
    $("staff-refresh-button").addEventListener("click", () => loadStaffList().catch(e => message("staff-list-message", e.message || String(e), "error")));
    $("cat-photo-proxy-test-button").addEventListener("click", async () => {
      const button = $("cat-photo-proxy-test-button");
      button.disabled = true;
    
      try {
        const data = await testCatPhotoProxy();
        message(
          "cat-photo-proxy-test-message",
          `認証テスト成功：${data?.message || "応答を受信しました"}`,
          "success"
        );
      } catch (e) {
        message(
          "cat-photo-proxy-test-message",
          e.message || String(e),
          "error"
        );
      } finally {
        button.disabled = false;
      }
    });
    
    $("google-drive-connect-button").addEventListener("click", async () => {
      const button = $("google-drive-connect-button");
      button.disabled = true;
    
      try {
        if (!isAdmin()) {
          throw new Error("管理者のみGoogle Driveを接続できます。");
        }
    
        const { data, error } = await state.supabase.functions.invoke(
          "google-drive-oauth-start",
          { body: {} }
        );
    
        if (error) {
          let detail = error.message || "接続開始に失敗しました。";
          try {
            if (error.context?.json) {
              const body = await error.context.json();
              if (body?.error) detail = body.error;
            }
          } catch (_) {}
          throw new Error(detail);
        }
    
        if (!data?.authorization_url) {
          throw new Error(data?.error || "Googleの認証URLを取得できませんでした。");
        }
    
        const authUrl = new URL(data.authorization_url);
        if (
          authUrl.protocol !== "https:" ||
          authUrl.hostname !== "accounts.google.com"
        ) {
          throw new Error("認証URLが正しくありません。");
        }
    
        message(
          "google-drive-connect-message",
          "Googleの認証画面を開きます。",
          "success"
        );
    
        window.location.assign(authUrl.href);
      } catch (e) {
        message(
          "google-drive-connect-message",
          e.message || String(e),
          "error"
        );
        button.disabled = false;
      }
    });

    $("staff-create-form").addEventListener("submit", createStaffAccount);
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
