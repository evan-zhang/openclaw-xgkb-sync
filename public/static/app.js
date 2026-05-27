(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let hasGlobalAppKey = false;
  let globalAppKeyMasked = '';
  let mappingsCache = [];
  let statusCache = null;

  // ==================== API ====================

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}：响应不是 JSON`);
    }
    if (!res.ok) {
      const msg = data.error || data.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ==================== UI helpers ====================

  function toast(message, type = 'info') {
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatUptime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatDateTime(ts) {
    return ts ? new Date(ts).toLocaleString() : '—';
  }

  function syncResultBadge(st) {
    if (st?.isSyncing) return '<span class="badge badge-sync">同步中</span>';
    if (st?.pendingSync) return '<span class="badge badge-sync">排队</span>';
    const lastState = st?.lastState || {};
    if (lastState.lastError) {
      return `<span class="badge badge-error" title="${escapeHtml(lastState.lastError)}">失败</span>`;
    }
    if (lastState.lastSuccessAt) return '<span class="badge badge-on">成功</span>';
    return '<span class="muted">未同步</span>';
  }

  function syncStatsSummary(st) {
    const stats = st?.lastState?.lastStats;
    if (!stats) return '暂无同步统计';
    const parts = [
      `推送 ${stats.uploaded || 0} 条`,
      `拉取 ${stats.downloaded || 0} 条`,
    ];
    if (stats.deleted) parts.push(`删除 ${stats.deleted} 条`);
    if (stats.prunedRemoteDirs) parts.push(`清理空目录 ${stats.prunedRemoteDirs} 个`);
    if (stats.fullScan) parts.push('全量对账');
    if (stats.failed) parts.push(`失败 ${stats.failed} 条`);
    return parts.join('，');
  }

  function syncTriggerLabel(reason) {
    switch (reason) {
      case 'watch':
        return '文件监听';
      case 'timer':
        return '定时器';
      case 'startup':
        return '启动';
      case 'manual':
        return '手动';
      default:
        return '—';
    }
  }

  function watchStatusText(st, mappingSummary) {
    const effective =
      st?.watchEnabledEffective ??
      mappingSummary?.watchEnabledEffective ??
      false;
    if (!effective) return '未启用';
    const active = st?.watchActive ? '监听中' : '未运行';
    return active;
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          fallbackCopyText(text);
        }
      } else {
        fallbackCopyText(text);
      }
      toast(`已复制${label}`, 'success');
    } catch (e) {
      toast(`复制失败：${e.message || e}`, 'error');
    }
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('浏览器拒绝复制，请手动选中路径复制');
  }

  function syncDirectionLabel(dir) {
    const map = { bidirectional: '双向', push: '推送', pull: '拉取' };
    return map[dir] || dir || '—';
  }

  /** 各 syncDirection 推荐默认值（与 README「各模式推荐配置」一致） */
  const SYNC_DIRECTION_PRESETS = {
    bidirectional: {
      autoSyncIntervalSec: 60,
      watchEnabled: true,
      pushDebounceMs: 1500,
      watchUsePolling: false,
      downloadConcurrency: 5,
      uploadConcurrency: 3,
      autoSyncHint:
        '双向推荐 60 秒：定时 pull 远端 + push 兜底；本地 push 主要靠文件监听。0 = 关闭定时 sync。',
      watchHint: '本地保存后约 debounce 内触发 sync；sync 期间会 pause 避免 pull 回写误触发。',
      fileIndexHint:
        '双向：同步开始前 consume 索引，成功后 publish。OpenClaw + Obsidian 联动时建议开启。',
    },
    push: {
      autoSyncIntervalSec: 1800,
      watchEnabled: true,
      pushDebounceMs: 1500,
      watchUsePolling: false,
      downloadConcurrency: 5,
      uploadConcurrency: 3,
      autoSyncHint:
        'push 推荐 1800 秒（30 分钟）：本地 push 靠监听，定时仅防 watch 漏事件。0 = 关闭定时 sync。',
      watchHint: 'OpenClaw 写本地场景建议开启；Docker/NFS 卷监听不稳时可开 watchUsePolling。',
      fileIndexHint: 'push：同步成功后 publish 索引，供 Pull 端 / Obsidian 读取 fileId。',
    },
    pull: {
      autoSyncIntervalSec: 120,
      watchEnabled: false,
      pushDebounceMs: 1500,
      watchUsePolling: false,
      downloadConcurrency: 5,
      uploadConcurrency: 3,
      autoSyncHint:
        'pull 推荐 120 秒：唯一自动触发源，控制从知识库拉取的频率。0 = 关闭定时 sync。',
      watchHint: '',
      fileIndexHint: 'pull：同步开始前 consume 索引到本地 vault 根目录。',
    },
  };

  function needsPushDirection(dir) {
    return dir === 'push' || dir === 'bidirectional';
  }

  function getPreset(dir) {
    return SYNC_DIRECTION_PRESETS[dir] || SYNC_DIRECTION_PRESETS.bidirectional;
  }

  function getGlobalSyncDirection() {
    const sel = $('#globalForm select[name="syncDirection"]');
    return sel?.value || statusCache?.config?.syncDirection || 'bidirectional';
  }

  function getMappingEffectiveDirection(form = mappingForm) {
    const local = $('select[name="syncDirection"]', form)?.value;
    return local || getGlobalSyncDirection();
  }

  function applyRecommendedPlaceholder(input, recommended) {
    if (!input || recommended == null) return;
    const empty = input.value === '' || input.value == null;
    if (empty) {
      input.placeholder = `推荐 ${recommended}`;
    }
  }

  function applyRecommendedDefaults(form, preset, fieldNames) {
    for (const name of fieldNames) {
      const el = form.elements.namedItem(name);
      if (!el || el.type === 'checkbox') continue;
      applyRecommendedPlaceholder(el, preset[name]);
    }
  }

  function updateGlobalSyncDirectionUi() {
    const dir = getGlobalSyncDirection();
    const preset = getPreset(dir);
    const push = needsPushDirection(dir);

    $('#globalWatchSettings')?.classList.toggle('sync-direction-hidden', !push);
    $('#globalDownloadConcurrencyField')?.classList.toggle('sync-direction-hidden', dir === 'push');
    $('#globalUploadConcurrencyField')?.classList.toggle('sync-direction-hidden', dir === 'pull');

    const autoHint = $('#globalAutoSyncHint');
    if (autoHint) autoHint.textContent = preset.autoSyncHint;

    const dirHint = $('#globalSyncDirectionHint');
    if (dirHint) {
      dirHint.textContent = `当前默认方向：${syncDirectionLabel(dir)}。mapping 可单独覆盖；无效项已隐藏。`;
    }

    const watchHint = $('#globalWatchEnabledHint');
    if (watchHint) watchHint.textContent = preset.watchHint;

    const dlHint = $('#globalDownloadConcurrencyHint');
    if (dlHint) {
      dlHint.textContent = dir === 'push'
        ? 'push 方向几乎不下载，此项可忽略。'
        : `pull/bidirectional 推荐 ${preset.downloadConcurrency}。`;
    }

    const ulHint = $('#globalUploadConcurrencyHint');
    if (ulHint) {
      ulHint.textContent = dir === 'pull'
        ? 'pull 方向几乎不上传，此项可忽略。'
        : `push/bidirectional 推荐 ${preset.uploadConcurrency}。`;
    }

    const form = $('#globalForm');
    applyRecommendedDefaults(form, preset, [
      'autoSyncIntervalSec',
      'pushDebounceMs',
      'downloadConcurrency',
      'uploadConcurrency',
    ]);
    applyRecommendedPlaceholder(
      form.elements.namedItem('autoSyncIntervalSec'),
      preset.autoSyncIntervalSec,
    );
  }

  function updateMappingSyncDirectionUi() {
    const dir = getMappingEffectiveDirection();
    const preset = getPreset(dir);
    const push = needsPushDirection(dir);

    $('#mappingWatchSettings')?.classList.toggle('sync-direction-hidden', !push);
    $('#mappingPushOnlySettings')?.classList.toggle('sync-direction-hidden', !push);

    const dirHint = $('#mappingSyncDirectionHint');
    if (dirHint) {
      dirHint.textContent = $('select[name="syncDirection"]', mappingForm)?.value
        ? `当前有效方向：${syncDirectionLabel(dir)}`
        : `继承全局：${syncDirectionLabel(getGlobalSyncDirection())}（有效方向：${syncDirectionLabel(dir)}）`;
    }

    const indexHint = $('#mappingFileIndexHint');
    if (indexHint) indexHint.textContent = preset.fileIndexHint;

    const watchHint = $('#mappingWatchEnabledHint');
    if (watchHint && push) watchHint.textContent = preset.watchHint;

    applyRecommendedPlaceholder(
      mappingForm.elements.namedItem('pushDebounceMs'),
      preset.pushDebounceMs,
    );
  }

  function parseJsonArray(str) {
    if (!str || !str.trim()) return undefined;
    const parsed = JSON.parse(str);
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    return parsed;
  }

  function updateMappingConcurrencyUi() {
    const form = $('#globalForm');
    const mode = form.elements.namedItem('maxConcurrentMappingsMode')?.value || 'auto';
    const field = $('#manualConcurrencyField');
    const input = form.elements.namedItem('maxConcurrentMappings');
    const hint = $('#mappingConcurrencyHint');
    const effective = statusCache?.config?.effectiveMaxConcurrentMappings;
    field?.classList.toggle('advanced-only-hidden', mode !== 'manual');
    if (input) input.disabled = mode !== 'manual';
    if (hint) {
      hint.textContent = mode === 'auto'
        ? `建议：自动。系统会按映射数量和 AppKey 分布控制同时同步的目录数；当前实际并发 ${effective || '—'}。`
        : '手动模式会固定使用下方数字。只有在你清楚 API 限流和映射规模时才建议修改。';
    }
  }

  // ==================== Tabs ====================

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
  });

  $$('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.settings-tab').forEach((t) => t.classList.remove('active'));
      $$('.settings-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#settings-${tab.dataset.settingsTab}`).classList.add('active');
    });
  });

  $('#globalForm').elements.namedItem('maxConcurrentMappingsMode')
    ?.addEventListener('change', updateMappingConcurrencyUi);

  $('#globalForm select[name="syncDirection"]')
    ?.addEventListener('change', updateGlobalSyncDirectionUi);

  // ==================== Health & meta ====================

  async function loadHealth() {
    const data = await api('GET', '/health');
    const badge = $('#healthBadge');
    badge.className = 'header-status ok';
    badge.querySelector('.label').textContent =
      `v${data.version} · ${data.enabledMappingCount}/${data.mappingCount} 映射 · 运行 ${formatUptime(data.uptime)}`;
    $('#metaInfo').textContent = `PID ${data.pid} · Node ${data.nodeVersion}`;
    return data;
  }

  // ==================== Mappings ====================

  function renderMappings() {
    const container = $('#mappingsBody');
    if (mappingsCache.length === 0) {
      container.innerHTML = '<p class="empty">暂无同步映射，点击「新增映射」创建</p>';
      return;
    }

    container.innerHTML = mappingsCache
      .map((m) => {
        const st = statusCache?.mappings?.[m.mappingId];
        const syncing = st?.isSyncing;
        const pending = st?.pendingSync;
        const lastState = st?.lastState || {};
        const lastError = lastState.lastError;
        let syncBadge = '';
        if (syncing) syncBadge = '<span class="badge badge-sync">同步中</span>';
        else if (pending) syncBadge = '<span class="badge badge-sync">排队</span>';

        return `<article class="mapping-card" data-id="${escapeHtml(m.mappingId)}">
          <div class="mapping-card-head">
            <div class="mapping-title">
              <span class="cell-id">${escapeHtml(m.mappingId)}</span>
              <div class="mapping-badges">
                <span class="badge ${m.enabled ? 'badge-on' : 'badge-off'}">${m.enabled ? '启用' : '禁用'}</span>
                ${syncBadge || syncResultBadge(st)}
              </div>
            </div>
            <div class="actions">
              <button type="button" class="btn btn-sm btn-secondary btn-sync-one" ${!m.enabled ? 'disabled' : ''}>同步</button>
              <button type="button" class="btn btn-sm btn-secondary btn-edit">编辑</button>
              <button type="button" class="btn btn-sm btn-warning btn-reset">清空DB</button>
              <button type="button" class="btn btn-sm btn-danger btn-delete">删除</button>
            </div>
          </div>
          <dl class="mapping-meta">
            <div>
              <dt>本地目录</dt>
              <dd class="path-with-copy">
                <span class="cell-path" title="${escapeHtml(m.localRoot)}">${escapeHtml(m.localRoot)}</span>
                <button type="button" class="btn btn-sm btn-secondary btn-copy-local" data-copy="${escapeHtml(m.localRoot)}">复制</button>
              </dd>
            </div>
            <div>
              <dt>远端路径</dt>
              <dd class="cell-path" title="${escapeHtml(m.remoteRootFolderPath || '')}">${escapeHtml(m.remoteRootFolderPath || '—')}</dd>
            </div>
            <div>
              <dt>同步方向</dt>
              <dd>${syncDirectionLabel(m.syncDirection || statusCache?.config?.syncDirection)}</dd>
            </div>
            <div>
              <dt>映射索引</dt>
              <dd>${m.enableFileIndex ? '已启用' : '—'}</dd>
            </div>
            <div>
              <dt>文件监听</dt>
              <dd>${escapeHtml(watchStatusText(st, m))}</dd>
            </div>
            <div>
              <dt>最近触发</dt>
              <dd>${st?.lastTriggerReason ? escapeHtml(syncTriggerLabel(st.lastTriggerReason)) : '—'}</dd>
            </div>
            <div>
              <dt>最后同步</dt>
              <dd>${formatDateTime(lastState.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt>最后结果</dt>
              <dd>
                ${syncResultBadge(st)}
                <div class="sync-summary">${escapeHtml(syncStatsSummary(st))}</div>
                ${lastError ? `<div class="cell-error" title="${escapeHtml(lastError)}">${escapeHtml(lastError)}</div>` : ''}
              </dd>
            </div>
          </dl>
        </article>`;
      })
      .join('');

    container.querySelectorAll('.btn-sync-one').forEach((btn) => {
      btn.addEventListener('click', () => syncOne(btn.closest('.mapping-card').dataset.id));
    });
    container.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', () => openMappingModal(btn.closest('.mapping-card').dataset.id));
    });
    container.querySelectorAll('.btn-reset').forEach((btn) => {
      btn.addEventListener('click', () => resetMapping(btn.closest('.mapping-card').dataset.id));
    });
    container.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteMapping(btn.closest('.mapping-card').dataset.id));
    });
    container.querySelectorAll('.btn-copy-local').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.copy || '', '本地目录'));
    });
  }

  async function loadMappings() {
    const data = await api('GET', '/mappings');
    hasGlobalAppKey = data.hasGlobalAppKey;
    mappingsCache = data.mappings || [];
    renderMappings();
    updateGlobalAppKeyHint();
  }

  async function syncOne(id) {
    try {
      const data = await api('POST', `/sync/${encodeURIComponent(id)}`);
      await refreshStatus();
      toast(`${data.message}，正在同步...`, 'info');
      await watchMappingSync(id);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function watchMappingSync(id) {
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await refreshStatus();
      const st = statusCache?.mappings?.[id];
      if (!st?.isSyncing && !st?.pendingSync) {
        const err = st?.lastState?.lastError;
        if (err) toast(`同步失败：${err}`, 'error');
        else toast(`同步完成：${id}`, 'success');
        return;
      }
    }
    toast('同步仍在进行，可在列表查看最新状态', 'info');
  }

  async function deleteMapping(id) {
    if (!confirm(`确定删除映射「${id}」？此操作不可撤销。`)) return;
    try {
      const data = await api('DELETE', `/mappings/${encodeURIComponent(id)}`);
      toast(data.message, 'success');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function resetMapping(id) {
    if (!confirm(`确定清空映射「${id}」的同步状态（DB 记录）？\n下次同步将全量重新对账。`)) return;
    try {
      const data = await api('POST', `/mappings/${encodeURIComponent(id)}/reset`);
      toast(data.message, 'success');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ==================== Mapping modal ====================

  const modal = $('#mappingModal');
  const mappingForm = $('#mappingForm');

  function openMappingModal(id) {
    const isNew = !id;
    $('#mappingModalTitle').textContent = isNew ? '新增映射' : '编辑映射';
    mappingForm.reset();
    $('input[name="mode"]', mappingForm).value = isNew ? 'create' : 'edit';

    const idField = $('#fieldMappingId');
    idField.readOnly = !isNew;
    idField.required = !isNew;

    if (isNew) {
      idField.value = '';
      $('input[name="enabled"]', mappingForm).checked = true;
      $('input[name="enableFileIndex"]', mappingForm).checked = false;
      $('input[name="watchEnabled"]', mappingForm).checked = true;
      $('input[name="watchUsePolling"]', mappingForm).checked = false;
      $('input[name="pushDebounceMs"]', mappingForm).value = '';
    } else {
      const m = mappingsCache.find((x) => x.mappingId === id);
      if (!m) return;
      idField.value = m.mappingId;
      $('input[name="enabled"]', mappingForm).checked = m.enabled;
      $('input[name="localRoot"]', mappingForm).value = m.localRoot || '';
      $('input[name="projectId"]', mappingForm).value = m.projectId || '';
      $('input[name="remoteRootFolderPath"]', mappingForm).value = m.remoteRootFolderPath || '';
      $('input[name="remoteRootFileId"]', mappingForm).value = m.remoteRootFileId || '';
      $('select[name="syncDirection"]', mappingForm).value = m.syncDirection || '';
      $('select[name="moveNameConflictStrategy"]', mappingForm).value =
        m.moveNameConflictStrategy === undefined || m.moveNameConflictStrategy === null
          ? ''
          : String(m.moveNameConflictStrategy);
      $('select[name="renameNameConflictStrategy"]', mappingForm).value =
        m.renameNameConflictStrategy === undefined || m.renameNameConflictStrategy === null
          ? ''
          : String(m.renameNameConflictStrategy);
      $('input[name="filePatterns"]', mappingForm).value =
        m.filePatterns ? JSON.stringify(m.filePatterns) : '';
      $('input[name="excludePatterns"]', mappingForm).value =
        m.excludePatterns ? JSON.stringify(m.excludePatterns) : '';
      $('input[name="enableFileIndex"]', mappingForm).checked = !!m.enableFileIndex;
      const globalWatch = statusCache?.config?.watchEnabled !== false;
      $('input[name="watchEnabled"]', mappingForm).checked =
        m.watchEnabled !== undefined ? !!m.watchEnabled : globalWatch;
      $('input[name="watchUsePolling"]', mappingForm).checked = !!m.watchUsePolling;
      $('input[name="pushDebounceMs"]', mappingForm).value =
        m.pushDebounceMs != null ? String(m.pushDebounceMs) : '';
    }

    updateMappingSyncDirectionUi();
    modal.showModal();
  }

  function closeMappingModal() {
    modal.close();
  }

  $('#btnAddMapping').addEventListener('click', () => openMappingModal(null));
  $('#btnCloseModal').addEventListener('click', closeMappingModal);
  $('#btnCancelModal').addEventListener('click', closeMappingModal);

  $('#mappingSyncDirection')?.addEventListener('change', updateMappingSyncDirectionUi);

  mappingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(mappingForm);
    const mode = fd.get('mode');
    const mappingId = (fd.get('mappingId') || '').toString().trim();

    const body = {
      enabled: fd.get('enabled') === 'on',
      localRoot: (fd.get('localRoot') || '').toString().trim(),
      enableFileIndex: fd.get('enableFileIndex') === 'on',
    };

    const effectiveDir = (fd.get('syncDirection') || '').toString() || getGlobalSyncDirection();
    const push = needsPushDirection(effectiveDir);

    if (push) {
      body.watchEnabled = fd.get('watchEnabled') === 'on';
      body.watchUsePolling = fd.get('watchUsePolling') === 'on';
      const pushDebounce = (fd.get('pushDebounceMs') || '').toString().trim();
      if (pushDebounce) body.pushDebounceMs = Number(pushDebounce);

      const moveConflict = (fd.get('moveNameConflictStrategy') || '').toString().trim();
      if (moveConflict) body.moveNameConflictStrategy = Number(moveConflict);

      const renameConflict = (fd.get('renameNameConflictStrategy') || '').toString().trim();
      if (renameConflict) body.renameNameConflictStrategy = Number(renameConflict);
    }

    const appKey = (fd.get('appKey') || '').toString().trim();
    if (appKey) body.appKey = appKey;

    const projectId = (fd.get('projectId') || '').toString().trim();
    if (projectId) body.projectId = projectId;

    const remotePath = (fd.get('remoteRootFolderPath') || '').toString();
    body.remoteRootFolderPath = remotePath.trim() || '';

    const remoteFileId = (fd.get('remoteRootFileId') || '').toString();
    body.remoteRootFileId = remoteFileId.trim() || '';

    const syncDir = (fd.get('syncDirection') || '').toString();
    if (syncDir) body.syncDirection = syncDir;

    try {
      const fp = parseJsonArray((fd.get('filePatterns') || '').toString());
      if (fp) body.filePatterns = fp;
      const ep = parseJsonArray((fd.get('excludePatterns') || '').toString());
      if (ep) body.excludePatterns = ep;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    if (!hasGlobalAppKey && !appKey && mode === 'create') {
      toast('未配置全局 AppKey，请填写本条映射的 AppKey', 'error');
      return;
    }

    try {
      let data;
      if (mode === 'create') {
        if (mappingId) body.mappingId = mappingId;
        data = await api('POST', '/mappings', body);
      } else {
        data = await api('PUT', `/mappings/${encodeURIComponent(mappingId)}`, body);
      }
      toast(data.message + (data.warnings?.length ? ' · ' + data.warnings.join(' ') : ''), 'success');
      closeMappingModal();
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ==================== Global config ====================

  function updateGlobalAppKeyHint() {
    const hint = $('#globalAppKeyHint');
    const input = $('input[name="appKey"]', $('#globalForm'));
    hint.classList.toggle('is-set', hasGlobalAppKey);
    hint.classList.toggle('is-empty', !hasGlobalAppKey);
    hint.textContent = hasGlobalAppKey
      ? '已保存全局 AppKey。这里只显示前 4 位和后 4 位；保持不变保存不会改动，输入新值才会覆盖。'
      : '尚未保存全局 AppKey。新建映射时需单独填写 AppKey，或在这里输入后保存。';
    if (input) {
      input.placeholder = hasGlobalAppKey
        ? '已保存，显示脱敏值；输入新值可覆盖'
        : '输入全局 AppKey 后点击保存配置';
      input.setAttribute(
        'aria-describedby',
        'globalAppKeyHint',
      );
    }
  }

  async function loadGlobalConfig() {
    const data = await api('GET', '/config');
    hasGlobalAppKey = data.hasGlobalAppKey;
    const form = $('#globalForm');
    const cfg = data.config;
    for (const [key, val] of Object.entries(cfg)) {
      const input = form.elements.namedItem(key);
      if (!input) continue;
      if (input.type === 'checkbox') {
        input.checked = !!val;
      } else if ('value' in input) {
        input.value = val ?? '';
      }
    }
    const appKeyInput = $('input[name="appKey"]', form);
    globalAppKeyMasked = cfg.appKeyMasked || '';
    appKeyInput.value = globalAppKeyMasked;
    appKeyInput.dataset.maskedValue = globalAppKeyMasked;
    updateGlobalAppKeyHint();
    updateMappingConcurrencyUi();
    updateGlobalSyncDirectionUi();
  }

  $('#btnSaveGlobal').addEventListener('click', async () => {
    const form = $('#globalForm');
    const body = {};
    const fields = [
      'serverUrl', 'syncDirection', 'autoSyncIntervalSec', 'maxConcurrentMappingsMode', 'maxConcurrentMappings',
      'maxRequestsPerMinute', 'stateDbPath', 'downloadConcurrency', 'uploadConcurrency',
      'managementPort', 'managementHost', 'pushDebounceMs',
    ];
    for (const name of fields) {
      const el = form.elements.namedItem(name);
      if (!el) continue;
      if (el.type === 'number') {
        body[name] = Number(el.value);
      } else {
        body[name] = el.value.trim();
      }
    }
    body.watchEnabled = form.elements.namedItem('watchEnabled')?.checked ?? true;
    body.watchUsePolling = form.elements.namedItem('watchUsePolling')?.checked ?? false;
    const appKeyInput = form.elements.namedItem('appKey');
    const appKey = appKeyInput.value.trim();
    const maskedValue = appKeyInput.dataset.maskedValue || '';
    const appKeyChanged = appKey && appKey !== maskedValue;
    if (appKeyChanged) body.appKey = appKey;

    try {
      const data = await api('PUT', '/config', body);
      const appKeySavedText = appKeyChanged ? '全局 AppKey 已保存，页面将显示脱敏值。' : data.message;
      toast(appKeySavedText + (data.warnings?.length ? ' · ' + data.warnings[0] : ''), 'success');
      if (data.warnings?.length) toast(data.warnings.join(' '), 'info');
      hasGlobalAppKey = data.hasGlobalAppKey ?? hasGlobalAppKey;
      await loadGlobalConfig();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ==================== Status ====================

  function mappingRunLabel(st) {
    if (st.isSyncing) return '<span class="badge badge-sync">同步中</span>';
    if (st.pendingSync) return '<span class="badge badge-sync">排队</span>';
    if (st.lastState?.lastError) return '<span class="badge badge-error">异常</span>';
    if (st.enabled) return '<span class="badge badge-on">空闲</span>';
    return '<span class="badge badge-off">禁用</span>';
  }

  function renderStatus() {
    const grid = $('#statusGrid');
    if (!statusCache?.mappings || Object.keys(statusCache.mappings).length === 0) {
      grid.innerHTML = '<p class="empty">暂无映射运行数据</p>';
      return;
    }

    const cfg = statusCache.config || {};
    const mappingEntries = Object.entries(statusCache.mappings);
    const syncingCount = mappingEntries.filter(([, st]) => st.isSyncing).length;
    const pendingCount = mappingEntries.filter(([, st]) => st.pendingSync).length;
    const errorCount = mappingEntries.filter(([, st]) => st.lastState?.lastError).length;
    const refreshedAt = new Date().toLocaleString();

    const overview = `<div class="status-overview">
      <div class="status-metric"><span>服务运行</span><strong>${formatUptime(statusCache.uptime || 0)}</strong></div>
      <div class="status-metric"><span>映射</span><strong>${cfg.enabledMappingCount || 0}/${cfg.mappingCount || 0}</strong></div>
      <div class="status-metric"><span>同步中</span><strong>${syncingCount}</strong></div>
      <div class="status-metric"><span>排队</span><strong>${pendingCount}</strong></div>
      <div class="status-metric ${errorCount ? 'metric-danger' : ''}"><span>异常</span><strong>${errorCount}</strong></div>
      <div class="status-metric"><span>定时兜底</span><strong>${cfg.autoSyncIntervalSec ?? '—'}s</strong></div>
      <div class="status-metric"><span>文件监听</span><strong>${cfg.watchEnabled === false ? '关' : '开'}</strong></div>
      <div class="status-metric"><span>监听防抖</span><strong>${cfg.pushDebounceMs ?? 1500}ms</strong></div>
      <div class="status-metric"><span>映射并发</span><strong>${cfg.maxConcurrentMappingsMode || 'auto'} / ${cfg.effectiveMaxConcurrentMappings ?? '—'}</strong></div>
      <div class="status-metric"><span>API 限速</span><strong>${cfg.maxRequestsPerMinute ?? '—'}/min</strong></div>
      <div class="status-metric"><span>刷新时间</span><strong>${escapeHtml(refreshedAt)}</strong></div>
    </div>`;

    const cards = mappingEntries
      .map(([id, st]) => {
        const ls = st.lastState || {};
        const lastErr = ls.lastError;
        return `<div class="status-card ${lastErr ? 'status-card-error' : ''}">
          <div class="status-card-head">
            <h4>${escapeHtml(id)}</h4>
            ${mappingRunLabel(st)}
          </div>
          <dl class="status-detail">
            <dt>同步结果</dt><dd>${escapeHtml(syncStatsSummary(st))}</dd>
            <dt>最后同步</dt><dd>${formatDateTime(ls.lastSuccessAt)}</dd>
            <dt>同步方向</dt><dd>${syncDirectionLabel(st.syncDirection)}</dd>
            <dt>文件监听</dt><dd>${escapeHtml(watchStatusText(st))}</dd>
            <dt>最近触发</dt><dd>${st.lastTriggerReason ? escapeHtml(syncTriggerLabel(st.lastTriggerReason)) : '—'}</dd>
            <dt>最近 watch</dt><dd>${formatDateTime(st.lastWatchTriggerAt)}</dd>
            <dt>本地目录</dt><dd>${escapeHtml(st.localRoot || '—')}</dd>
            <dt>远端路径</dt><dd>${escapeHtml(st.remoteRootFolderPath || '知识库根目录')}</dd>
            <dt>空间 ID</dt><dd>${escapeHtml(ls.resolvedProjectId || '—')}</dd>
            <dt>根目录 FileId</dt><dd>${escapeHtml(ls.resolvedRootFileId || '—')}</dd>
            <dt>同步水位</dt><dd>${formatDateTime(ls.lastServerTime || ls.lastSyncSince)}</dd>
          </dl>
          ${lastErr && !st.isSyncing ? `<div class="error">${escapeHtml(lastErr)}</div>` : ''}
        </div>`;
      })
      .join('');

    grid.innerHTML = `${overview}<div class="status-card-grid">${cards}</div>`;
  }

  async function refreshStatus() {
    statusCache = await api('GET', '/status');
    renderMappings();
    renderStatus();
    updateMappingConcurrencyUi();
  }

  async function refreshAll() {
    await Promise.all([loadHealth(), loadMappings(), loadGlobalConfig(), refreshStatus()]);
  }

  // ==================== Toolbar actions ====================

  $('#btnRefresh').addEventListener('click', async () => {
    try {
      await refreshAll();
      toast('已刷新', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#btnReload').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/reload');
      toast(data.message, 'success');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#btnSyncAll').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/sync');
      toast(data.message, 'success');
      setTimeout(refreshStatus, 1000);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ==================== Init ====================

  refreshAll().catch((e) => {
    const badge = $('#healthBadge');
    badge.className = 'header-status err';
    badge.querySelector('.label').textContent = '无法连接服务';
    toast(e.message, 'error');
  });

  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 15000);
})();
