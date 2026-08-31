(function bootstrapEmberImage() {
  "use strict";

  const api = window.imageStudio;
  const Validation = window.ImageStudioValidation;
  const MaskModel = window.EmberImageMaskModel;
  const PresetCatalog = window.EmberImagePresets || { categories: [], presets: [] };
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
    exampleCategory: "all",
    selectedExampleId: null,
    creationMode: "generate",
    editAssets: [],
    editScope: "full",
    mask: { maskAssetId: null, baseAssetId: null, strokes: [], asset: null },
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
    if (viewName === "examples") renderExamples();
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
    state.mask = { maskAssetId: null, baseAssetId: null, strokes: [], asset: null };
    renderMaskStatus();
    updateGenerationState();
    if (id) await api.removeAsset(id).catch(() => {});
  }

  function confirmDiscardMask() {
    if (!state.mask.maskAssetId) return true;
    return window.confirm("更换主图将清除已标记的编辑区域，是否继续？");
  }

  function renderAssets() {
    const grid = $("#asset-grid");
    grid.innerHTML = "";
    state.editAssets.forEach((asset, index) => {
      const card = document.createElement("article");
      card.className = `asset-card${index === 0 ? " main" : ""}`;
      card.dataset.assetId = asset.id;
      card.innerHTML = `
        <img src="${escapeHtml(asset.thumbnailUrl)}" alt="${escapeHtml(asset.fileName)}" />
        <span class="asset-role">${index === 0 ? "主图" : `参考 ${index + 1}`}</span>
        <div class="asset-card-info"><strong>${escapeHtml(asset.fileName)}</strong><small>${asset.width}×${asset.height} · ${formatBytes(asset.bytes)}</small></div>
        <div class="asset-card-actions">
          <button type="button" data-action="move-left" aria-label="向前移动">←</button>
          <button type="button" data-action="move-right" aria-label="向后移动">→</button>
          <button type="button" class="danger" data-action="remove" aria-label="移除">✕</button>
        </div>`;
      card.querySelector('[data-action="move-left"]').disabled = index === 0;
      card.querySelector('[data-action="move-right"]').disabled = index === state.editAssets.length - 1;
      card.querySelector('[data-action="move-left"]').addEventListener("click", () => moveAsset(index, -1));
      card.querySelector('[data-action="move-right"]').addEventListener("click", () => moveAsset(index, 1));
      card.querySelector('[data-action="remove"]').addEventListener("click", () => removeAssetAt(index));
      card.querySelector("img").addEventListener("dblclick", () => openImageViewer(asset.originalUrl, asset.fileName));
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

  async function moveAsset(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.editAssets.length) return;
    if ((index === 0 || target === 0) && !confirmDiscardMask()) return;
    if ((index === 0 || target === 0) && state.mask.maskAssetId) await discardMask();
    const [asset] = state.editAssets.splice(index, 1);
    state.editAssets.splice(target, 0, asset);
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

  function exampleCategoryLabel(categoryId) {
    return PresetCatalog.categories.find((category) => category.id === categoryId)?.label || "样例";
  }

  function exampleParameterBadges(preset) {
    const parameters = preset.parameters || {};
    return [
      displaySize(parameters.size || "auto"),
      `${qualityLabels[parameters.quality] || parameters.quality || "自动"}质量`,
      backgroundLabels[parameters.background] || parameters.background,
      String(parameters.outputFormat || "png").toUpperCase(),
      `${Number(parameters.n) || 1} 张`,
    ].filter(Boolean);
  }

  function filteredExamples() {
    const query = $("#example-search").value.trim().toLowerCase();
    return PresetCatalog.presets.filter((preset) => {
      if (state.exampleCategory !== "all" && preset.category !== state.exampleCategory) return false;
      if (!query) return true;
      return `${preset.title} ${preset.summary} ${preset.tags.join(" ")} ${preset.prompt}`.toLowerCase().includes(query);
    });
  }

  function renderExampleCategories() {
    const list = $("#example-category-list");
    list.innerHTML = "";
    PresetCatalog.categories.forEach((category) => {
      const count = category.id === "all"
        ? PresetCatalog.presets.length
        : PresetCatalog.presets.filter((preset) => preset.category === category.id).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.exampleCategory === category.id ? "active" : "";
      button.innerHTML = `<span>${escapeHtml(category.label)}</span><small>${count}</small>`;
      button.addEventListener("click", () => {
        state.exampleCategory = category.id;
        renderExamples();
      });
      list.append(button);
    });
  }

  function openExampleDetail(preset) {
    state.selectedExampleId = preset.id;
    $("#example-detail-image").src = preset.imagePath;
    $("#example-detail-image").alt = preset.title;
    $("#example-detail-category").textContent = exampleCategoryLabel(preset.category);
    $("#example-detail-title").textContent = preset.title;
    $("#example-detail-summary").textContent = preset.summary;
    $("#example-detail-prompt").textContent = preset.prompt;
    $("#example-detail-parameters").innerHTML = exampleParameterBadges(preset)
      .map((label) => `<span>${escapeHtml(label)}</span>`)
      .join("");
    $("#example-detail-overlay").classList.remove("hidden");
  }

  function closeExampleDetail() {
    state.selectedExampleId = null;
    $("#example-detail-overlay").classList.add("hidden");
    $("#example-detail-image").removeAttribute("src");
  }

  function useExample(preset) {
    closeExampleDetail();
    setCreationMode("generate");
    restoreEntryParameters(preset);
    toast(`已套用“${preset.title}”的提示词和参数`);
  }

  function renderExamples() {
    renderExampleCategories();
    const examples = filteredExamples();
    const list = $("#example-list");
    list.innerHTML = "";
    $("#example-summary").textContent = `${examples.length} 个可复用样例`;
    $("#examples-empty").classList.toggle("hidden", examples.length > 0);
    list.classList.toggle("hidden", examples.length === 0);

    examples.forEach((preset) => {
      const card = document.createElement("article");
      card.className = "example-card";
      const tags = preset.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
      const parameters = exampleParameterBadges(preset).slice(0, 3).map((label) => `<span>${escapeHtml(label)}</span>`).join("");
      card.innerHTML = `
        <button class="example-card-visual" type="button" aria-label="查看${escapeHtml(preset.title)}样例详情">
          <img src="${escapeHtml(preset.imagePath)}" alt="${escapeHtml(preset.title)}" />
          <span class="example-card-category">${escapeHtml(exampleCategoryLabel(preset.category))}</span>
          <span class="example-card-open">查看详情 ↗</span>
        </button>
        <div class="example-card-content">
          <div class="example-card-title-row"><div><h3>${escapeHtml(preset.title)}</h3><p>${escapeHtml(preset.summary)}</p></div><button type="button" data-action="use">使用</button></div>
          <div class="example-card-tags">${tags}</div>
          <p class="example-card-prompt">${escapeHtml(preset.prompt)}</p>
          <div class="example-card-parameters">${parameters}</div>
        </div>`;
      card.querySelector(".example-card-visual").addEventListener("click", () => openExampleDetail(preset));
      card.querySelector('[data-action="use"]').addEventListener("click", () => useExample(preset));
      list.append(card);
    });
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

  async function renderViewerImage() {
    const img = $("#image-viewer-image");
    const baseSrc = state.viewerWhich === "original" && state.viewerCompareSrc ? state.viewerCompareSrc : state.viewerResultSrc;
    if (!baseSrc) return;
    if (!state.viewerMaskOn || !state.viewerMaskSrc) { img.src = baseSrc; return; }
    try {
      const [baseImage, maskImage] = await Promise.all([loadImageElement(baseSrc), loadImageElement(state.viewerMaskSrc)]);
      const cap = 2048;
      const scale = Math.min(1, cap / Math.max(baseImage.naturalWidth, baseImage.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(baseImage.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(baseImage.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
      // Mask 中完全透明（Alpha=0）的像素是编辑区域，叠合时重着色为半透明橙色。
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const maskCtx = maskCanvas.getContext("2d");
      maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);
      const pixelData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
      const px = pixelData.data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) { px[i] = 255; px[i + 1] = 108; px[i + 2] = 74; px[i + 3] = 140; }
        else { px[i + 3] = 0; }
      }
      maskCtx.putImageData(pixelData, 0, 0);
      ctx.drawImage(maskCanvas, 0, 0);
      img.src = canvas.toDataURL("image/png");
    } catch {
      img.src = baseSrc;
    }
  }

  function openImageViewer(src, caption = "", options = {}) {
    if (!src) return;
    state.viewerResultSrc = src;
    state.viewerCompareSrc = options.compareSrc || null;
    state.viewerMaskSrc = options.maskSrc || null;
    state.viewerMaskOn = false;
    state.viewerWhich = "result";
    $("#image-viewer-caption").textContent = caption;
    $("#image-viewer-compare").classList.toggle("hidden", !state.viewerCompareSrc);
    $$("#image-viewer-compare button").forEach((button) => button.classList.toggle("active", button.dataset.value === "result"));
    $("#image-viewer-mask-toggle").classList.toggle("hidden", !state.viewerMaskSrc);
    $("#image-viewer-mask-toggle").setAttribute("aria-pressed", "false");
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
    $("#image-viewer-compare").classList.add("hidden");
    $("#image-viewer-mask-toggle").classList.add("hidden");
    state.viewerResultSrc = null;
    state.viewerCompareSrc = null;
    state.viewerMaskSrc = null;
    state.viewerMaskOn = false;
    state.viewerWhich = "result";
  }

  function editCompareSrc(entry) {
    return entry.operation === "edit" ? entry.inputs?.[0]?.previewUrl || null : null;
  }

  function editMaskSrc(entry) {
    return entry.operation === "edit" ? entry.mask?.previewUrl || null : null;
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
    drawing: null,
    spaceDown: false,
    panning: null,
    overlay: document.createElement("canvas"),
  };

  function openMaskEditor() {
    if (state.creationMode !== "edit" || !state.editAssets.length || requestBusy() || maskEditor.open) return;
    const base = state.editAssets[0];
    if (state.mask.baseAssetId && state.mask.baseAssetId !== base.id) state.mask.strokes = [];
    const image = new Image();
    image.onload = () => {
      maskEditor.baseImage = image;
      maskEditor.imgW = base.width;
      maskEditor.imgH = base.height;
      maskEditor.session = MaskModel.createMaskSession(state.mask.strokes);
      maskEditor.tool = "brush";
      maskEditor.previewOn = true;
      maskEditor.drawing = null;
      maskEditor.open = true;
      selectSegment("#mask-tool-control", "brush");
      $("#mask-preview-toggle").setAttribute("aria-pressed", "true");
      $("#mask-editor-overlay").classList.remove("hidden");
      layoutMaskCanvas();
      updateMaskEditorButtons();
    };
    image.onerror = () => toast("无法载入主图", "error");
    image.src = base.originalUrl;
  }

  function closeMaskEditor() {
    maskEditor.open = false;
    maskEditor.drawing = null;
    maskEditor.session = null;
    maskEditor.panning = null;
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

  function renderFullOverlay() {
    const ctx = maskEditor.overlay.getContext("2d");
    ctx.clearRect(0, 0, maskEditor.overlay.width, maskEditor.overlay.height);
    if (!maskEditor.session) return;
    for (const stroke of maskEditor.session.strokes) paintStrokeOn(ctx, stroke, maskEditor.viewScale, "overlay");
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
    $("#mask-canvas").setPointerCapture(event.pointerId);
    maskEditor.drawing = { tool: maskEditor.tool, radius: Number($("#mask-brush-range").value), points: [point] };
    paintStrokeOn(maskEditor.overlay.getContext("2d"), maskEditor.drawing, maskEditor.viewScale, "overlay");
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
    if (!maskEditor.drawing) return;
    const point = toImageCoords(event);
    if (!point) return;
    const points = maskEditor.drawing.points;
    const last = points[points.length - 1];
    if (Math.abs(point.x - last.x) < 0.5 && Math.abs(point.y - last.y) < 0.5) return;
    points.push(point);
    const ctx = maskEditor.overlay.getContext("2d");
    ctx.globalCompositeOperation = maskEditor.drawing.tool === "brush" ? "source-over" : "destination-out";
    ctx.strokeStyle = "rgba(255, 108, 74, 1)";
    ctx.lineWidth = Math.max(1, maskEditor.drawing.radius * maskEditor.viewScale * 2);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(last.x * maskEditor.viewScale, last.y * maskEditor.viewScale);
    ctx.lineTo(point.x * maskEditor.viewScale, point.y * maskEditor.viewScale);
    ctx.stroke();
    drawMaskEditor();
  }

  function handleMaskPointerUp(event) {
    if (maskEditor.panning) { maskEditor.panning = null; return; }
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
      for (const stroke of maskEditor.session.strokes) paintStrokeOn(ctx, stroke, 1, "export");
      ctx.globalCompositeOperation = "source-over";
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("导出失败"))), "image/png"));
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const base = state.editAssets[0];
      const result = unwrap(await api.saveMask(buffer, base.id));
      const previousMaskId = state.mask.maskAssetId;
      state.mask = { maskAssetId: result.maskAsset.id, baseAssetId: base.id, strokes: maskEditor.session.strokes, asset: result.maskAsset };
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
    $("#history-count").textContent = state.history.length;
    $("#history-summary").textContent = `共 ${filtered.length} 条记录`;
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
    const [configResult, historyResult, appInfoResult] = await Promise.all([api.loadConfig(), api.listHistory(), api.getAppInfo()]);
    state.config = unwrap(configResult);
    state.history = unwrap(historyResult);
    const appInfo = unwrap(appInfoResult);
    $("#version-label").textContent = `V${appInfo.version}`;
    renderConnectionProfiles();
    populateConnectionEditor(activeProfile());
    updateConnectionStatus();
    renderHistory();
    renderExamples();
    updateFormatDependencies();
    setCreationMode(localStorage.getItem("emberimage-creation-mode") === "edit" ? "edit" : "generate", { initial: true });
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
    closeExampleDetail();
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
    maskEditor.tool = button.dataset.value;
    selectSegment("#mask-tool-control", maskEditor.tool);
  }));
  $("#mask-brush-range").addEventListener("input", () => { $("#mask-brush-value").textContent = $("#mask-brush-range").value; });
  $("#mask-undo-button").addEventListener("click", () => {
    if (!maskEditor.session) return;
    maskEditor.session.undo();
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
  });
  $("#mask-redo-button").addEventListener("click", () => {
    if (!maskEditor.session) return;
    maskEditor.session.redo();
    renderFullOverlay();
    drawMaskEditor();
    updateMaskEditorButtons();
  });
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
  $("#example-search").addEventListener("input", renderExamples);
  $("#close-example-detail-button").addEventListener("click", closeExampleDetail);
  $("#cancel-example-detail-button").addEventListener("click", closeExampleDetail);
  $("#example-detail-overlay").addEventListener("click", (event) => {
    if (event.target === $("#example-detail-overlay")) closeExampleDetail();
  });
  $("#use-example-button").addEventListener("click", () => {
    const preset = PresetCatalog.presets.find((item) => item.id === state.selectedExampleId);
    if (preset) useExample(preset);
  });
  $("#copy-example-prompt-button").addEventListener("click", async () => {
    const preset = PresetCatalog.presets.find((item) => item.id === state.selectedExampleId);
    if (!preset) return;
    try { unwrap(await api.copyText(preset.prompt)); toast("提示词已复制"); }
    catch (error) { toast(error.message, "error"); }
  });
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
