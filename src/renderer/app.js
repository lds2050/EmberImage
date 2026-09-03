(function bootstrapEmberImage() {
  "use strict";

  const api = window.imageStudio;
  const Validation = window.ImageStudioValidation;
  const MaskModel = window.EmberImageMaskModel;
  const Algorithms = window.EmberImageAlgorithms;
  const SelectionModel = window.EmberImageSelectionModel;
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
    creationMode: "generate",
    editAssets: [],
    editScope: "full",
    mask: { maskAssetId: null, baseAssetId: null, strokes: [], inverted: false, asset: null },
    isEditing: false,
    isImportingAssets: false,
    activeOperation: null,
    lastOperation: null,
    modeMemory: null,
    viewerResultSrc: null,
    viewerCompareSrc: null,
    viewerMaskSrc: null,
    viewerMaskOn: false,
    viewerWhich: "result",
    viewerRemoveBgAsset: null,
    prompts: [],
    editingPromptId: null,
    promptFilter: { query: "", category: "" },
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
    const designWidth = 1360;
    const designHeight = 900;
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
    if (viewName === "prompts") loadPrompts();
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

  const capabilityLabels = { unknown: "未知", supported: "已支持", unsupported: "不支持" };

  function updateCapabilityDisplay(profile) {
    const apply = (element, value) => {
      const state = value === "supported" || value === "unsupported" ? value : "unknown";
      element.textContent = capabilityLabels[state];
      element.className = `cap-${state}`;
    };
    apply($("#generation-capability"), profile?.generationCapability);
    apply($("#edit-capability"), profile?.editCapability);
  }

  async function refreshConnectionCapabilities() {
    try {
      state.config = unwrap(await api.loadConfig());
      renderConnectionProfiles();
      updateConnectionStatus();
      updateCapabilityDisplay(state.config.connections.find((item) => item.id === state.editingConnectionId));
    } catch { /* 能力刷新失败不影响主流程 */ }
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
    updateCapabilityDisplay(profile);
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
    $("#asset-error").textContent = errors.imageCount || "";
    $("#prompt-wrap").classList.toggle("invalid", Boolean(errors.prompt));
  }

  function requestBusy() {
    return state.isGenerating || state.isEditing || state.isImportingAssets;
  }

  function updateGenerationState() {
    const parameters = collectParameters();
    const isEdit = state.creationMode === "edit";
    const validation = isEdit
      ? Validation.validateEditInput({ ...parameters, imageCount: state.editAssets.length })
      : Validation.validateGeneration(parameters);
    const profile = activeProfile();
    updateSizeSummary();
    showGenerationErrors(parameters.prompt.length ? validation.errors : { ...validation.errors, prompt: "" });
    $("#prompt-count").textContent = parameters.prompt.length.toLocaleString();
    const streamText = parameters.stream ? " · 流式预览" : "";
    const summary = `${displaySize(parameters.size)} · ${qualityLabels[parameters.quality]}质量 · ${parameters.outputFormat.toUpperCase()}${streamText}`;
    const scopeLabel = state.editScope === "mask" ? "局部编辑" : "整体编辑";
    $("#parameter-summary").textContent = isEdit ? `${state.editAssets.length} 张输入 · ${scopeLabel} · ${summary}` : summary;
    const maskReady = state.editScope !== "mask" || Boolean(state.mask.maskAssetId);
    const ready = isEdit
      ? validation.valid && Boolean(profile?.isUnlocked) && !requestBusy() && state.editAssets.length > 0 && maskReady
      : validation.valid && Boolean(profile?.isUnlocked) && !requestBusy();
    $("#generate-button").disabled = !ready;
    let guidance;
    if (isEdit && !state.editAssets.length) guidance = "请至少添加一张图片";
    else if (isEdit && state.editScope === "mask" && !state.mask.maskAssetId) guidance = "请先标记希望修改的区域";
    else if (!parameters.prompt.trim()) guidance = isEdit ? "填写编辑要求后即可开始编辑" : "填写画面描述后即可开始生成";
    else if (!profile) guidance = "请先添加连接配置";
    else if (!profile.isUnlocked) guidance = "连接尚未加载 API Key";
    else if (!validation.valid) guidance = "请修正标红的参数";
    else if (validation.warnings.length) guidance = validation.warnings[0];
    else if (isEdit && profile.editCapability === "unsupported") guidance = "当前服务可能不支持图片编辑，仍可尝试提交";
    else guidance = isEdit ? `参数已就绪，可编辑 ${parameters.n} 张图片` : `参数已就绪，可生成 ${parameters.n} 张图片`;
    $("#validation-summary").textContent = guidance;
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

  const modeCopy = {
    generate: {
      hint: "输入描述，生成全新图片",
      promptNumber: "01",
      promptTitle: "描述画面",
      promptPlaceholder: "例如：薄雾清晨，一座漂浮在云海上的东方未来城市，远景构图，电影感光线，精致细节……",
      parameterNumber: "02",
      parameterTitle: "生成参数",
      resultNumber: "03",
      resultTitle: "生成结果",
      emptyTitle: "你的作品将在这里出现",
      emptyText: "写下画面描述并选择参数，点击生成后即可在此预览和下载。",
      progressTitle: "正在构思你的画面",
      cancelLabel: "取消生成",
      actionLabel: "开始生成",
    },
    edit: {
      hint: "导入图片，用自然语言修改它们",
      promptNumber: "02",
      promptTitle: "编辑要求",
      promptPlaceholder: "例如：保留主图的主体和构图，把背景换成清晨的森林……",
      parameterNumber: "03",
      parameterTitle: "输出参数",
      resultNumber: "04",
      resultTitle: "编辑结果",
      emptyTitle: "编辑结果将在这里出现",
      emptyText: "添加图片并写下编辑要求，点击开始编辑后即可在此预览和下载。",
      progressTitle: "正在编辑你的图片",
      cancelLabel: "取消编辑",
      actionLabel: "开始编辑",
    },
  };

  function defaultModeSnapshot() {
    return {
      prompt: "",
      sizeSelection: { mode: "ratio", ratio: "1:1", resolution: "1k", width: 1024, height: 1024 },
      quality: "auto",
      n: 1,
      background: "auto",
      outputFormat: "png",
      outputCompression: 90,
      moderation: "auto",
      lastEntry: null,
    };
  }

  function ensureModeMemory() {
    if (!state.modeMemory) state.modeMemory = { generate: defaultModeSnapshot(), edit: defaultModeSnapshot() };
    return state.modeMemory;
  }

  function taskBusy() {
    return state.isGenerating || state.isEditing;
  }

  function captureCurrentModeState() {
    return {
      prompt: $("#prompt-input").value,
      sizeSelection: cloneSizeSelection(state.sizeSelection),
      quality: selectedValue("#quality-control"),
      n: Number($("#count-input").value),
      background: selectedValue("#background-control"),
      outputFormat: selectedValue("#format-control"),
      outputCompression: Number($("#compression-range").value),
      moderation: selectedValue("#moderation-control"),
      lastEntry: state.lastEntry,
    };
  }

  function applyModeState(snapshot) {
    $("#prompt-input").value = snapshot.prompt;
    state.sizeSelection = cloneSizeSelection(snapshot.sizeSelection);
    updateSizeSummary();
    selectSegment("#quality-control", snapshot.quality);
    $("#count-input").value = snapshot.n;
    selectSegment("#background-control", snapshot.background);
    selectSegment("#format-control", snapshot.outputFormat);
    $("#compression-range").value = snapshot.outputCompression;
    $("#compression-value").textContent = `${snapshot.outputCompression}%`;
    selectSegment("#moderation-control", snapshot.moderation);
    updateFormatDependencies();
    if (snapshot.lastEntry) {
      renderResults(snapshot.lastEntry);
    } else {
      state.lastEntry = null;
      $("#result-meta").textContent = "";
      $("#result-header-actions").classList.add("hidden");
      setResultMode("empty-result");
    }
  }

  function setCreationMode(mode, options = {}) {
    const next = mode === "edit" ? "edit" : "generate";
    const previous = state.creationMode;
    const memory = ensureModeMemory();
    if (!options.initial) {
      if (next === previous) return;
      if (taskBusy()) { toast("请先等待当前任务完成或取消", "error"); return; }
      memory[previous] = captureCurrentModeState();
    }
    state.creationMode = next;
    localStorage.setItem("emberimage-creation-mode", next);
    selectSegment("#creation-mode-control", next);
    const copy = modeCopy[next];
    $("#creation-mode-hint").textContent = copy.hint;
    $("#asset-panel").classList.toggle("hidden", next !== "edit");
    $("#prompt-style-row").classList.toggle("hidden", next === "edit");
    $("#prompt-template-row").classList.toggle("hidden", next !== "edit");
    $("#prompt-section-number").textContent = copy.promptNumber;
    $("#prompt-panel-title").textContent = copy.promptTitle;
    $("#prompt-input").placeholder = copy.promptPlaceholder;
    $("#parameter-section-number").textContent = copy.parameterNumber;
    $("#parameter-panel-title").textContent = copy.parameterTitle;
    $("#result-section-number").textContent = copy.resultNumber;
    $("#result-panel-title").textContent = copy.resultTitle;
    $("#empty-result-title").textContent = copy.emptyTitle;
    $("#empty-result-text").textContent = copy.emptyText;
    $("#progress-title").textContent = copy.progressTitle;
    $("#cancel-button").textContent = copy.cancelLabel;
    $("#generate-button span").textContent = copy.actionLabel;
    applyModeState(memory[next]);
    updateUploadZoneLabel();
    renderMaskStatus();
    updateGenerationState();
  }

  function updateUploadZoneLabel() {
    const zone = $("#upload-zone");
    if (zone.classList.contains("busy")) {
      $("#upload-zone-title").textContent = "正在导入图片…";
      return;
    }
    $("#upload-zone-title").textContent = state.editAssets.length >= Validation.MAX_EDIT_IMAGES ? "已达 16 张上限" : "点击、拖入或粘贴图片";
  }

  function setUploadZoneBusy(busy) {
    $("#upload-zone").classList.toggle("busy", busy);
    updateUploadZoneLabel();
  }

  function setEditScope(scope) {
    const next = scope === "mask" ? "mask" : "full";
    state.editScope = next;
    selectSegment("#edit-scope-control", next);
    $("#edit-scope-hint").textContent = next === "mask" ? "Mask 仅作用于第 1 张主图" : "提示词与全部输入图共同决定输出";
    $("#mask-error").textContent = "";
    renderMaskStatus();
    updateGenerationState();
  }

  function renderMaskStatus() {
    const visible = state.creationMode === "edit" && state.editScope === "mask";
    $("#mask-status").classList.toggle("hidden", !visible);
    if (!visible) return;
    const hasMask = Boolean(state.mask.maskAssetId);
    $("#mask-status-empty").classList.toggle("hidden", hasMask);
    $("#mask-status-set").classList.toggle("hidden", !hasMask);
    if (hasMask) {
      const asset = state.mask.asset;
      $("#mask-status-thumb").src = asset?.thumbnailUrl || "";
      $("#mask-status-size").textContent = asset ? `${asset.width}×${asset.height} · ${formatBytes(asset.bytes)}` : "";
    } else {
      $("#mask-status-thumb").removeAttribute("src");
      $("#mask-status-empty-hint").textContent = state.editAssets.length ? "点击「编辑区域」，涂抹希望修改的范围" : "请先添加主图";
      $("#open-mask-editor-button").disabled = !state.editAssets.length;
    }
  }

  async function discardMask() {
    const id = state.mask.maskAssetId;
    state.mask = { maskAssetId: null, baseAssetId: null, strokes: [], inverted: false, asset: null };
    renderMaskStatus();
    updateGenerationState();
    if (id) await api.removeAsset(id).catch(() => {});
  }

  function confirmDiscardMask() {
    if (!state.mask.maskAssetId) return true;
    return window.confirm("更换主图将清除已标记的编辑区域，是否继续？");
  }

  let dragAssetIndex = null;

  function clearAssetDropIndicators() {
    $$("#asset-grid .asset-card").forEach((card) => card.classList.remove("drop-before", "drop-after"));
  }

  function renderAssets() {
    const grid = $("#asset-grid");
    grid.innerHTML = "";
    state.editAssets.forEach((asset, index) => {
      const card = document.createElement("article");
      card.className = `asset-card${index === 0 ? " main" : ""}`;
      card.dataset.assetId = asset.id;
      card.draggable = true;
      card.innerHTML = `
        <img src="${escapeHtml(asset.thumbnailUrl)}" alt="${escapeHtml(asset.fileName)}" />
        <span class="asset-role">${index === 0 ? "主图" : `参考 ${index + 1}`}</span>
        <div class="asset-card-info"><strong>${escapeHtml(asset.fileName)}</strong><small>${asset.width}×${asset.height} · ${formatBytes(asset.bytes)}</small></div>
        <div class="asset-card-actions">
          <button type="button" class="danger" data-action="remove" aria-label="移除">✕</button>
        </div>`;
      card.querySelector('[data-action="remove"]').addEventListener("click", () => removeAssetAt(index));
      card.querySelector("img").addEventListener("dblclick", () => openImageViewer(asset.originalUrl, asset.fileName, { removeBackgroundAsset: asset }));
      card.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openAssetContextMenu(asset, index, event);
      });
      card.addEventListener("dragstart", (event) => {
        hideAssetContextMenu();
        dragAssetIndex = index;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-emberimage-asset", asset.id);
        card.classList.add("dragging");
      });
      card.addEventListener("dragover", (event) => {
        if (dragAssetIndex === null || event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const rect = card.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        clearAssetDropIndicators();
        card.classList.add(before ? "drop-before" : "drop-after");
      });
      card.addEventListener("drop", (event) => {
        if (dragAssetIndex === null || event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = card.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        const target = before ? index : index + 1;
        const from = dragAssetIndex;
        clearAssetDropIndicators();
        dragAssetIndex = null;
        moveAssetTo(from, target);
      });
      card.addEventListener("dragend", () => {
        dragAssetIndex = null;
        card.classList.remove("dragging");
        clearAssetDropIndicators();
      });
      grid.append(card);
    });
    $("#asset-count").textContent = `${state.editAssets.length} / ${Validation.MAX_EDIT_IMAGES}`;
    $("#upload-zone").classList.toggle("reached-limit", state.editAssets.length >= Validation.MAX_EDIT_IMAGES);
    updateUploadZoneLabel();
    renderMaskStatus();
  }

  function enforceAssetCap(filePaths) {
    const room = Validation.MAX_EDIT_IMAGES - state.editAssets.length;
    if (filePaths.length <= room) return filePaths;
    toast(`最多添加 ${Validation.MAX_EDIT_IMAGES} 张图片，超出部分已忽略`, "error");
    return filePaths.slice(0, Math.max(0, room));
  }

  async function addAssetsByPaths(filePaths, options = {}) {
    const paths = enforceAssetCap(filePaths);
    if (!paths.length) return 0;
    state.isImportingAssets = true;
    setUploadZoneBusy(true);
    updateGenerationState();
    try {
      const result = unwrap(await api.importAssets(paths));
      if (result.assets.length) state.editAssets.push(...result.assets);
      if (result.errors.length) {
        if (options.summaryToast) toast(`部分图片导入失败，已跳过 ${result.errors.length} 张`, "error");
        else result.errors.forEach((item) => toast(`导入失败：${item.message}`, "error"));
      }
      renderAssets();
      return result.assets.length;
    } finally {
      state.isImportingAssets = false;
      setUploadZoneBusy(false);
      updateGenerationState();
    }
  }

  async function pickAndImportAssets() {
    try {
      const result = unwrap(await api.pickImages());
      if (!result.canceled && result.filePaths.length) await addAssetsByPaths(result.filePaths);
    } catch (error) { toast(error.message, "error"); }
  }

  async function importClipboardOrDropFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const accepted = [];
    files.forEach((file) => {
      if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) accepted.push(file);
      else toast(`已跳过不支持的文件：${file.name}`, "error");
    });
    const picked = enforceAssetCap(accepted);
    if (!picked.length) return;
    state.isImportingAssets = true;
    setUploadZoneBusy(true);
    updateGenerationState();
    try {
      for (const file of picked) {
        try {
          const buffer = new Uint8Array(await file.arrayBuffer());
          state.editAssets.push(unwrap(await api.importBuffer(buffer, file.name)));
        } catch (error) { toast(`${file.name}：${error.message}`, "error"); }
        renderAssets();
      }
    } finally {
      state.isImportingAssets = false;
      setUploadZoneBusy(false);
      updateGenerationState();
    }
  }

  async function removeAssetAt(index) {
    const asset = state.editAssets[index];
    if (!asset) return;
    if (index === 0 && !confirmDiscardMask()) return;
    if (index === 0 && state.mask.maskAssetId) await discardMask();
    state.editAssets.splice(index, 1);
    renderAssets();
    updateGenerationState();
    try { await api.removeAsset(asset.id); }
    catch { /* Registry entry is already gone after a restart. */ }
  }

  async function moveAssetTo(from, insertIndex) {
    if (from < 0 || from >= state.editAssets.length) return;
    const target = Math.max(0, Math.min(state.editAssets.length, insertIndex));
    const to = target > from ? target - 1 : target;
    if (to === from || to < 0 || to >= state.editAssets.length) return;
    if ((from === 0 || to === 0) && !confirmDiscardMask()) return;
    if ((from === 0 || to === 0) && state.mask.maskAssetId) await discardMask();
    const [asset] = state.editAssets.splice(from, 1);
    state.editAssets.splice(to, 0, asset);
    renderAssets();
    updateGenerationState();
  }

  async function clearEditAssets() {
    const ids = state.editAssets.map((asset) => asset.id);
    state.editAssets = [];
    renderAssets();
    updateGenerationState();
    await Promise.all(ids.map((id) => api.removeAsset(id).catch(() => {})));
  }

  async function edit(options = {}) {
    const profile = activeProfile();
    if (!profile?.isUnlocked) {
      navigate("settings");
      toast("请先为当前连接输入 API Key，或完成旧版密钥迁移", "error");
      return;
    }
    if (!state.editAssets.length) {
      $("#asset-error").textContent = "请至少添加一张图片";
      updateGenerationState();
      return;
    }
    if (state.editScope === "mask" && !state.mask.maskAssetId) {
      $("#mask-error").textContent = "请先标记希望修改的区域";
      updateGenerationState();
      return;
    }
    const parameters = collectParameters();
    if (options.forceOne) parameters.n = 1;
    const validation = Validation.validateEditInput({ ...parameters, imageCount: state.editAssets.length });
    showGenerationErrors(validation.errors);
    if (!validation.valid) { updateGenerationState(); return; }

    state.isEditing = true;
    state.activeOperation = "edit";
    state.lastOperation = "edit";
    state.currentTaskId = crypto.randomUUID();
    localStorage.setItem("emberimage-last-edit-prompt", parameters.prompt);
    $("#asset-error").textContent = "";
    $("#mask-error").textContent = "";
    $("#partial-preview").classList.add("hidden");
    $("#partial-preview").removeAttribute("src");
    $("#result-header-actions").classList.add("hidden");
    setResultMode("progress-result");
    startElapsedTimer();
    updateGenerationState();
    try {
      const requestPayload = { taskId: state.currentTaskId, assetIds: state.editAssets.map((asset) => asset.id), parameters };
      if (state.editScope === "mask") requestPayload.maskAssetId = state.mask.maskAssetId;
      const entry = unwrap(await api.edit(requestPayload));
      renderResults(entry);
      await loadHistory();
    } catch (error) {
      renderGenerationError(error);
    } finally {
      stopElapsedTimer();
      state.isEditing = false;
      state.currentTaskId = null;
      updateGenerationState();
      loadLogs();
      refreshConnectionCapabilities();
    }
  }

  async function continueEditingFromImage(image) {
    if (!image?.path || requestBusy()) return;
    if (!confirmDiscardMask()) return;
    const carriedPrompt = $("#prompt-input").value;
    if (state.mask.maskAssetId) await discardMask();
    await clearEditAssets();
    setCreationMode("edit");
    navigate("generate");
    const imported = await addAssetsByPaths([image.path]);
    if (!imported) return;
    $("#prompt-input").value = carriedPrompt;
    ensureModeMemory().edit.prompt = carriedPrompt;
    updateGenerationState();
    const prompt = $("#prompt-input");
    prompt.focus();
    prompt.select();
  }

  async function restoreEditFromHistory(entry) {
    if (requestBusy()) return;
    const paths = (entry.inputs || []).map((input) => input.storedPath).filter(Boolean);
    if (!paths.length) {
      toast("该记录没有可恢复的输入图", "error");
      return;
    }
    if (!confirmDiscardMask()) return;
    if (state.mask.maskAssetId) await discardMask();
    setEditScope("full");
    await clearEditAssets();
    setCreationMode("edit");
    const imported = await addAssetsByPaths(paths, { summaryToast: true });
    if (!imported) {
      toast("原输入图已不存在，无法恢复素材", "error");
      return;
    }
    restoreEntryParameters(entry);
    ensureModeMemory().edit.prompt = entry.prompt || "";
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
    const promptInput = $("#prompt-input");
    promptInput.focus();
    promptInput.setSelectionRange(0, 0);
    promptInput.scrollTop = 0;
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

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片载入失败"));
      image.src = src;
    });
  }

  const viewerMaskCache = { src: null, image: null };

  async function renderViewerImage() {
    const img = $("#image-viewer-image");
    const baseSrc = state.viewerWhich === "original" && state.viewerCompareSrc ? state.viewerCompareSrc : state.viewerResultSrc;
    if (!baseSrc) return;
    $("#image-viewer-mask-overlay").classList.add("hidden");
    img.src = baseSrc;
    updateViewerMaskOverlay();
  }

  function updateViewerMaskOverlay() {
    const img = $("#image-viewer-image");
    const overlay = $("#image-viewer-mask-overlay");
    if (!state.viewerMaskOn || !state.viewerMaskSrc || !img.complete || !img.naturalWidth) {
      overlay.classList.add("hidden");
      return;
    }
    const boxW = img.clientWidth;
    const boxH = img.clientHeight;
    if (!boxW || !boxH) { overlay.classList.add("hidden"); return; }
    const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    overlay.style.left = `${img.offsetLeft + (boxW - w) / 2}px`;
    overlay.style.top = `${img.offsetTop + (boxH - h) / 2}px`;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    overlay.classList.remove("hidden");
    drawViewerMaskTint(w, h);
  }

  async function drawViewerMaskTint(width, height) {
    const overlay = $("#image-viewer-mask-overlay");
    const maskSrc = state.viewerMaskSrc;
    let maskImage = viewerMaskCache.src === maskSrc ? viewerMaskCache.image : null;
    if (!maskImage) {
      try { maskImage = await loadImageElement(maskSrc); }
      catch { overlay.classList.add("hidden"); return; }
      viewerMaskCache.src = maskSrc;
      viewerMaskCache.image = maskImage;
    }
    if (!state.viewerMaskOn || state.viewerMaskSrc !== maskSrc || $("#image-viewer").classList.contains("hidden")) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    overlay.width = Math.max(1, Math.round(width * dpr));
    overlay.height = Math.max(1, Math.round(height * dpr));
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.drawImage(maskImage, 0, 0, overlay.width, overlay.height);
    // Mask 中完全透明（Alpha=0）的像素是编辑区域，叠合时重着色为半透明橙色。
    const pixelData = ctx.getImageData(0, 0, overlay.width, overlay.height);
    const px = pixelData.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) { px[i] = 255; px[i + 1] = 108; px[i + 2] = 74; px[i + 3] = 140; }
      else { px[i + 3] = 0; }
    }
    ctx.putImageData(pixelData, 0, 0);
  }

  function openImageViewer(src, caption = "", options = {}) {
    if (!src) return;
    state.viewerResultSrc = src;
    state.viewerCompareSrc = options.compareSrc || null;
    state.viewerMaskSrc = options.maskSrc || null;
    state.viewerRemoveBgAsset = options.removeBackgroundAsset || null;
    state.viewerMaskOn = false;
    state.viewerWhich = "result";
    $("#image-viewer-caption").textContent = caption;
    $("#image-viewer-compare").classList.toggle("hidden", !state.viewerCompareSrc);
    $$("#image-viewer-compare button").forEach((button) => button.classList.toggle("active", button.dataset.value === "result"));
    $("#image-viewer-mask-toggle").classList.toggle("hidden", !state.viewerMaskSrc);
    $("#image-viewer-mask-toggle").setAttribute("aria-pressed", "false");
    $("#image-viewer-remove-bg-button").classList.toggle("hidden", !state.viewerRemoveBgAsset);
    $("#image-viewer").classList.remove("hidden");
    renderViewerImage();
  }

  function setViewerImage(which = state.viewerWhich) {
    state.viewerWhich = which === "original" && state.viewerCompareSrc ? "original" : "result";
    $$("#image-viewer-compare button").forEach((button) => button.classList.toggle("active", button.dataset.value === state.viewerWhich));
    renderViewerImage();
  }

  function closeImageViewer() {
    $("#image-viewer").classList.add("hidden");
    $("#image-viewer-image").removeAttribute("src");
    $("#image-viewer-mask-overlay").classList.add("hidden");
    $("#image-viewer-compare").classList.add("hidden");
    $("#image-viewer-mask-toggle").classList.add("hidden");
    $("#image-viewer-remove-bg-button").classList.add("hidden");
    state.viewerResultSrc = null;
    state.viewerCompareSrc = null;
    state.viewerMaskSrc = null;
    state.viewerRemoveBgAsset = null;
    state.viewerMaskOn = false;
    state.viewerWhich = "result";
  }

  function editCompareSrc(entry) {
    return entry.operation === "edit" ? entry.inputs?.[0]?.previewUrl || null : null;
  }

  function editMaskSrc(entry) {
    return entry.operation === "edit" ? entry.mask?.previewUrl || null : null;
  }

  // ---- 背景移除（v0.5.3 阶段 C）：纯本地处理，自动主体 → 非主体透明化 → 预览导出 ----
  const bgRemoval = { busy: false, blob: null, fileName: "" };

  function closeBgRemoval() {
    $("#bg-removal-overlay").classList.add("hidden");
    bgRemoval.blob = null;
    bgRemoval.fileName = "";
  }

  async function removeBackgroundFlow(asset) {
    if (!asset || bgRemoval.busy) return;
    bgRemoval.busy = true;
    closeImageViewer();
    hideAssetContextMenu();
    $("#bg-removal-canvas").classList.add("hidden");
    $("#bg-removal-loading").classList.remove("hidden");
    $("#bg-removal-status").textContent = "正在识别主体…";
    $("#bg-removal-import-button").disabled = true;
    $("#bg-removal-export-button").disabled = true;
    $("#bg-removal-overlay").classList.remove("hidden");
    try {
      const image = await loadImageElement(asset.originalUrl);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let mask;
      try {
        // 位图随请求拷贝转移给 Worker；主图原始数据保留在本地供降级使用
        mask = await runSelection("subjectMask", {
          bitmap: imageData.data,
          width: canvas.width,
          height: canvas.height,
          tolerance: 32,
          maxEdge: 2048,
        });
      } catch {
        // Worker 初始化失败/崩溃/超时 → 主线程降级（>2048px 自动降采样，不会长时间卡顿）
        mask = Algorithms.subjectMask(imageData.data, canvas.width, canvas.height, 32, { maxEdge: 2048 });
      }
      if (!mask || !mask.some((value) => value)) {
        closeBgRemoval();
        toast("未能识别主体，请用魔棒或套索手动选择", "error");
        return;
      }
      // 主体 Alpha=255、背景 Alpha=0，边缘羽化半径 2 平滑过渡
      const alpha = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i += 1) alpha[i] = mask[i] ? 255 : 0;
      const feathered = Algorithms.boxBlurChannel(alpha, canvas.width, canvas.height, 2, 1);
      const output = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < mask.length; i += 1) {
        const o = i * 4;
        output.data[o] = imageData.data[o];
        output.data[o + 1] = imageData.data[o + 1];
        output.data[o + 2] = imageData.data[o + 2];
        output.data[o + 3] = feathered[i];
      }
      const preview = $("#bg-removal-canvas");
      preview.width = canvas.width;
      preview.height = canvas.height;
      preview.getContext("2d").putImageData(output, 0, 0);
      const blob = await new Promise((resolve, reject) => preview.toBlob((result) => (result ? resolve(result) : reject(new Error("导出失败"))), "image/png"));
      bgRemoval.blob = blob;
      const base = String(asset.fileName || "image").replace(/\.[^.]+$/, "") || "image";
      bgRemoval.fileName = `${base}-nobg.png`;
      $("#bg-removal-loading").classList.add("hidden");
      preview.classList.remove("hidden");
      $("#bg-removal-status").textContent = `${canvas.width} × ${canvas.height} · 主体已保留，背景已透明`;
      $("#bg-removal-import-button").disabled = false;
      $("#bg-removal-export-button").disabled = false;
    } catch (error) {
      closeBgRemoval();
      toast(error.message || "背景移除失败", "error");
    } finally {
      bgRemoval.busy = false;
    }
  }

  function exportBgRemovalPng() {
    if (!bgRemoval.blob) return;
    const url = URL.createObjectURL(bgRemoval.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = bgRemoval.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast("已导出透明 PNG");
  }

  async function importBgRemovalAsAsset() {
    if (!bgRemoval.blob) return;
    if (state.editAssets.length >= Validation.MAX_EDIT_IMAGES) {
      toast(`最多添加 ${Validation.MAX_EDIT_IMAGES} 张图片，请先移除部分素材`, "error");
      return;
    }
    try {
      const buffer = new Uint8Array(await bgRemoval.blob.arrayBuffer());
      const imported = unwrap(await api.importBuffer(buffer, bgRemoval.fileName));
      state.editAssets.push(imported);
      renderAssets();
      closeBgRemoval();
      toast("透明图片已加入素材面板");
    } catch (error) {
      toast(error.message || "加入素材失败", "error");
    }
  }

  // ---- 素材卡片右键菜单：放大预览 / 移除背景 / 移除素材 ----
  let assetContextMenu = null;

  function hideAssetContextMenu() {
    if (assetContextMenu) {
      assetContextMenu.remove();
      assetContextMenu = null;
    }
  }

  function openAssetContextMenu(asset, index, event) {
    hideAssetContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.setAttribute("role", "menu");
    const items = [
      { label: "放大预览", action: () => openImageViewer(asset.originalUrl, asset.fileName, { removeBackgroundAsset: asset }) },
      { label: "移除背景", action: () => removeBackgroundFlow(asset) },
      { separator: true },
      { label: "移除素材", danger: true, action: () => removeAssetAt(index) },
    ];
    items.forEach((item) => {
      if (item.separator) {
        const divider = document.createElement("div");
        divider.className = "context-menu-separator";
        menu.append(divider);
        return;
      }
      const button = document.createElement("button");
      button.type = "button";
      if (item.danger) button.className = "danger";
      button.textContent = item.label;
      button.addEventListener("click", () => {
        hideAssetContextMenu();
        item.action();
      });
      menu.append(button);
    });
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
    assetContextMenu = menu;
  }

  const maskEditor = {
    open: false,
    exporting: false,
    baseImage: null,
    imgW: 0,
    imgH: 0,
    viewScale: 1,
    fitScale: 1,
    session: null,
    tool: "brush",
    previewOn: true,
    inverted: false,
    drawing: null,
    spaceDown: false,
    panning: null,
    overlay: document.createElement("canvas"),
    // 选区工具状态（v0.5.3 工具箱）
    selectionSession: null,
    selectionCanvas: document.createElement("canvas"),
    selectionBoundary: null,
    selectionBusy: false,
    wandTolerance: 32,
    wandContiguous: true,
    antsTimer: null,
    antsTick: 0,
    bitmapData: null,
    lasso: null,
  };

  // ---- 选区计算调度：Worker 优先，初始化失败/崩溃/超时自动降级主线程 ----
  const selectionCompute = {
    worker: null,
    broken: false,
    warned: false,
    pending: new Map(),
    nextId: 0,
  };

  function ensureSelectionWorker() {
    if (selectionCompute.broken || selectionCompute.worker) return selectionCompute.worker;
    try {
      selectionCompute.worker = new Worker("workers/selection.worker.js");
      selectionCompute.worker.onmessage = (event) => {
        const { id, ok, mask, error } = event.data || {};
        const task = selectionCompute.pending.get(id);
        if (!task) return;
        selectionCompute.pending.delete(id);
        clearTimeout(task.timer);
        // 编辑器已在计算途中关闭：此时请求已落地，可以安全释放位图了
        if (!maskEditor.open && !selectionCompute.pending.size) releaseSelectionBitmap();
        if (ok) task.resolve(mask);
        else task.reject(new Error(error || "选区计算失败"));
      };
      selectionCompute.worker.onerror = () => { teardownSelectionWorker(); };
    } catch {
      selectionCompute.broken = true;
    }
    return selectionCompute.worker;
  }

  function teardownSelectionWorker() {
    const worker = selectionCompute.worker;
    selectionCompute.worker = null;
    selectionCompute.broken = true;
    if (worker) worker.terminate();
    selectionCompute.pending.forEach(({ timer, reject }) => {
      clearTimeout(timer);
      reject(new Error("worker-unavailable"));
    });
    selectionCompute.pending.clear();
    if (!selectionCompute.warned) {
      selectionCompute.warned = true;
      toast("性能模式：大图选区操作可能卡顿");
    }
  }

  function computeSelectionOnMainThread(op, payload) {
    const bitmap = maskEditor.bitmapData ? maskEditor.bitmapData.data : null;
    if (op === "floodFill") {
      return Algorithms.floodFill(bitmap, maskEditor.imgW, maskEditor.imgH, payload.x, payload.y, payload.tolerance, { contiguous: payload.contiguous !== false });
    }
    if (op === "fillPolygon") {
      return Algorithms.fillPolygon(payload.points, payload.width, payload.height);
    }
    if (op === "subjectMask") {
      // 独立流程（背景移除）自带位图；编辑器内用已同步的主图位图。
      const source = payload.bitmap || bitmap;
      const w = payload.bitmap ? payload.width | 0 : maskEditor.imgW;
      const h = payload.bitmap ? payload.height | 0 : maskEditor.imgH;
      return Algorithms.subjectMask(source, w, h, payload.tolerance, payload);
    }
    throw new Error(`未知选区操作：${op}`);
  }

  function runSelection(op, payload) {
    return new Promise((resolve, reject) => {
      const worker = ensureSelectionWorker();
      if (!worker) {
        setTimeout(() => {
          try { resolve(computeSelectionOnMainThread(op, payload)); }
          catch (error) { reject(error); }
        }, 0);
        return;
      }
      const id = `sel-${selectionCompute.nextId += 1}`;
      const timer = setTimeout(() => {
        selectionCompute.pending.delete(id);
        teardownSelectionWorker();
        if (!maskEditor.open) maskEditor.bitmapData = null;
        reject(new Error("选区计算超时，请降低容差或使用套索"));
      }, 5000);
      selectionCompute.pending.set(id, { timer, resolve, reject });
      // 携带位图的请求先做独立副本再转移所有权，原位图保留给主线程降级路径。
      let message = { id, op, payload };
      const transfer = [];
      if (payload && payload.bitmap && payload.bitmap.buffer) {
        const copy = new Uint8Array(payload.bitmap);
        message = { id, op, payload: Object.assign({}, payload, { bitmap: copy }) };
        transfer.push(copy.buffer);
      }
      worker.postMessage(message, transfer);
    });
  }

  // 编辑器打开时把主图原始尺寸 RGBA 位图同步给 Worker（独立副本转移所有权）。
  function syncSelectionBitmap() {
    if (!maskEditor.baseImage || !maskEditor.imgW || !maskEditor.imgH) return;
    const canvas = document.createElement("canvas");
    canvas.width = maskEditor.imgW;
    canvas.height = maskEditor.imgH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(maskEditor.baseImage, 0, 0, canvas.width, canvas.height);
    maskEditor.bitmapData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const worker = ensureSelectionWorker();
    if (worker) {
      const copy = new Uint8Array(maskEditor.bitmapData.data);
      worker.postMessage({
        id: `sel-${selectionCompute.nextId += 1}`,
        op: "setBitmap",
        payload: { bitmap: copy.buffer, width: canvas.width, height: canvas.height },
      }, [copy.buffer]);
    }
  }

  // 编辑器关闭后释放主线程与 Worker 两侧的位图副本（4K 图各约 67MB）。
  // 仍有选区计算在途时先不释放，否则正在跑的请求会拿不到位图而报错。
  function releaseSelectionBitmap() {
    if (selectionCompute.pending.size) return;
    maskEditor.bitmapData = null;
    const worker = selectionCompute.worker;
    if (worker) {
      worker.postMessage({
        id: `sel-${selectionCompute.nextId += 1}`,
        op: "releaseBitmap",
        payload: {},
      });
    }
  }

  function selectionActive() {
    return Boolean(maskEditor.selectionSession) && !maskEditor.selectionSession.isEmpty();
  }

  function isSelectionTool() {
    return maskEditor.tool === "wand" || maskEditor.tool === "lasso";
  }

  function resetSelectionLayer() {
    maskEditor.selectionCanvas.width = 0;
    maskEditor.selectionCanvas.height = 0;
    maskEditor.selectionBoundary = null;
  }

  function startSelectionAnts() {
    if (maskEditor.antsTimer) return;
    maskEditor.antsTimer = setInterval(() => {
      maskEditor.antsTick = (maskEditor.antsTick + 1) % 4096;
      if (maskEditor.open && selectionActive()) drawMaskEditor();
    }, 130);
  }

  function stopSelectionAnts() {
    if (maskEditor.antsTimer) {
      clearInterval(maskEditor.antsTimer);
      maskEditor.antsTimer = null;
    }
  }

  // 全尺寸选区蒙版 → 视图分辨率填充层（蓝色半透明）+ 边界位图（蚂蚁线）。
  function rebuildSelectionLayer() {
    const canvas = maskEditor.selectionCanvas;
    if (!selectionActive()) {
      resetSelectionLayer();
      return;
    }
    const viewW = Math.max(1, Math.round(maskEditor.imgW * maskEditor.viewScale));
    const viewH = Math.max(1, Math.round(maskEditor.imgH * maskEditor.viewScale));
    if (canvas.width !== viewW || canvas.height !== viewH) {
      canvas.width = viewW;
      canvas.height = viewH;
    }
    const mask = maskEditor.selectionSession.getMask();
    const imgW = maskEditor.imgW;
    const imgH = maskEditor.imgH;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(viewW, viewH);
    const px = image.data;
    const view = new Uint8Array(viewW * viewH);
    for (let vy = 0; vy < viewH; vy += 1) {
      const sy = Math.min(imgH - 1, Math.floor((vy * imgH) / viewH));
      for (let vx = 0; vx < viewW; vx += 1) {
        const sx = Math.min(imgW - 1, Math.floor((vx * imgW) / viewW));
        if (!mask[sy * imgW + sx]) continue;
        const vi = vy * viewW + vx;
        view[vi] = 1;
        const o = vi * 4;
        px[o] = 77;
        px[o + 1] = 154;
        px[o + 2] = 255;
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const boundary = new Uint8Array(viewW * viewH);
    for (let vy = 0; vy < viewH; vy += 1) {
      for (let vx = 0; vx < viewW; vx += 1) {
        const i = vy * viewW + vx;
        if (!view[i]) continue;
        const l = vx > 0 ? view[i - 1] : 0;
        const r = vx < viewW - 1 ? view[i + 1] : 0;
        const u = vy > 0 ? view[i - viewW] : 0;
        const d = vy < viewH - 1 ? view[i + viewW] : 0;
        if (!l || !r || !u || !d) boundary[i] = 1;
      }
    }
    maskEditor.selectionBoundary = { width: viewW, height: viewH, data: boundary };
  }

  function applySelectionMask(mask, mode) {
    if (!maskEditor.selectionSession) return;
    if (mode === "add") maskEditor.selectionSession.addMask(mask);
    else if (mode === "subtract") maskEditor.selectionSession.subtractMask(mask);
    else maskEditor.selectionSession.setFromMask(mask);
    rebuildSelectionLayer();
    if (selectionActive()) startSelectionAnts();
    else stopSelectionAnts();
    updateSelectionToolUi();
    drawMaskEditor();
  }

  async function handleWandClick(point, event) {
    if (maskEditor.selectionBusy) return;
    const mode = event.shiftKey ? "add" : event.altKey ? "subtract" : "replace";
    maskEditor.selectionBusy = true;
    updateSelectionToolUi();
    try {
      const mask = await runSelection("floodFill", {
        x: Math.floor(point.x),
        y: Math.floor(point.y),
        tolerance: maskEditor.wandTolerance,
        contiguous: maskEditor.wandContiguous,
      });
      applySelectionMask(mask, mode);
    } catch (error) {
      if (error && error.message === "worker-unavailable") {
        try { applySelectionMask(computeSelectionOnMainThread("floodFill", { x: Math.floor(point.x), y: Math.floor(point.y), tolerance: maskEditor.wandTolerance, contiguous: maskEditor.wandContiguous }), mode); }
        catch (inner) { toast(inner.message || "选区计算失败", "error"); }
      } else {
        toast(error.message || "选区计算失败", "error");
      }
    } finally {
      maskEditor.selectionBusy = false;
      updateSelectionToolUi();
      drawMaskEditor();
    }
  }

  async function finalizeLasso(event) {
    const lasso = maskEditor.lasso;
    maskEditor.lasso = null;
    try { $("#mask-canvas").releasePointerCapture(event.pointerId); }
    catch { /* Pointer was never captured. */ }
    const points = Algorithms.simplifyPolyline(lasso.points, 2000);
    if (points.length < 3) {
      drawMaskEditor();
      return;
    }
    maskEditor.selectionBusy = true;
    updateSelectionToolUi();
    try {
      const mask = await runSelection("fillPolygon", { points, width: maskEditor.imgW, height: maskEditor.imgH });
      applySelectionMask(mask, lasso.mode);
    } catch (error) {
      if (error && error.message === "worker-unavailable") {
        try { applySelectionMask(computeSelectionOnMainThread("fillPolygon", { points, width: maskEditor.imgW, height: maskEditor.imgH }), lasso.mode); }
        catch (inner) { toast(inner.message || "选区计算失败", "error"); }
      } else {
        toast(error.message || "选区计算失败", "error");
      }
    } finally {
      maskEditor.selectionBusy = false;
      updateSelectionToolUi();
      drawMaskEditor();
    }
  }

  function cancelSelection() {
    if (!maskEditor.selectionSession) return;
    maskEditor.selectionSession.clear();
    resetSelectionLayer();
    stopSelectionAnts();
    updateSelectionToolUi();
    drawMaskEditor();
  }

  // 自动主体：一键启发式圈选画面主体（固定容差，大图自动降采样计算），结果作为活动选区。
  async function autoSubjectSelection() {
    if (!maskEditor.open || maskEditor.selectionBusy) return;
    maskEditor.selectionBusy = true;
    updateSelectionToolUi();
    try {
      const mask = await runSelection("subjectMask", { tolerance: 32, maxEdge: 2048 });
      if (!mask || !mask.some((value) => value)) {
        toast("未能识别主体，请用魔棒或套索手动选择", "error");
        return;
      }
      applySelectionMask(mask, "replace");
      toast("已自动选中主体，可反选/羽化后应用为 Mask");
    } catch (error) {
      if (error && error.message === "worker-unavailable") {
        try {
          const mask = computeSelectionOnMainThread("subjectMask", { tolerance: 32, maxEdge: 2048 });
          if (!mask || !mask.some((value) => value)) {
            toast("未能识别主体，请用魔棒或套索手动选择", "error");
            return;
          }
          applySelectionMask(mask, "replace");
          toast("已自动选中主体，可反选/羽化后应用为 Mask");
        }
        catch (inner) { toast(inner.message || "选区计算失败", "error"); }
      } else {
        toast(error.message || "选区计算失败", "error");
      }
    } finally {
      maskEditor.selectionBusy = false;
      updateSelectionToolUi();
      drawMaskEditor();
    }
  }

  function invertSelection() {
    if (!selectionActive()) return;
    maskEditor.selectionSession.invert();
    rebuildSelectionLayer();
    drawMaskEditor();
  }

  function applySelectionAsMask() {
    if (!selectionActive() || maskEditor.selectionBusy) return;
    // 应用时以羽化滑杆当前值为准（0 = 硬边界，序列化沿用 selection-model 的 runs 编码）。
    const action = Object.assign({ type: "selection" }, maskEditor.selectionSession.serialize());
    const feather = Number($("#mask-feather-range").value);
    action.featherRadius = Number.isFinite(feather) ? Math.max(0, Math.min(20, Math.floor(feather))) : 2;
    maskEditor.session.addAction(action);
    maskEditor.selectionSession.clear();
    resetSelectionLayer();
    stopSelectionAnts();
    maskEditor.tool = "brush";
    selectSegment("#mask-tool-control", "brush");
    selectSegment("#mask-selection-tool-control", "");
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
    updateSelectionToolUi();
    toast("选区已应用为编辑区域");
  }

  function updateSelectionToolUi() {
    const selecting = isSelectionTool();
    const active = selectionActive();
    const busy = maskEditor.selectionBusy;
    const selectionUi = selecting || active;
    $("#mask-brush-size-field").classList.toggle("hidden", selecting);
    $("#mask-wand-options").classList.toggle("hidden", maskEditor.tool !== "wand");
    $("#mask-feather-field").classList.toggle("hidden", !selectionUi);
    $("#mask-selection-bar").classList.toggle("hidden", !selectionUi);
    $("#mask-auto-subject-button").disabled = busy;
    $$("#mask-tool-control button").forEach((button) => { button.disabled = active; });
    ["#mask-selection-invert-button", "#mask-selection-cancel-button", "#mask-selection-apply-button"].forEach((id) => {
      $(id).disabled = !active || busy;
    });
    const canvas = $("#mask-canvas");
    if (canvas) canvas.style.cursor = selecting ? "crosshair" : "";
  }

  // ---- 已应用选区动作（type:"selection"）在覆盖层与导出层的重建 ----
  const selectionViewCache = new WeakMap();

  function selectionActionAlpha(action) {
    if (!action || action.type !== "selection") return null;
    const width = action.width | 0;
    const height = action.height | 0;
    if (width !== maskEditor.imgW || height !== maskEditor.imgH || width <= 0 || height <= 0) return null;
    const binary = SelectionModel.decodeSelectionRuns(action, width * height);
    if (!binary) return null;
    const scaled = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) scaled[i] = binary[i] ? 255 : 0;
    const radius = Math.floor(Number(action.featherRadius)) || 0;
    if (radius === 0) return scaled;
    return Algorithms.boxBlurChannel(scaled, width, height, radius, 1);
  }

  // 已应用选区 → 视图分辨率橙色覆盖层（按缩放比缓存，避免每次重绘全量模糊）。
  function drawSelectionActionOn(ctx, action) {
    let cache = selectionViewCache.get(action);
    if (!cache || cache.scale !== maskEditor.viewScale) {
      const alpha = selectionActionAlpha(action);
      if (!alpha) return;
      const width = action.width | 0;
      const height = action.height | 0;
      const viewW = Math.max(1, Math.round(width * maskEditor.viewScale));
      const viewH = Math.max(1, Math.round(height * maskEditor.viewScale));
      const canvas = document.createElement("canvas");
      canvas.width = viewW;
      canvas.height = viewH;
      const c2d = canvas.getContext("2d");
      const image = c2d.createImageData(viewW, viewH);
      const px = image.data;
      for (let vy = 0; vy < viewH; vy += 1) {
        const sy = Math.min(height - 1, Math.floor((vy * height) / viewH));
        for (let vx = 0; vx < viewW; vx += 1) {
          const sx = Math.min(width - 1, Math.floor((vx * width) / viewW));
          const a = alpha[sy * width + sx];
          if (!a) continue;
          const o = (vy * viewW + vx) * 4;
          px[o] = 255;
          px[o + 1] = 108;
          px[o + 2] = 74;
          px[o + 3] = a;
        }
      }
      c2d.putImageData(image, 0, 0);
      cache = { scale: maskEditor.viewScale, canvas };
      selectionViewCache.set(action, cache);
    }
    ctx.drawImage(cache.canvas, 0, 0);
  }

  // 导出：选区 Alpha（选中=255）映射为导出层透明度（255-A），destination-out 打洞，语义与笔画一致。
  function paintSelectionExport(ctx, action) {
    const alpha = selectionActionAlpha(action);
    if (!alpha) return;
    const width = action.width | 0;
    const height = action.height | 0;
    const temp = document.createElement("canvas");
    temp.width = width;
    temp.height = height;
    const tctx = temp.getContext("2d");
    const image = tctx.createImageData(width, height);
    const px = image.data;
    for (let i = 0; i < alpha.length; i += 1) {
      const o = i * 4;
      px[o + 3] = 255 - alpha[i];
    }
    tctx.putImageData(image, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(temp, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }

  function openMaskEditor() {
    if (state.creationMode !== "edit" || !state.editAssets.length || requestBusy() || maskEditor.open) return;
    const base = state.editAssets[0];
    if (state.mask.baseAssetId && state.mask.baseAssetId !== base.id) {
      state.mask.strokes = [];
      state.mask.inverted = false;
    }
    const image = new Image();
    image.onload = () => {
      maskEditor.baseImage = image;
      maskEditor.imgW = base.width;
      maskEditor.imgH = base.height;
      maskEditor.session = MaskModel.createMaskSession(state.mask.strokes);
      maskEditor.tool = "brush";
      maskEditor.previewOn = true;
      maskEditor.inverted = state.mask.inverted === true;
      maskEditor.drawing = null;
      maskEditor.selectionSession = SelectionModel.createSelectionSession(maskEditor.imgW, maskEditor.imgH);
      maskEditor.selectionBusy = false;
      maskEditor.lasso = null;
      stopSelectionAnts();
      resetSelectionLayer();
      maskEditor.open = true;
      selectSegment("#mask-tool-control", "brush");
      selectSegment("#mask-selection-tool-control", "");
      $("#mask-preview-toggle").setAttribute("aria-pressed", "true");
      $("#mask-invert-button").setAttribute("aria-pressed", String(maskEditor.inverted));
      $("#mask-editor-overlay").classList.remove("hidden");
      layoutMaskCanvas();
      updateMaskEditorButtons();
      updateSelectionToolUi();
      syncSelectionBitmap();
    };
    image.onerror = () => toast("无法载入主图", "error");
    image.src = base.originalUrl;
  }

  function closeMaskEditor() {
    maskEditor.open = false;
    maskEditor.drawing = null;
    maskEditor.session = null;
    maskEditor.panning = null;
    maskEditor.lasso = null;
    maskEditor.selectionSession = null;
    maskEditor.selectionBusy = false;
    stopSelectionAnts();
    resetSelectionLayer();
    releaseSelectionBitmap();
    $("#mask-editor-overlay").classList.add("hidden");
  }

  function layoutMaskCanvas() {
    const stage = $("#mask-editor-stage");
    const stageW = Math.max(80, stage.clientWidth - 32);
    const stageH = Math.max(80, stage.clientHeight - 32);
    maskEditor.fitScale = Math.max(0.01, Math.min(stageW / maskEditor.imgW, stageH / maskEditor.imgH, 1));
    maskEditor.viewScale = maskEditor.fitScale;
    sizeMaskCanvas();
  }

  function setMaskZoom(scale) {
    maskEditor.viewScale = Math.min(4, Math.max(maskEditor.fitScale, scale));
    sizeMaskCanvas();
  }

  function sizeMaskCanvas() {
    const canvas = $("#mask-canvas");
    const width = Math.max(1, Math.round(maskEditor.imgW * maskEditor.viewScale));
    const height = Math.max(1, Math.round(maskEditor.imgH * maskEditor.viewScale));
    canvas.width = width;
    canvas.height = height;
    maskEditor.overlay.width = width;
    maskEditor.overlay.height = height;
    renderFullOverlay();
    rebuildSelectionLayer();
    drawMaskEditor();
  }

  function paintStrokeOn(ctx, stroke, scale, mode) {
    // overlay：画笔上色、橡皮擦除；export：画笔打透明洞、橡皮恢复不透明（API 只读 Alpha）。
    const punching = mode === "export" ? stroke.tool === "brush" : stroke.tool === "eraser";
    ctx.globalCompositeOperation = punching ? "destination-out" : "source-over";
    const color = mode === "export" ? "rgba(0, 0, 0, 1)" : "rgba(255, 108, 74, 1)";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, stroke.radius * scale * 2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = stroke.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * scale, pts[0].y * scale, Math.max(0.5, stroke.radius * scale), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
    for (let i = 1; i < pts.length - 1; i += 1) {
      const midX = ((pts[i].x + pts[i + 1].x) / 2) * scale;
      const midY = ((pts[i].y + pts[i + 1].y) / 2) * scale;
      ctx.quadraticCurveTo(pts[i].x * scale, pts[i].y * scale, midX, midY);
    }
    ctx.lineTo(pts[pts.length - 1].x * scale, pts[pts.length - 1].y * scale);
    ctx.stroke();
  }

  function invertMaskCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 255;
      px[i + 1] = 108;
      px[i + 2] = 74;
      px[i + 3] = 255 - px[i + 3];
    }
    ctx.putImageData(data, 0, 0);
  }

  function renderFullOverlay(liveStroke = null) {
    const ctx = maskEditor.overlay.getContext("2d");
    ctx.clearRect(0, 0, maskEditor.overlay.width, maskEditor.overlay.height);
    if (!maskEditor.session) return;
    for (const action of maskEditor.session.strokes) {
      if (action && action.type === "selection") drawSelectionActionOn(ctx, action);
      else paintStrokeOn(ctx, action, maskEditor.viewScale, "overlay");
    }
    if (liveStroke) paintStrokeOn(ctx, liveStroke, maskEditor.viewScale, "overlay");
    if (maskEditor.inverted) invertMaskCanvas(maskEditor.overlay);
  }

  function drawMaskEditor() {
    const canvas = $("#mask-canvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (maskEditor.baseImage) ctx.drawImage(maskEditor.baseImage, 0, 0, canvas.width, canvas.height);
    if (maskEditor.previewOn) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(maskEditor.overlay, 0, 0);
      ctx.globalAlpha = 1;
    }
    // 活动选区：蓝色半透明填充 + 蚂蚁线边界
    if (selectionActive()) {
      ctx.globalAlpha = 0.32;
      ctx.drawImage(maskEditor.selectionCanvas, 0, 0);
      ctx.globalAlpha = 1;
      const b = maskEditor.selectionBoundary;
      if (b) {
        const tick = maskEditor.antsTick;
        for (let y = 0; y < b.height; y += 1) {
          for (let x = 0; x < b.width; x += 1) {
            if (!b.data[y * b.width + x]) continue;
            ctx.fillStyle = ((x + y + tick) & 7) < 4 ? "rgba(255, 255, 255, 0.95)" : "rgba(28, 100, 220, 0.95)";
            ctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }
    // 套索绘制中的路径预览
    if (maskEditor.lasso && maskEditor.lasso.points.length > 1) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.beginPath();
      const pts = maskEditor.lasso.points;
      ctx.moveTo(pts[0].x * maskEditor.viewScale, pts[0].y * maskEditor.viewScale);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x * maskEditor.viewScale, pts[i].y * maskEditor.viewScale);
      ctx.stroke();
      ctx.restore();
    }
  }

  function toImageCoords(event) {
    const rect = $("#mask-canvas").getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(maskEditor.imgW, Math.max(0, ((event.clientX - rect.left) / rect.width) * maskEditor.imgW)),
      y: Math.min(maskEditor.imgH, Math.max(0, ((event.clientY - rect.top) / rect.height) * maskEditor.imgH)),
    };
  }

  function updateMaskEditorButtons() {
    if (!maskEditor.session) return;
    $("#mask-undo-button").disabled = !maskEditor.session.canUndo();
    $("#mask-redo-button").disabled = !maskEditor.session.canRedo();
    $("#confirm-mask-button").disabled = maskEditor.session.isEmpty() || maskEditor.exporting;
  }

  function undoMaskStroke() {
    if (!maskEditor.session || !maskEditor.session.canUndo()) return;
    maskEditor.session.undo();
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
  }

  function redoMaskStroke() {
    if (!maskEditor.session || !maskEditor.session.canRedo()) return;
    maskEditor.session.redo();
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
  }

  function toggleMaskInvert() {
    if (!maskEditor.session || maskEditor.session.isEmpty()) return;
    maskEditor.inverted = !maskEditor.inverted;
    $("#mask-invert-button").setAttribute("aria-pressed", String(maskEditor.inverted));
    renderFullOverlay();
    drawMaskEditor();
  }

  function handleMaskPointerDown(event) {
    if (!maskEditor.open || event.button !== 0) return;
    const stage = $("#mask-editor-stage");
    if (maskEditor.spaceDown) {
      maskEditor.panning = { x: event.clientX, y: event.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
      return;
    }
    const point = toImageCoords(event);
    if (!point) return;
    event.preventDefault();
    if (maskEditor.tool === "wand") {
      handleWandClick(point, event);
      return;
    }
    if (maskEditor.tool === "lasso") {
      $("#mask-canvas").setPointerCapture(event.pointerId);
      maskEditor.lasso = {
        points: [point],
        mode: event.shiftKey ? "add" : event.altKey ? "subtract" : "replace",
      };
      drawMaskEditor();
      return;
    }
    $("#mask-canvas").setPointerCapture(event.pointerId);
    maskEditor.drawing = { tool: maskEditor.tool, radius: Number($("#mask-brush-range").value), points: [point] };
    if (maskEditor.inverted) renderFullOverlay(maskEditor.drawing);
    else paintStrokeOn(maskEditor.overlay.getContext("2d"), maskEditor.drawing, maskEditor.viewScale, "overlay");
    drawMaskEditor();
  }

  function handleMaskPointerMove(event) {
    if (!maskEditor.open) return;
    if (maskEditor.panning) {
      const stage = $("#mask-editor-stage");
      stage.scrollLeft = maskEditor.panning.scrollLeft - (event.clientX - maskEditor.panning.x);
      stage.scrollTop = maskEditor.panning.scrollTop - (event.clientY - maskEditor.panning.y);
      return;
    }
    if (maskEditor.lasso) {
      const point = toImageCoords(event);
      if (!point) return;
      const points = maskEditor.lasso.points;
      const last = points[points.length - 1];
      if (Math.abs(point.x - last.x) < 1 || Math.abs(point.y - last.y) < 1) return;
      points.push(point);
      drawMaskEditor();
      return;
    }
    if (!maskEditor.drawing) return;
    const point = toImageCoords(event);
    if (!point) return;
    const points = maskEditor.drawing.points;
    const last = points[points.length - 1];
    if (Math.abs(point.x - last.x) < 0.5 && Math.abs(point.y - last.y) < 0.5) return;
    points.push(point);
    if (maskEditor.inverted) {
      renderFullOverlay(maskEditor.drawing);
    } else {
      const ctx = maskEditor.overlay.getContext("2d");
      ctx.globalCompositeOperation = maskEditor.drawing.tool === "brush" ? "source-over" : "destination-out";
      ctx.strokeStyle = "rgba(255, 108, 74, 1)";
      ctx.lineWidth = Math.max(1, maskEditor.drawing.radius * maskEditor.viewScale * 2);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(last.x * maskEditor.viewScale, last.y * maskEditor.viewScale);
      ctx.lineTo(point.x * maskEditor.viewScale, point.y * maskEditor.viewScale);
      ctx.stroke();
    }
    drawMaskEditor();
  }

  async function handleMaskPointerUp(event) {
    if (maskEditor.panning) { maskEditor.panning = null; return; }
    if (maskEditor.lasso) {
      event.preventDefault();
      await finalizeLasso(event);
      return;
    }
    if (!maskEditor.drawing || !maskEditor.session) return;
    try { $("#mask-canvas").releasePointerCapture(event.pointerId); }
    catch { /* Pointer was never captured. */ }
    maskEditor.session.addStroke(maskEditor.drawing);
    maskEditor.drawing = null;
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
  }

  async function exportMask() {
    if (!maskEditor.session || maskEditor.session.isEmpty() || maskEditor.exporting) return;
    maskEditor.exporting = true;
    updateMaskEditorButtons();
    $("#confirm-mask-button").textContent = "导出中…";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = maskEditor.imgW;
      canvas.height = maskEditor.imgH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const action of maskEditor.session.strokes) {
        if (action && action.type === "selection") paintSelectionExport(ctx, action);
        else paintStrokeOn(ctx, action, 1, "export");
      }
      ctx.globalCompositeOperation = "source-over";
      if (maskEditor.inverted) invertMaskCanvas(canvas);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("导出失败"))), "image/png"));
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const base = state.editAssets[0];
      const result = unwrap(await api.saveMask(buffer, base.id));
      const previousMaskId = state.mask.maskAssetId;
      state.mask = { maskAssetId: result.maskAsset.id, baseAssetId: base.id, strokes: maskEditor.session.strokes, inverted: maskEditor.inverted, asset: result.maskAsset };
      if (previousMaskId && previousMaskId !== result.maskAsset.id) api.removeAsset(previousMaskId).catch(() => {});
      closeMaskEditor();
      setEditScope("mask");
      toast("编辑区域已确认");
    } catch (error) {
      toast(error.message || "编辑区域处理失败，请重新绘制", "error");
    } finally {
      maskEditor.exporting = false;
      $("#confirm-mask-button").textContent = "确认区域";
      updateMaskEditorButtons();
    }
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
          <div class="result-card-actions"><button type="button" data-action="save">下载</button><button type="button" data-action="reveal">文件位置</button><button type="button" data-action="continue">继续编辑</button></div>
        </div>`;
      card.querySelector('[data-action="save"]').addEventListener("click", async () => {
        try { const result = unwrap(await api.saveImage(image)); if (!result.canceled) toast("图片已保存"); }
        catch (error) { toast(error.message, "error"); }
      });
      card.querySelector('[data-action="reveal"]').addEventListener("click", async () => {
        try { unwrap(await api.revealImage(image.path)); }
        catch (error) { toast(error.message, "error"); }
      });
      card.querySelector('[data-action="continue"]').addEventListener("click", () => continueEditingFromImage(image));
      card.querySelector("img").addEventListener("dblclick", () => openImageViewer(image.previewUrl, entry.prompt, { compareSrc: editCompareSrc(entry), maskSrc: editMaskSrc(entry) }));
      grid.append(card);
    });
    $("#result-meta").textContent = `${entry.images.length} 张 · ${(entry.durationMs / 1000).toFixed(1)} 秒`;
    $("#result-header-actions").classList.remove("hidden");
    setResultMode("results-grid");
  }

  function friendlyError(error) {
    if (state.lastOperation === "edit" && (error.status === 404 || error.status === 405)) {
      return ["服务不支持图片编辑", "当前服务未提供 OpenAI 兼容的图片编辑接口 /images/edits。文字生图仍可使用；请联系服务提供方确认 GPT Image 2 编辑能力。"];
    }
    const messages = {
      authentication_error: ["API Key 无效", "服务拒绝了当前密钥，请检查连接设置。"],
      permission_error: ["没有模型权限", "当前密钥可能没有使用该模型的权限。"],
      rate_limit_error: ["请求过于频繁", "请求过多或额度不足，请稍后再试。"],
      server_error: ["服务暂时不可用", "远端服务出现异常，请稍后再试。"],
      timeout: ["请求等待超时", "可在连接设置中提高总超时时间，或在服务支持时尝试流式请求。"],
      cancelled: ["已取消", "这次请求已停止。"],
      busy: ["已有任务正在进行", "请等待当前生成或编辑完成，或先取消再试。"],
      duplicate_task: ["已有任务正在进行", "请等待当前生成或编辑完成，或先取消再试。"],
      invalid_asset: ["素材不可用", "导入的图片不存在或已被移除，请重新添加。"],
      too_many_images: ["图片数量超出上限", "每次编辑最多添加 16 张图片。"],
      unsupported_format: ["图片格式不支持", "仅支持 PNG、JPEG 和 WebP，请先转换格式。"],
      file_too_large: ["图片文件过大", "单张图片不能超过 50 MB，请压缩后重试。"],
      decode_error: ["无法读取此图片", "文件可能已损坏，请重新添加。"],
      mask_size_mismatch: ["编辑区域尺寸不一致", "编辑区域与主图尺寸不一致，请重新绘制。"],
      mask_conversion_failed: ["编辑区域处理失败", "请重新绘制编辑区域后再试。"],
      moderation_blocked: ["未通过安全检查", "请求未通过安全检查，请调整提示词或输入图片。"],
      content_policy_violation: ["未通过安全检查", "请求未通过安全检查，请调整提示词或输入图片。"],
      image_generation_user_error: ["请求参数需要调整", "请根据服务返回的信息调整提示词或参数。"],
      unsafe_image_url: ["图片地址不安全", "兼容接口返回了不安全的图片地址。"],
      missing_api_key: ["尚未加载密钥", "请前往设置输入 API Key，或完成旧版密钥迁移。"],
      invalid_response: ["响应格式不兼容", "服务已响应，但没有返回客户端可读取的图片。"],
    };
    const fallbackTitle = state.lastOperation === "edit" ? "编辑没有完成" : "生成没有完成";
    return messages[error.code] || [fallbackTitle, error.message || "请稍后重试。"];
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
    if (requestBusy()) return;
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
    state.activeOperation = "generate";
    state.lastOperation = "generate";
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
      refreshConnectionCapabilities();
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
    $("#favorite-filter-button").classList.toggle("active", state.favoriteOnly);
    $("#favorite-filter-button").textContent = state.favoriteOnly ? "★ 只看收藏" : "☆ 只看收藏";
    const list = $("#history-list");
    list.innerHTML = "";
    $("#history-empty").classList.toggle("hidden", filtered.length > 0);
    list.classList.toggle("hidden", filtered.length === 0);

    filtered.forEach((entry) => {
      const image = entry.images?.[0];
      const isEditEntry = entry.operation === "edit";
      const card = document.createElement("article");
      card.className = "history-entry";
      const tags = historyBadges(entry).map((tag) => `<span class="image-badge">${escapeHtml(tag)}</span>`).join("");
      const operationBadge = isEditEntry ? `<span class="image-badge operation">✎ ${entry.editMode === "mask" ? "局部编辑" : "整体编辑"} · ${entry.inputs?.length || 0} 张输入</span>` : "";
      card.innerHTML = `
        <div class="history-image-wrap">
          ${image ? `<img src="${escapeHtml(image.previewUrl)}" alt="${escapeHtml(entry.prompt.slice(0, 80))}" />` : ""}
          <div class="history-image-top"><span>${operationBadge}<span class="image-badge">▣ ${escapeHtml(entry.parameters?.size || "自动")}</span></span><span>${entry.favorite ? '<span class="image-badge favorite">★ 收藏</span>' : '<span class="image-badge complete">已完成</span>'}</span></div>
          <div class="history-image-tags">${tags}</div>
        </div>
        <div class="history-copy">
          <p>${escapeHtml(entry.prompt)}</p>
          <div class="history-card-footer"><span>${escapeHtml(formatDate(entry.createdAt))}</span><button class="history-menu-button" type="button" aria-label="更多操作">···</button></div>
        </div>
        <div class="history-card-menu hidden">
          <button type="button" data-action="reuse">复用提示词</button>
          <button type="button" data-action="save-prompt">存入提示词库</button>
          ${isEditEntry ? '<button type="button" data-action="reedit">按原参数再次编辑</button>' : '<button type="button" data-action="regenerate">再生成一张</button>'}
          <button type="button" data-action="continue-edit">继续编辑</button>
          <button type="button" data-action="copy">复制原图到剪贴板</button>
          <button type="button" data-action="favorite">${entry.favorite ? "取消收藏" : "收藏"}</button>
          <button class="danger" type="button" data-action="delete">删除</button>
        </div>`;
      const menu = card.querySelector(".history-card-menu");
      const menuButton = card.querySelector(".history-menu-button");
      if (image) card.querySelector(".history-image-wrap > img").addEventListener("dblclick", () => openImageViewer(image.previewUrl, entry.prompt, { compareSrc: editCompareSrc(entry), maskSrc: editMaskSrc(entry) }));
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
        if (action === "save-prompt") await savePromptToLibrary(entry.prompt, entry.id);
        if (action === "regenerate") { restoreEntryParameters(entry); $("#count-input").value = 1; updateGenerationState(); await generate({ forceOne: true }); }
        if (action === "reedit") await restoreEditFromHistory(entry);
        if (action === "continue-edit") continueEditingFromImage(image);
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

  async function loadPrompts() {
    try { state.prompts = unwrap(await api.listPrompts()); renderPrompts(); }
    catch (error) { toast(error.message, "error"); }
  }

  function promptMatchesFilter(entry) {
    if (state.promptFilter.category && entry.category !== state.promptFilter.category) return false;
    const tokens = state.promptFilter.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const haystack = `${entry.text} ${entry.category}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  function renderPromptFilterRow(categories) {
    const row = $("#prompt-filter-row");
    const active = state.promptFilter.category;
    const chips = [{ label: "全部", value: "", count: state.prompts.length }]
      .concat(categories.map((name) => ({ label: name, value: name, count: state.prompts.filter((entry) => entry.category === name).length })));
    row.innerHTML = chips.map((chip) => `
      <button class="prompt-filter-chip${chip.value === active ? " active" : ""}" type="button" data-category="${escapeHtml(chip.value)}">
        ${escapeHtml(chip.label)}<span>${chip.count}</span>
      </button>`).join("");
    row.classList.toggle("hidden", state.prompts.length === 0);
    $$("#prompt-filter-row .prompt-filter-chip").forEach((chip) => chip.addEventListener("click", () => {
      state.promptFilter.category = chip.dataset.category;
      renderPrompts();
    }));
  }

  function renderPrompts() {
    const list = $("#prompts-list");
    list.innerHTML = "";
    const categories = [...new Set(state.prompts.map((entry) => entry.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    if (state.promptFilter.category && !categories.includes(state.promptFilter.category)) state.promptFilter.category = "";
    renderPromptFilterRow(categories);
    $("#prompt-category-options").innerHTML = categories
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join("");
    const filtered = state.prompts.filter(promptMatchesFilter);
    const hasAny = state.prompts.length > 0;
    $("#prompts-empty").classList.toggle("hidden", hasAny);
    $("#prompts-nomatch").classList.toggle("hidden", !(hasAny && filtered.length === 0));
    list.classList.toggle("hidden", filtered.length === 0);
    const sorted = [...filtered].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    sorted.forEach((entry) => {
      const card = document.createElement("article");
      card.className = "prompt-entry";
      card.innerHTML = `
        <p class="prompt-entry-text">${escapeHtml(entry.text)}</p>
        <div class="prompt-entry-footer">
          <span class="prompt-entry-category">${escapeHtml(entry.category || "未分类")}</span>
          <span class="prompt-entry-time">${escapeHtml(formatDate(entry.updatedAt || entry.createdAt))}</span>
          <button class="history-menu-button" type="button" aria-label="更多操作">···</button>
        </div>
        <div class="history-card-menu hidden">
          <button type="button" data-action="use">用于生成</button>
          <button type="button" data-action="copy">复制文本</button>
          <button type="button" data-action="edit">编辑</button>
          <button class="danger" type="button" data-action="delete">删除</button>
        </div>`;
      const menu = card.querySelector(".history-card-menu");
      const menuButton = card.querySelector(".history-menu-button");
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
        if (action === "use") usePromptEntry(entry);
        if (action === "copy") {
          try { await navigator.clipboard.writeText(entry.text || ""); toast("提示词已复制"); }
          catch { toast("复制失败，请手动选择文本", "error"); }
        }
        if (action === "edit") openPromptDialog(entry);
        if (action === "delete" && window.confirm("删除这条提示词？")) {
          try { unwrap(await api.deletePrompt(entry.id)); await loadPrompts(); toast("提示词已删除"); }
          catch (error) { toast(error.message, "error"); }
        }
      });
      list.append(card);
    });
  }

  function usePromptEntry(entry) {
    // 先切模式（会恢复各模式记忆并覆盖输入框），再填入提示词，最后同步模式记忆防止来回切换丢失
    setCreationMode("generate");
    $("#prompt-input").value = entry.text || "";
    ensureModeMemory().generate.prompt = $("#prompt-input").value;
    updateGenerationState();
    navigate("generate");
    const promptInput = $("#prompt-input");
    promptInput.focus();
    promptInput.setSelectionRange(0, 0);
    promptInput.scrollTop = 0;
  }

  async function savePromptToLibrary(text, sourceHistoryId = null) {
    const trimmed = String(text || "").trim();
    if (!trimmed) { toast("提示词为空，先写点什么再存吧", "error"); return; }
    try {
      const existing = unwrap(await api.listPrompts());
      if (existing.some((entry) => entry.text === trimmed)) { toast("提示词库已有这条内容"); return; }
      unwrap(await api.addPrompt({ text: trimmed, category: "", sourceHistoryId }));
      await loadPrompts();
      toast("已存入提示词库");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function openPromptDialog(entry = null) {
    state.editingPromptId = entry ? entry.id : null;
    $("#prompt-dialog-title").textContent = entry ? "编辑提示词" : "新建提示词";
    $("#prompt-dialog-text").value = entry ? entry.text : "";
    $("#prompt-dialog-category").value = entry && entry.category !== "未分类" ? entry.category : "";
    $("#prompt-dialog-error").classList.add("hidden");
    $("#prompt-dialog-overlay").classList.remove("hidden");
    $("#prompt-dialog-text").focus();
  }

  function closePromptDialog() {
    $("#prompt-dialog-overlay").classList.add("hidden");
    state.editingPromptId = null;
  }

  async function savePromptDialog() {
    const text = $("#prompt-dialog-text").value.trim();
    const errorNode = $("#prompt-dialog-error");
    if (!text) {
      errorNode.textContent = "正文不能为空";
      errorNode.classList.remove("hidden");
      return;
    }
    const category = $("#prompt-dialog-category").value.trim();
    try {
      if (state.editingPromptId) {
        const updated = unwrap(await api.updatePrompt(state.editingPromptId, { text, category }));
        if (!updated) throw new Error("这条提示词已被删除");
        toast("提示词已更新");
      } else {
        unwrap(await api.addPrompt({ text, category, sourceHistoryId: null }));
        toast("已存入提示词库");
      }
      closePromptDialog();
      await loadPrompts();
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.classList.remove("hidden");
    }
  }

  function logTypeLabel(type) {
    if (type === "connection_test") return "连接测试";
    if (type === "image_edit") return "图片编辑";
    return "图片生成";
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
    const [configResult, historyResult, promptsResult, appInfoResult] = await Promise.all([api.loadConfig(), api.listHistory(), api.listPrompts(), api.getAppInfo()]);
    state.config = unwrap(configResult);
    state.history = unwrap(historyResult);
    state.prompts = unwrap(promptsResult);
    const appInfo = unwrap(appInfoResult);
    $("#version-label").textContent = `V${appInfo.version}`;
    renderConnectionProfiles();
    populateConnectionEditor(activeProfile());
    updateConnectionStatus();
    renderHistory();
    renderPrompts();
    updateFormatDependencies();
    setCreationMode(localStorage.getItem("emberimage-creation-mode") === "edit" ? "edit" : "generate", { initial: true });
    updateGenerationState();
  }

  window.addEventListener("resize", () => {
    applyWindowScale();
    // 固定定位的右键菜单在窗口尺寸变化后可能落到视口外，直接收起
    hideAssetContextMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".history-entry, .prompt-entry")) {
      $$(".history-card-menu").forEach((node) => node.classList.add("hidden"));
      $$(".history-menu-button").forEach((node) => node.classList.remove("active"));
    }
    if (!event.target.closest(".context-menu")) hideAssetContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (maskEditor.open && selectionActive()) {
      cancelSelection();
      return;
    }
    if (!$("#prompt-dialog-overlay").classList.contains("hidden")) {
      closePromptDialog();
      return;
    }
    if (!$("#bg-removal-overlay").classList.contains("hidden")) {
      closeBgRemoval();
      return;
    }
    closeImageViewer();
    closeSizeDialog();
    closeMaskEditor();
    $("#request-log-overlay").classList.add("hidden");
  });

  $$("[data-view-target]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.viewTarget)));
  $("#open-settings-button").addEventListener("click", () => navigate("settings"));
  $("#prompt-input").addEventListener("input", updateGenerationState);
  $("#clear-prompt").addEventListener("click", () => { $("#prompt-input").value = ""; updateGenerationState(); $("#prompt-input").focus(); });
  $("#restore-prompt").addEventListener("click", () => {
    if (state.creationMode === "edit") {
      $("#prompt-input").value = localStorage.getItem("emberimage-last-edit-prompt") || state.history.find((entry) => entry.operation === "edit")?.prompt || "";
    } else {
      $("#prompt-input").value = localStorage.getItem("emberimage-last-prompt") || state.history[0]?.prompt || "";
    }
    updateGenerationState();
  });
  $$("#prompt-style-row .style-chip").forEach((button) => button.addEventListener("click", () => {
    const prompt = $("#prompt-input");
    prompt.value = `${prompt.value.trim()}${prompt.value.trim() ? "，" : ""}${button.dataset.style}`;
    updateGenerationState();
  }));
  $$("#prompt-template-row .style-chip").forEach((button) => button.addEventListener("click", () => {
    const prompt = $("#prompt-input");
    prompt.value = `${prompt.value.trim()}${prompt.value.trim() ? "，" : ""}${button.dataset.template}`;
    updateGenerationState();
  }));
  $$("#creation-mode-control button").forEach((button) => button.addEventListener("click", () => setCreationMode(button.dataset.value)));
  $$("#edit-scope-control button").forEach((button) => button.addEventListener("click", () => setEditScope(button.dataset.value)));
  $("#mask-clear-button").addEventListener("click", async () => {
    if (!window.confirm("清除已标记的编辑区域？")) return;
    await discardMask();
  });
  $("#open-mask-editor-button").addEventListener("click", openMaskEditor);
  $("#mask-redraw-button").addEventListener("click", openMaskEditor);
  $$("#mask-tool-control button").forEach((button) => button.addEventListener("click", () => {
    if (selectionActive()) return;
    maskEditor.tool = button.dataset.value;
    selectSegment("#mask-tool-control", maskEditor.tool);
    updateSelectionToolUi();
  }));
  $$("#mask-selection-tool-control button").forEach((button) => button.addEventListener("click", () => {
    maskEditor.tool = button.dataset.value;
    selectSegment("#mask-selection-tool-control", maskEditor.tool);
    updateSelectionToolUi();
  }));
  $("#mask-wand-tolerance-range").addEventListener("input", () => {
    maskEditor.wandTolerance = Number($("#mask-wand-tolerance-range").value);
    $("#mask-wand-tolerance-value").textContent = String(maskEditor.wandTolerance);
  });
  $$("#mask-wand-scope-control button").forEach((button) => button.addEventListener("click", () => {
    maskEditor.wandContiguous = button.dataset.value !== "global";
    selectSegment("#mask-wand-scope-control", button.dataset.value);
  }));
  $("#mask-feather-range").addEventListener("input", () => {
    $("#mask-feather-value").textContent = $("#mask-feather-range").value;
  });
  $("#mask-selection-invert-button").addEventListener("click", invertSelection);
  $("#mask-selection-cancel-button").addEventListener("click", cancelSelection);
  $("#mask-selection-apply-button").addEventListener("click", applySelectionAsMask);
  $("#add-prompt-button").addEventListener("click", () => openPromptDialog());
  $("#empty-add-prompt-button").addEventListener("click", () => openPromptDialog());
  $("#prompts-search").addEventListener("input", () => {
    state.promptFilter.query = $("#prompts-search").value.trim();
    renderPrompts();
  });
  $("#clear-prompt-filter-button").addEventListener("click", () => {
    state.promptFilter = { query: "", category: "" };
    $("#prompts-search").value = "";
    renderPrompts();
  });
  $("#save-prompt-to-library").addEventListener("click", () => savePromptToLibrary($("#prompt-input").value));
  $("#open-prompt-library").addEventListener("click", () => navigate("prompts"));
  $("#close-prompt-dialog-button").addEventListener("click", closePromptDialog);
  $("#cancel-prompt-dialog-button").addEventListener("click", closePromptDialog);
  $("#save-prompt-dialog-button").addEventListener("click", savePromptDialog);
  $("#prompt-dialog-category").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); savePromptDialog(); }
  });
  $("#prompt-dialog-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); savePromptDialog(); }
  });
  $("#prompt-dialog-overlay").addEventListener("mousedown", (event) => {
    if (event.target === event.currentTarget) closePromptDialog();
  });
  $("#mask-auto-subject-button").addEventListener("click", autoSubjectSelection);
  $("#close-bg-removal-button").addEventListener("click", closeBgRemoval);
  $("#bg-removal-import-button").addEventListener("click", importBgRemovalAsAsset);
  $("#bg-removal-export-button").addEventListener("click", exportBgRemovalPng);
  $("#image-viewer-remove-bg-button").addEventListener("click", () => {
    if (state.viewerRemoveBgAsset) removeBackgroundFlow(state.viewerRemoveBgAsset);
  });
  $("#mask-brush-range").addEventListener("input", () => { $("#mask-brush-value").textContent = $("#mask-brush-range").value; });
  $("#mask-undo-button").addEventListener("click", undoMaskStroke);
  $("#mask-redo-button").addEventListener("click", redoMaskStroke);
  $("#mask-invert-button").addEventListener("click", toggleMaskInvert);
  $("#mask-clear-canvas-button").addEventListener("click", () => {
    if (!maskEditor.session || maskEditor.session.isEmpty()) return;
    if (!window.confirm("清空全部编辑区域？")) return;
    maskEditor.session.clear();
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
  });
  $("#mask-preview-toggle").addEventListener("click", () => {
    maskEditor.previewOn = !maskEditor.previewOn;
    $("#mask-preview-toggle").setAttribute("aria-pressed", String(maskEditor.previewOn));
    drawMaskEditor();
  });
  $("#mask-fit-button").addEventListener("click", () => setMaskZoom(maskEditor.fitScale));
  $("#mask-100-button").addEventListener("click", () => setMaskZoom(1));
  $("#close-mask-editor-button").addEventListener("click", closeMaskEditor);
  $("#cancel-mask-editor-button").addEventListener("click", closeMaskEditor);
  $("#confirm-mask-button").addEventListener("click", exportMask);
  const maskCanvas = $("#mask-canvas");
  maskCanvas.addEventListener("pointerdown", handleMaskPointerDown);
  maskCanvas.addEventListener("pointermove", handleMaskPointerMove);
  maskCanvas.addEventListener("pointerup", handleMaskPointerUp);
  maskCanvas.addEventListener("pointercancel", handleMaskPointerUp);
  $("#mask-editor-stage").addEventListener("wheel", (event) => {
    if (!maskEditor.open) return;
    event.preventDefault();
    setMaskZoom(maskEditor.viewScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (!maskEditor.open || event.code !== "Space") return;
    if (event.target && ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
    event.preventDefault();
    maskEditor.spaceDown = true;
    $("#mask-canvas").style.cursor = "grab";
  });
  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    maskEditor.spaceDown = false;
    maskEditor.panning = null;
    $("#mask-canvas").style.cursor = "";
  });
  window.addEventListener("keydown", (event) => {
    if (!maskEditor.open) return;
    if (event.target && ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectionActive()) {
      event.preventDefault();
      applySelectionAsMask();
      return;
    }
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      const range = $("#mask-brush-range");
      const next = Math.min(Number(range.max), Math.max(Number(range.min), Number(range.value) + (event.key === "]" ? 10 : -10)));
      range.value = String(next);
      $("#mask-brush-value").textContent = range.value;
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redoMaskStroke();
      else undoMaskStroke();
    }
  });
  $("#upload-zone").addEventListener("click", () => {
    if (state.isImportingAssets || state.editAssets.length >= Validation.MAX_EDIT_IMAGES) return;
    pickAndImportAssets();
  });
  $("#upload-zone").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (state.isImportingAssets || state.editAssets.length >= Validation.MAX_EDIT_IMAGES) return;
    pickAndImportAssets();
  });
  const assetPanel = $("#asset-panel");
  ["dragenter", "dragover"].forEach((type) => assetPanel.addEventListener(type, (event) => {
    if (state.creationMode !== "edit" || !event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    assetPanel.classList.add("drag-over");
  }));
  assetPanel.addEventListener("dragleave", (event) => {
    if (assetPanel.contains(event.relatedTarget)) return;
    assetPanel.classList.remove("drag-over");
  });
  assetPanel.addEventListener("drop", (event) => {
    if (state.creationMode !== "edit") return;
    event.preventDefault();
    assetPanel.classList.remove("drag-over");
    importClipboardOrDropFiles(event.dataTransfer?.files);
  });
  document.addEventListener("paste", (event) => {
    if (state.creationMode !== "edit") return;
    if (!$("#view-generate").classList.contains("active")) return;
    if (!event.clipboardData?.files?.length) return;
    event.preventDefault();
    importClipboardOrDropFiles(event.clipboardData.files);
  });
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
  $("#generate-button").addEventListener("click", () => (state.creationMode === "edit" ? edit() : generate()));
  $("#retry-button").addEventListener("click", () => (state.lastOperation === "edit" ? edit() : generate()));
  $("#cancel-button").addEventListener("click", () => {
    if (!state.currentTaskId) return;
    if (state.activeOperation === "edit") api.cancelEdit(state.currentTaskId);
    else api.cancelGeneration(state.currentTaskId);
  });
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
  $("#image-viewer-image").addEventListener("load", updateViewerMaskOverlay);
  window.addEventListener("resize", () => {
    if ($("#image-viewer").classList.contains("hidden")) return;
    updateViewerMaskOverlay();
  });
  $$("#image-viewer-compare button").forEach((button) => button.addEventListener("click", () => setViewerImage(button.dataset.value)));
  $("#image-viewer-mask-toggle").addEventListener("click", () => {
    state.viewerMaskOn = !state.viewerMaskOn;
    $("#image-viewer-mask-toggle").setAttribute("aria-pressed", String(state.viewerMaskOn));
    renderViewerImage();
  });
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
