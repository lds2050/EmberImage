(function bootstrapEmberImage() {
  "use strict";

  const api = window.imageStudio;
  const Validation = window.ImageStudioValidation;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const state = {
    config: { activeConnectionId: "", connections: [] },
    editingConnectionId: null,
    draftNew: false,
    keyStorage: "session",
    streamEnabled: false,
    sizeSelection: { mode: "ratio", ratio: "1:1", resolution: "1k", width: 1024, height: 1024 },
    sizeDialogDraft: null,
    history: [],
    logs: [],
    currentTaskId: null,
    elapsedTimer: null,
    generationStartedAt: 0,
    isGenerating: false,
    lastEntry: null,
    favoriteOnly: false,
  };

  function unwrap(result) {
    if (result?.ok) return result.data;
    const error = new Error(result?.error?.message || "操作未完成");
    Object.assign(error, result?.error || {});
    throw error;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toast(message, type = "success") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("#toast-region").append(node);
    window.setTimeout(() => node.remove(), 3200);
  }

  function applyWindowScale() {
    const designWidth = 1480;
    const designHeight = 960;
    const scale = Math.min(window.innerWidth / designWidth, window.innerHeight / designHeight);
    document.body.style.width = `${designWidth}px`;
    document.body.style.height = `${designHeight}px`;
    document.body.style.transform = `scale(${scale})`;
    document.body.style.transformOrigin = "0 0";
  }

  function navigate(viewName) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === viewName));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.viewTarget === viewName));
    if (viewName === "history") loadHistory();
    if (viewName === "settings") loadLogs();
  }

  function activeProfile() {
    return state.config.connections.find((item) => item.id === state.config.activeConnectionId) || state.config.connections[0] || null;
  }

  function editingProfile() {
    return state.config.connections.find((item) => item.id === state.editingConnectionId) || null;
  }

  function hostOf(baseUrl) {
    try { return new URL(baseUrl).host; }
    catch { return baseUrl || "未填写地址"; }
  }

  function updateConnectionStatus() {
    const profile = activeProfile();
    const dot = $("#connection-dot");
    dot.className = "connection-dot";
    if (!profile) {
      $("#connection-label").textContent = "尚未配置";
      $("#connection-host").textContent = "请添加连接";
    } else if (profile.isUnlocked) {
      dot.classList.add("online");
      $("#connection-label").textContent = profile.name;
      $("#connection-host").textContent = hostOf(profile.baseUrl);
    } else {
      dot.classList.add("locked");
      $("#connection-label").textContent = `${profile.name} · 待配置`;
      $("#connection-host").textContent = profile.needsLegacyUnlock
        ? "需要解锁并迁移一次"
        : profile.autoUnlockFailed ? "自动解密失败，请重新填写密钥" : "请填写 API Key";
    }
    updateGenerationState();
  }

  function renderConnectionProfiles() {
    const list = $("#connection-profile-list");
    list.innerHTML = "";
    state.config.connections.forEach((profile) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `connection-profile${profile.id === state.config.activeConnectionId ? " active" : ""}`;
      const status = profile.isUnlocked ? "online" : profile.hasSavedKey ? "locked" : "";
      button.innerHTML = `
        <span class="profile-status ${status}"></span>
        <span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(hostOf(profile.baseUrl))}</small></span>
        <span class="profile-active-mark">${profile.id === state.config.activeConnectionId ? "✓" : ""}</span>`;
      button.addEventListener("click", async () => {
        try {
          state.config = unwrap(await api.activateConnection(profile.id));
          state.draftNew = false;
          populateConnectionEditor(state.config.connections.find((item) => item.id === profile.id));
          renderConnectionProfiles();
          updateConnectionStatus();
        } catch (error) { toast(error.message, "error"); }
      });
      list.append(button);
    });
  }

  function setStorageChoice(value) {
    state.keyStorage = value === "encrypted" ? "encrypted" : "session";
    $$(".storage-option").forEach((button) => button.classList.toggle("active", button.dataset.value === state.keyStorage));
  }

  function setStreamEnabled(enabled) {
    state.streamEnabled = Boolean(enabled);
    $("#stream-toggle").setAttribute("aria-pressed", String(state.streamEnabled));
  }

  function clearConnectionErrors() {
    ["connection-name", "base-url", "model", "api-key", "request-timeout", "unlock"].forEach((name) => {
      const target = $(`#${name}-error`);
      if (target) target.textContent = "";
    });
  }

  function populateConnectionEditor(profile, options = {}) {
    const draft = profile || {
      id: crypto.randomUUID(),
      name: options.official ? "OpenAI" : "新连接",
      baseUrl: options.official ? "https://api.openai.com/v1" : "",
      model: "gpt-image-2",
      keyStorage: "session",
      requestTimeoutSeconds: 180,
      streamEnabled: false,
      hasSavedKey: false,
      isUnlocked: false,
    };
    state.editingConnectionId = draft.id;
    state.draftNew = !profile;
    $("#connection-editor-title").textContent = state.draftNew ? "新建连接" : `编辑 ${draft.name}`;
    $("#connection-name-input").value = draft.name || "";
    $("#base-url-input").value = draft.baseUrl || "";
    $("#model-input").value = draft.model || "gpt-image-2";
    $("#api-key-input").value = "";
    $("#request-timeout-input").value = draft.requestTimeoutSeconds || 180;
    $("#unlock-password-input").value = "";
    $("#api-key-help").textContent = draft.isUnlocked
      ? `${draft.keyStorage === "encrypted" ? "已自动解密" : "当前会话已加载"}${draft.maskedKey ? `（${draft.maskedKey}）` : ""}；留空可保留现有密钥。`
      : draft.needsLegacyUnlock ? "这是旧版密码加密记录，请在右侧解锁并迁移。" : draft.hasSavedKey ? "自动解密失败，请重新填写 API Key 并保存。" : "密钥默认只在本次应用运行期间保留。";
    $("#unlock-area").classList.toggle("hidden", state.draftNew || !draft.needsLegacyUnlock || draft.isUnlocked);
    $("#delete-connection-button").classList.toggle("hidden", state.draftNew);
    setStorageChoice(draft.keyStorage || "session");
    setStreamEnabled(Boolean(draft.streamEnabled));
    clearConnectionErrors();
    $("#connection-test-status").classList.add("hidden");
  }

  function collectConnection() {
    return {
      id: state.editingConnectionId,
      name: $("#connection-name-input").value.trim(),
      baseUrl: $("#base-url-input").value.trim(),
      model: $("#model-input").value.trim(),
      apiKey: $("#api-key-input").value.trim(),
      keyStorage: state.keyStorage,
      requestTimeoutSeconds: Number($("#request-timeout-input").value),
      streamEnabled: state.streamEnabled,
    };
  }

  function showConnectionError(error) {
    clearConnectionErrors();
    const fieldMap = { name: "connection-name", baseUrl: "base-url", model: "model", apiKey: "api-key", requestTimeoutSeconds: "request-timeout" };
    if (error.fields) {
      Object.entries(error.fields).forEach(([field, message]) => {
        const target = $(`#${fieldMap[field] || field}-error`);
        if (target) target.textContent = message;
      });
    } else if (error.code === "invalid_timeout") {
      $("#request-timeout-error").textContent = error.message;
    }
    toast(error.message, "error");
  }

  async function saveConnection() {
    try {
      state.config = unwrap(await api.saveConnection(collectConnection()));
      state.draftNew = false;
      populateConnectionEditor(activeProfile());
      renderConnectionProfiles();
      updateConnectionStatus();
      toast("连接配置已保存");
    } catch (error) { showConnectionError(error); }
  }

  async function testConnection() {
    const button = $("#test-connection-button");
    const status = $("#connection-test-status");
    button.disabled = true;
    button.textContent = "正在测试…";
    status.className = "inline-status hidden";
    try {
      const result = unwrap(await api.testConnection(collectConnection()));
      status.textContent = result.message;
      status.classList.remove("hidden", "error");
    } catch (error) {
      status.textContent = error.message;
      status.classList.remove("hidden");
      status.classList.add("error");
      showConnectionError(error);
    } finally {
      button.disabled = false;
      button.textContent = "测试连接";
      loadLogs();
    }
  }

  function selectedValue(selector) {
    return $(`${selector} button.active`)?.dataset.value || "";
  }

  function selectSegment(selector, value) {
    $$(`${selector} button`).forEach((button) => button.classList.toggle("active", button.dataset.value === value));
  }

  const sizeModeLabels = { auto: "自动", ratio: "按比例", custom: "自定义宽高" };
  const ratioIconClasses = {
    "1:1": "ratio-square",
    "3:2": "ratio-landscape",
    "2:3": "ratio-portrait",
    "16:9": "ratio-wide",
    "9:16": "ratio-tall",
    "4:3": "ratio-four-three",
    "3:4": "ratio-three-four",
    "21:9": "ratio-ultrawide",
  };

  function cloneSizeSelection(selection) {
    return { ...selection };
  }

  function sizeForSelection(selection) {
    if (selection.mode === "auto") return "auto";
    if (selection.mode === "custom") return `${Number(selection.width)}x${Number(selection.height)}`;
    return Validation.resolvePresetSize(selection.ratio, selection.resolution);
  }

  function currentSize() {
    return sizeForSelection(state.sizeSelection);
  }

  function displaySize(size) {
    return size === "auto" ? "自动" : size.replace("x", " × ");
  }

  function selectionFromSize(size) {
    const fallback = { mode: "ratio", ratio: "1:1", resolution: "1k", width: 1024, height: 1024 };
    if (!size || size === "auto") return { ...fallback, mode: "auto" };
    const preset = Validation.findSizePreset(size);
    if (preset) return { ...fallback, mode: "ratio", ...preset };
    const parsed = Validation.parseSize(size);
    if (!parsed.error && !parsed.auto) {
      return { ...fallback, mode: "custom", width: parsed.width, height: parsed.height };
    }
    return fallback;
  }

  function sizeSelectionMeta(selection) {
    if (selection.mode === "auto") return "模型自动选择";
    if (selection.mode === "custom") return "自定义宽高";
    return `${selection.resolution.toUpperCase()} · ${selection.ratio}`;
  }

  function updateSizeSummary() {
    const size = currentSize();
    $("#size-summary-value").textContent = displaySize(size);
    $("#size-summary-meta").textContent = `${sizeModeLabels[state.sizeSelection.mode]} · ${sizeSelectionMeta(state.sizeSelection)}`;
    const icon = $("#open-size-dialog-button .ratio-icon");
    const iconClass = state.sizeSelection.mode === "ratio" ? ratioIconClasses[state.sizeSelection.ratio] : "ratio-square";
    icon.className = `ratio-icon ${iconClass}`;
  }

  function setSizeSelectionFromSize(size) {
    state.sizeSelection = selectionFromSize(size);
    updateSizeSummary();
  }

  function renderSizeDialogPreview() {
    const draft = state.sizeDialogDraft;
    if (!draft) return;
    const size = sizeForSelection(draft);
    const parsed = Validation.parseSize(size);
    const error = parsed.error || "";
    $("#size-dialog-preview-value").textContent = displaySize(size);
    if (parsed.auto) {
      $("#size-dialog-preview-note").textContent = "模型根据提示词决定";
    } else if (!error) {
      const megapixels = (parsed.width * parsed.height / 1e6).toFixed(1);
      $("#size-dialog-preview-note").textContent = `${megapixels} MP${parsed.experimental ? " · 实验尺寸" : ""}`;
    } else {
      $("#size-dialog-preview-note").textContent = "请修正尺寸";
    }
    $("#size-dialog-error").textContent = error;
    $("#confirm-size-dialog-button").disabled = Boolean(error);
  }

  function renderSizeDialog() {
    const draft = state.sizeDialogDraft;
    if (!draft) return;
    selectSegment("#size-mode-control", draft.mode);
    selectSegment("#resolution-control", draft.resolution);
    $$("#ratio-control .ratio-option").forEach((button) => button.classList.toggle("active", button.dataset.ratio === draft.ratio));
    $("#size-ratio-panel").classList.toggle("hidden", draft.mode !== "ratio");
    $("#size-custom-panel").classList.toggle("hidden", draft.mode !== "custom");
    if (draft.mode === "custom") {
      $("#custom-width").value = draft.width;
      $("#custom-height").value = draft.height;
    }
    renderSizeDialogPreview();
  }

  function openSizeDialog() {
    state.sizeDialogDraft = cloneSizeSelection(state.sizeSelection);
    $("#size-dialog-current").textContent = displaySize(currentSize());
    renderSizeDialog();
    $("#size-dialog-overlay").classList.remove("hidden");
  }

  function closeSizeDialog() {
    $("#size-dialog-overlay").classList.add("hidden");
    state.sizeDialogDraft = null;
  }

  function confirmSizeDialog() {
    const draft = state.sizeDialogDraft;
    if (!draft) return;
    if (draft.mode === "custom") {
      draft.width = Number($("#custom-width").value);
      draft.height = Number($("#custom-height").value);
    }
    const parsed = Validation.parseSize(sizeForSelection(draft));
    if (parsed.error) {
      renderSizeDialogPreview();
      return;
    }
    state.sizeSelection = cloneSizeSelection(draft);
    closeSizeDialog();
    updateGenerationState();
  }

  function collectParameters() {
    const stream = Boolean(activeProfile()?.streamEnabled);
    return {
      prompt: $("#prompt-input").value,
      size: currentSize(),
      quality: selectedValue("#quality-control"),
      n: Number($("#count-input").value),
      background: selectedValue("#background-control"),
      outputFormat: selectedValue("#format-control"),
      outputCompression: Number($("#compression-range").value),
      moderation: selectedValue("#moderation-control"),
      stream,
      partialImages: stream ? 2 : 0,
    };
  }

  const qualityLabels = { auto: "自动", low: "低", medium: "中", high: "高" };
  const backgroundLabels = { auto: "自动背景", opaque: "不透明", transparent: "透明" };

  function updateFormatDependencies() {
    const format = selectedValue("#format-control");
    $("#compression-group").classList.toggle("hidden", !["jpeg", "webp"].includes(format));
  }

  function showGenerationErrors(errors = {}) {
    $("#prompt-error").textContent = errors.prompt || "";
    $("#size-error").textContent = errors.size || "";
    $("#count-error").textContent = errors.n || "";
    $("#format-error").textContent = errors.outputFormat || "";
    $("#prompt-wrap").classList.toggle("invalid", Boolean(errors.prompt));
  }

  function updateGenerationState() {
    const parameters = collectParameters();
    const validation = Validation.validateGeneration(parameters);
    const profile = activeProfile();
    updateSizeSummary();
    showGenerationErrors(parameters.prompt.length ? validation.errors : { ...validation.errors, prompt: "" });
    $("#prompt-count").textContent = parameters.prompt.length.toLocaleString();
    const streamText = parameters.stream ? " · 流式预览" : "";
    $("#parameter-summary").textContent = `${displaySize(parameters.size)} · ${qualityLabels[parameters.quality]}质量 · ${parameters.outputFormat.toUpperCase()}${streamText}`;
    const ready = validation.valid && Boolean(profile?.isUnlocked) && !state.isGenerating;
    $("#generate-button").disabled = !ready;
    if (!parameters.prompt.trim()) $("#validation-summary").textContent = "填写画面描述后即可开始生成";
    else if (!profile) $("#validation-summary").textContent = "请先添加连接配置";
    else if (!profile.isUnlocked) $("#validation-summary").textContent = "连接尚未加载 API Key";
    else if (!validation.valid) $("#validation-summary").textContent = "请修正标红的参数";
    else if (validation.warnings.length) $("#validation-summary").textContent = validation.warnings[0];
    else $("#validation-summary").textContent = `参数已就绪，可生成 ${parameters.n} 张图片`;
  }

  function resetParameters() {
    setSizeSelectionFromSize("1024x1024");
    selectSegment("#quality-control", "auto");
    selectSegment("#background-control", "auto");
    selectSegment("#format-control", "png");
    selectSegment("#moderation-control", "auto");
    $("#count-input").value = 1;
    $("#compression-range").value = 90;
    $("#compression-value").textContent = "90%";
    updateFormatDependencies();
    updateGenerationState();
  }

  function restoreEntryParameters(entry, promptOnly = false) {
    $("#prompt-input").value = entry.prompt || "";
    if (!promptOnly) {
      const p = entry.parameters || {};
      setSizeSelectionFromSize(p.size || "1024x1024");
      selectSegment("#quality-control", p.quality || "auto");
      selectSegment("#background-control", p.background || "auto");
      selectSegment("#format-control", p.outputFormat || "png");
      selectSegment("#moderation-control", p.moderation || "auto");
      $("#count-input").value = Number(p.n) || 1;
      $("#compression-range").value = p.outputCompression ?? 90;
      $("#compression-value").textContent = `${p.outputCompression ?? 90}%`;
      updateFormatDependencies();
    }
    updateGenerationState();
    navigate("generate");
    $("#prompt-input").focus();
  }

  function setResultMode(mode) {
    ["empty-result", "progress-result", "error-result", "results-grid"].forEach((id) => {
      $(`#${id}`).classList.toggle("hidden", id !== mode);
    });
    $("#result-stage").classList.toggle("empty", mode === "empty-result");
  }

  function startElapsedTimer() {
    clearInterval(state.elapsedTimer);
    state.generationStartedAt = Date.now();
    const tick = () => {
      const total = Math.floor((Date.now() - state.generationStartedAt) / 1000);
      $("#elapsed-time").textContent = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    };
    tick();
    state.elapsedTimer = window.setInterval(tick, 1000);
  }

  function stopElapsedTimer() {
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function openImageViewer(src, caption = "") {
    if (!src) return;
    $("#image-viewer-image").src = src;
    $("#image-viewer-caption").textContent = caption;
    $("#image-viewer").classList.remove("hidden");
  }

  function closeImageViewer() {
    $("#image-viewer").classList.add("hidden");
    $("#image-viewer-image").removeAttribute("src");
  }

  function renderResults(entry) {
    state.lastEntry = entry;
    const grid = $("#results-grid");
    grid.className = `results-grid${entry.images.length === 1 ? " single" : ""}`;
    grid.innerHTML = "";
    entry.images.forEach((image, index) => {
      const card = document.createElement("article");
      card.className = "result-card";
      card.innerHTML = `
        <img src="${escapeHtml(image.previewUrl)}" alt="生成结果 ${index + 1}" />
        <div class="result-card-footer">
          <span>${escapeHtml(image.format.toUpperCase())} · ${escapeHtml(formatBytes(image.bytes))}</span>
          <div class="result-card-actions"><button type="button" data-action="save">下载</button><button type="button" data-action="reveal">文件位置</button></div>
        </div>`;
      card.querySelector('[data-action="save"]').addEventListener("click", async () => {
        try { const result = unwrap(await api.saveImage(image)); if (!result.canceled) toast("图片已保存"); }
        catch (error) { toast(error.message, "error"); }
      });
      card.querySelector('[data-action="reveal"]').addEventListener("click", async () => {
        try { unwrap(await api.revealImage(image.path)); }
        catch (error) { toast(error.message, "error"); }
      });
      card.querySelector("img").addEventListener("dblclick", () => openImageViewer(image.previewUrl, entry.prompt));
      grid.append(card);
    });
    $("#result-meta").textContent = `${entry.images.length} 张 · ${(entry.durationMs / 1000).toFixed(1)} 秒`;
    $("#result-header-actions").classList.remove("hidden");
    setResultMode("results-grid");
  }

  function friendlyError(error) {
    const messages = {
      authentication_error: ["API Key 无效", "服务拒绝了当前密钥，请检查连接设置。"],
      permission_error: ["没有模型权限", "当前密钥可能没有使用该模型的权限。"],
      rate_limit_error: ["请求过于频繁", "服务正在限流，请稍后再试。"],
      server_error: ["服务暂时不可用", "远端服务出现异常，请稍后再试。"],
      timeout: ["请求等待超时", "可在连接设置中提高总超时时间，或在服务支持时尝试流式请求。"],
      cancelled: ["已取消生成", "这次请求已停止。"],
      missing_api_key: ["尚未加载密钥", "请前往设置输入 API Key，或完成旧版密钥迁移。"],
      invalid_response: ["响应格式不兼容", "服务已响应，但没有返回客户端可读取的图片。"],
    };
    return messages[error.code] || ["生成没有完成", error.message || "请稍后重试。"];
  }

  function renderGenerationError(error) {
    const [title, message] = friendlyError(error);
    $("#error-title").textContent = title;
    $("#error-message").textContent = message;
    $("#error-technical").textContent = JSON.stringify({ code: error.code, status: error.status, requestId: error.requestId, message: error.message, detail: error.detail }, null, 2);
    $("#error-details").open = false;
    setResultMode("error-result");
  }

  async function generate(options = {}) {
    const profile = activeProfile();
    if (!profile?.isUnlocked) {
      navigate("settings");
      toast("请先为当前连接输入 API Key，或完成旧版密钥迁移", "error");
      return;
    }
    const parameters = collectParameters();
    if (options.forceOne) parameters.n = 1;
    const validation = Validation.validateGeneration(parameters);
    showGenerationErrors(validation.errors);
    if (!validation.valid) { updateGenerationState(); return; }

    state.isGenerating = true;
    state.currentTaskId = crypto.randomUUID();
    localStorage.setItem("emberimage-last-prompt", parameters.prompt);
    $("#partial-preview").classList.add("hidden");
    $("#partial-preview").removeAttribute("src");
    $("#result-header-actions").classList.add("hidden");
    setResultMode("progress-result");
    startElapsedTimer();
    updateGenerationState();
    try {
      const entry = unwrap(await api.generate({ taskId: state.currentTaskId, parameters }));
      renderResults(entry);
      await loadHistory();
    } catch (error) {
      renderGenerationError(error);
    } finally {
      stopElapsedTimer();
      state.isGenerating = false;
      state.currentTaskId = null;
      updateGenerationState();
      loadLogs();
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date).replaceAll("/", "-");
  }

  function historyBadges(entry) {
    const p = entry.parameters || {};
    const duration = Number(entry.durationMs) ? `${(entry.durationMs / 1000).toFixed(1)}s` : "";
    return [qualityLabels[p.quality] || p.quality, backgroundLabels[p.background] || p.background, (p.outputFormat || "").toUpperCase(), duration].filter(Boolean);
  }

  function renderHistory() {
    const query = $("#history-search").value.trim().toLowerCase();
    const filtered = state.history.filter((entry) => {
      if (state.favoriteOnly && !entry.favorite) return false;
      return !query || `${entry.prompt} ${entry.model} ${entry.connectionName || ""}`.toLowerCase().includes(query);
    });
    $("#history-count").textContent = state.history.length;
    $("#history-summary").textContent = `共 ${filtered.length} 次生成`;
    $("#favorite-filter-button").classList.toggle("active", state.favoriteOnly);
    $("#favorite-filter-button").textContent = state.favoriteOnly ? "★ 只看收藏" : "☆ 只看收藏";
    const list = $("#history-list");
    list.innerHTML = "";
    $("#history-empty").classList.toggle("hidden", filtered.length > 0);
    list.classList.toggle("hidden", filtered.length === 0);

    filtered.forEach((entry) => {
      const image = entry.images?.[0];
      const card = document.createElement("article");
      card.className = "history-entry";
      const tags = historyBadges(entry).map((tag) => `<span class="image-badge">${escapeHtml(tag)}</span>`).join("");
      card.innerHTML = `
        <div class="history-image-wrap">
          ${image ? `<img src="${escapeHtml(image.previewUrl)}" alt="${escapeHtml(entry.prompt.slice(0, 80))}" />` : ""}
          <div class="history-image-top"><span class="image-badge">▣ ${escapeHtml(entry.parameters?.size || "自动")}</span><span>${entry.favorite ? '<span class="image-badge favorite">★ 收藏</span>' : '<span class="image-badge complete">已完成</span>'}</span></div>
          <div class="history-image-tags">${tags}</div>
        </div>
        <div class="history-copy">
          <p>${escapeHtml(entry.prompt)}</p>
          <div class="history-card-footer"><span>${escapeHtml(formatDate(entry.createdAt))}</span><button class="history-menu-button" type="button" aria-label="更多操作">···</button></div>
        </div>
        <div class="history-card-menu hidden">
          <button type="button" data-action="reuse">复用提示词</button>
          <button type="button" data-action="regenerate">再生成一张</button>
          <button type="button" data-action="copy">复制原图到剪贴板</button>
          <button type="button" data-action="favorite">${entry.favorite ? "取消收藏" : "收藏"}</button>
          <button class="danger" type="button" data-action="delete">删除</button>
        </div>`;
      const menu = card.querySelector(".history-card-menu");
      const menuButton = card.querySelector(".history-menu-button");
      if (image) card.querySelector(".history-image-wrap > img").addEventListener("dblclick", () => openImageViewer(image.previewUrl, entry.prompt));
      menuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const opening = menu.classList.contains("hidden");
        $$(".history-card-menu").forEach((node) => node.classList.add("hidden"));
        $$(".history-menu-button").forEach((node) => node.classList.remove("active"));
        menu.classList.toggle("hidden", !opening);
        menuButton.classList.toggle("active", opening);
      });
      menu.addEventListener("click", async (event) => {
        const action = event.target.closest("button")?.dataset.action;
        if (!action) return;
        menu.classList.add("hidden");
        if (action === "reuse") restoreEntryParameters(entry, true);
        if (action === "regenerate") { restoreEntryParameters(entry); $("#count-input").value = 1; updateGenerationState(); await generate({ forceOne: true }); }
        if (action === "copy") {
          try { if (!image) throw new Error("这条记录没有可复制的图片"); unwrap(await api.copyImage(image.path)); toast("原图已复制到剪贴板"); }
          catch (error) { toast(error.message, "error"); }
        }
        if (action === "favorite") {
          try { unwrap(await api.favoriteHistory(entry.id, !entry.favorite)); await loadHistory(); }
          catch (error) { toast(error.message, "error"); }
        }
        if (action === "delete" && window.confirm("删除这条记录并将对应原图移到废纸篓？")) {
          try { unwrap(await api.deleteHistory(entry.id)); await loadHistory(); toast("记录已删除，原图已移到废纸篓"); }
          catch (error) { toast(error.message, "error"); }
        }
      });
      list.append(card);
    });
  }

  async function loadHistory() {
    try { state.history = unwrap(await api.listHistory()); renderHistory(); }
    catch (error) { toast(error.message, "error"); }
  }

  function logTypeLabel(type) {
    return type === "connection_test" ? "连接测试" : "图片生成";
  }

  function renderLogs() {
    const list = $("#request-log-list");
    list.innerHTML = "";
    $("#request-log-empty").classList.toggle("hidden", state.logs.length > 0);
    $("#request-log-count").textContent = state.logs.length;
    state.logs.forEach((log) => {
      const request = log.request || {
        method: log.method,
        endpoint: log.endpoint,
        body: log.parameters || null,
      };
      const response = log.responseBody || log.response || (log.errorMessage ? { error: log.errorMessage } : null);
      const entry = document.createElement("details");
      entry.className = "request-log-entry";
      const statusText = log.status === "success" ? `成功 ${log.httpStatus || ""}` : log.status === "cancelled" ? "已取消" : `失败 ${log.httpStatus || ""}`;
      entry.innerHTML = `
        <summary>
          <span class="log-status ${escapeHtml(log.status)}">${escapeHtml(statusText)}</span>
          <strong>${escapeHtml(logTypeLabel(log.type))}</strong>
          <span>${escapeHtml(log.connectionName || "-")}</span>
          <span class="log-endpoint">${escapeHtml(request.method || log.method || "-")} ${escapeHtml(request.endpoint || log.endpoint || "-")}</span>
          <span>${Number.isFinite(log.durationMs) ? `${(log.durationMs / 1000).toFixed(1)}s` : "-"}</span>
          <time>${escapeHtml(formatDate(log.createdAt))}</time>
        </summary>
        <div class="request-log-detail">
          <dl>
            <div><dt>模型</dt><dd>${escapeHtml(log.model || "-")}</dd></div>
            <div><dt>HTTP 状态</dt><dd>${escapeHtml(log.httpStatus ?? "-")}</dd></div>
            <div><dt>Request ID</dt><dd>${escapeHtml(log.requestId || "-")}</dd></div>
            <div><dt>错误代码</dt><dd>${escapeHtml(log.errorCode || "-")}</dd></div>
          </dl>
          <h4>请求参数</h4>
          <pre>${escapeHtml(JSON.stringify(request, null, 2))}</pre>
          ${response ? `<h4>${log.status === "success" ? "响应摘要" : "失败响应体"}</h4><pre>${escapeHtml(typeof response === "string" ? response : JSON.stringify(response, null, 2))}</pre>` : ""}
          ${log.errorMessage ? `<h4>错误信息</h4><pre>${escapeHtml(log.errorMessage)}</pre>` : ""}
        </div>`;
      list.append(entry);
    });
  }

  async function loadLogs() {
    try { state.logs = unwrap(await api.listLogs()); renderLogs(); }
    catch (error) { toast(error.message, "error"); }
  }

  async function initialize() {
    applyWindowScale();
    const [configResult, historyResult, appInfoResult] = await Promise.all([api.loadConfig(), api.listHistory(), api.getAppInfo()]);
    state.config = unwrap(configResult);
    state.history = unwrap(historyResult);
    const appInfo = unwrap(appInfoResult);
    $("#version-label").textContent = `V${appInfo.version}`;
    renderConnectionProfiles();
    populateConnectionEditor(activeProfile());
    updateConnectionStatus();
    renderHistory();
    updateFormatDependencies();
    updateGenerationState();
  }

  window.addEventListener("resize", applyWindowScale);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".history-entry")) {
      $$(".history-card-menu").forEach((node) => node.classList.add("hidden"));
      $$(".history-menu-button").forEach((node) => node.classList.remove("active"));
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeImageViewer();
    closeSizeDialog();
    $("#request-log-overlay").classList.add("hidden");
  });

  $$("[data-view-target]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.viewTarget)));
  $("#open-settings-button").addEventListener("click", () => navigate("settings"));
  $("#prompt-input").addEventListener("input", updateGenerationState);
  $("#clear-prompt").addEventListener("click", () => { $("#prompt-input").value = ""; updateGenerationState(); $("#prompt-input").focus(); });
  $("#restore-prompt").addEventListener("click", () => { $("#prompt-input").value = localStorage.getItem("emberimage-last-prompt") || state.history[0]?.prompt || ""; updateGenerationState(); });
  $$(".style-chip").forEach((button) => button.addEventListener("click", () => {
    const prompt = $("#prompt-input");
    prompt.value = `${prompt.value.trim()}${prompt.value.trim() ? "，" : ""}${button.dataset.style}`;
    updateGenerationState();
  }));
  $("#open-size-dialog-button").addEventListener("click", openSizeDialog);
  $("#close-size-dialog-button").addEventListener("click", closeSizeDialog);
  $("#cancel-size-dialog-button").addEventListener("click", closeSizeDialog);
  $("#confirm-size-dialog-button").addEventListener("click", confirmSizeDialog);
  $("#size-dialog-overlay").addEventListener("click", (event) => {
    if (event.target === $("#size-dialog-overlay")) closeSizeDialog();
  });
  $$("#size-mode-control button").forEach((button) => button.addEventListener("click", () => {
    state.sizeDialogDraft.mode = button.dataset.value;
    renderSizeDialog();
  }));
  $$("#resolution-control button").forEach((button) => button.addEventListener("click", () => {
    state.sizeDialogDraft.resolution = button.dataset.value;
    renderSizeDialog();
  }));
  $$("#ratio-control .ratio-option").forEach((button) => button.addEventListener("click", () => {
    state.sizeDialogDraft.ratio = button.dataset.ratio;
    renderSizeDialog();
  }));
  ["#custom-width", "#custom-height"].forEach((selector) => $(selector).addEventListener("input", () => {
    if (!state.sizeDialogDraft) return;
    state.sizeDialogDraft.width = Number($("#custom-width").value);
    state.sizeDialogDraft.height = Number($("#custom-height").value);
    renderSizeDialogPreview();
  }));
  $("#count-input").addEventListener("input", updateGenerationState);
  ["#quality-control", "#background-control", "#format-control", "#moderation-control"].forEach((selector) => {
    $$(`${selector} button`).forEach((button) => button.addEventListener("click", () => {
      selectSegment(selector, button.dataset.value);
      if (selector === "#background-control" && button.dataset.value === "transparent" && selectedValue("#format-control") === "jpeg") selectSegment("#format-control", "png");
      updateFormatDependencies();
      updateGenerationState();
    }));
  });
  $("#count-decrease").addEventListener("click", () => { $("#count-input").value = Math.max(1, Number($("#count-input").value) - 1); updateGenerationState(); });
  $("#count-increase").addEventListener("click", () => { $("#count-input").value = Math.min(10, Number($("#count-input").value) + 1); updateGenerationState(); });
  $("#compression-range").addEventListener("input", () => { $("#compression-value").textContent = `${$("#compression-range").value}%`; updateGenerationState(); });
  $("#reset-parameters").addEventListener("click", resetParameters);
  $("#generate-button").addEventListener("click", () => generate());
  $("#retry-button").addEventListener("click", () => generate());
  $("#cancel-button").addEventListener("click", () => { if (state.currentTaskId) api.cancelGeneration(state.currentTaskId); });
  $("#error-settings-button").addEventListener("click", () => navigate("settings"));
  $("#download-all-button").addEventListener("click", async () => {
    try { const result = unwrap(await api.saveImages(state.lastEntry?.images || [])); if (!result.canceled) toast(`已保存 ${result.files.length} 张图片`); }
    catch (error) { toast(error.message, "error"); }
  });

  $("#history-search").addEventListener("input", renderHistory);
  $("#favorite-filter-button").addEventListener("click", () => { state.favoriteOnly = !state.favoriteOnly; renderHistory(); });
  $("#clear-history-button").addEventListener("click", async () => {
    if (!window.confirm("清空全部历史索引？已生成的原图文件会保留。")) return;
    try { unwrap(await api.clearHistory()); await loadHistory(); toast("历史记录已清空，原图文件仍然保留"); }
    catch (error) { toast(error.message, "error"); }
  });

  $("#add-connection-button").addEventListener("click", () => populateConnectionEditor(null));
  $("#official-template-button").addEventListener("click", () => populateConnectionEditor(null, { official: true }));
  $("#stream-toggle").addEventListener("click", () => setStreamEnabled(!state.streamEnabled));
  $$(".storage-option").forEach((button) => button.addEventListener("click", () => setStorageChoice(button.dataset.value)));
  $("#toggle-key-visibility").addEventListener("click", () => {
    const input = $("#api-key-input");
    input.type = input.type === "password" ? "text" : "password";
    $("#toggle-key-visibility").textContent = input.type === "password" ? "显示" : "隐藏";
  });
  $("#save-connection-button").addEventListener("click", saveConnection);
  $("#test-connection-button").addEventListener("click", testConnection);
  $("#delete-connection-button").addEventListener("click", async () => {
    if (!window.confirm("删除这份连接配置？对应的会话密钥也会被清除。")) return;
    try {
      state.config = unwrap(await api.deleteConnection(state.editingConnectionId));
      populateConnectionEditor(activeProfile());
      renderConnectionProfiles();
      updateConnectionStatus();
      toast("连接配置已删除");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#unlock-button").addEventListener("click", async () => {
    $("#unlock-error").textContent = "";
    try {
      state.config = unwrap(await api.unlockConnection(state.editingConnectionId, $("#unlock-password-input").value));
      populateConnectionEditor(editingProfile());
      renderConnectionProfiles();
      updateConnectionStatus();
      toast("密钥已迁移，以后打开会自动解密");
    } catch (error) { $("#unlock-error").textContent = error.message; }
  });
  $("#open-request-logs-button").addEventListener("click", async () => {
    await loadLogs();
    $("#request-log-overlay").classList.remove("hidden");
  });
  $("#close-request-logs-button").addEventListener("click", () => $("#request-log-overlay").classList.add("hidden"));
  $("#request-log-overlay").addEventListener("click", (event) => {
    if (event.target === $("#request-log-overlay")) $("#request-log-overlay").classList.add("hidden");
  });
  $("#close-image-viewer-button").addEventListener("click", closeImageViewer);
  $("#image-viewer").addEventListener("click", (event) => {
    if (event.target === $("#image-viewer")) closeImageViewer();
  });
  $("#refresh-logs-button").addEventListener("click", loadLogs);
  $("#clear-logs-button").addEventListener("click", async () => {
    if (!window.confirm("清空全部请求日志？")) return;
    try { unwrap(await api.clearLogs()); await loadLogs(); toast("请求日志已清空"); }
    catch (error) { toast(error.message, "error"); }
  });

  api.onGenerationPartial((payload) => {
    if (payload.taskId !== state.currentTaskId || !payload.previewUrl) return;
    $("#partial-preview").src = payload.previewUrl;
    $("#partial-preview").classList.remove("hidden");
  });

  initialize().catch((error) => {
    console.error(error);
    toast(`应用初始化失败：${error.message}`, "error");
  });
})();
