(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let hasGlobalAppKey = false;
  let globalAppKeyMasked = '';
  let mappingsCache = [];
  let statusCache = null;
  let logsLoaded = false;
  let upgradeLoaded = false;

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
      if (tab.dataset.tab === 'logs') loadLogs().catch((e) => toast(e.message, 'error'));
      if (tab.dataset.tab === 'upgrade') loadUpgradeStatus(false).catch((e) => toast(e.message, 'error'));
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
    renderLogMappingFilter();
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
    }

    modal.showModal();
  }

  function closeMappingModal() {
    modal.close();
  }

  $('#btnAddMapping').addEventListener('click', () => openMappingModal(null));
  $('#btnCloseModal').addEventListener('click', closeMappingModal);
  $('#btnCancelModal').addEventListener('click', closeMappingModal);

  mappingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(mappingForm);
    const mode = fd.get('mode');
    const mappingId = (fd.get('mappingId') || '').toString().trim();

    const body = {
      enabled: fd.get('enabled') === 'on',
      localRoot: (fd.get('localRoot') || '').toString().trim(),
    };

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

    const moveConflict = (fd.get('moveNameConflictStrategy') || '').toString().trim();
    if (moveConflict) body.moveNameConflictStrategy = Number(moveConflict);

    const renameConflict = (fd.get('renameNameConflictStrategy') || '').toString().trim();
    if (renameConflict) body.renameNameConflictStrategy = Number(renameConflict);

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
      if (input && 'value' in input) input.value = val ?? '';
    }
    const appKeyInput = $('input[name="appKey"]', form);
    globalAppKeyMasked = cfg.appKeyMasked || '';
    appKeyInput.value = globalAppKeyMasked;
    appKeyInput.dataset.maskedValue = globalAppKeyMasked;
    updateGlobalAppKeyHint();
    updateMappingConcurrencyUi();
  }

  $('#btnSaveGlobal').addEventListener('click', async () => {
    const form = $('#globalForm');
    const body = {};
    const fields = [
      'serverUrl', 'syncDirection', 'autoSyncIntervalSec', 'maxConcurrentMappingsMode', 'maxConcurrentMappings',
      'maxRequestsPerMinute', 'stateDbPath', 'downloadConcurrency', 'uploadConcurrency',
      'managementPort', 'managementHost',
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
      <div class="status-metric"><span>自动间隔</span><strong>${cfg.autoSyncIntervalSec ?? '—'}s</strong></div>
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

  // ==================== Logs ====================

  function renderLogMappingFilter() {
    const select = $('#logMappingFilter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">全部映射</option>' + mappingsCache
      .map((m) => `<option value="${escapeHtml(m.mappingId)}">${escapeHtml(m.mappingId)}</option>`)
      .join('');
    if (current && mappingsCache.some((m) => m.mappingId === current)) {
      select.value = current;
    }
  }

  function logLineClass(line) {
    if (line.includes('[ERROR]')) return 'log-line log-error';
    if (line.includes('[WARN]')) return 'log-line log-warn';
    return 'log-line';
  }

  async function loadLogs() {
    const mappingId = $('#logMappingFilter')?.value || '';
    const level = $('#logLevelFilter')?.value || '';
    const lines = $('#logLineCount')?.value || '500';
    const params = new URLSearchParams({ lines });
    if (mappingId) params.set('mappingId', mappingId);
    if (level) params.set('level', level);

    const meta = $('#logMeta');
    const viewer = $('#logViewer');
    meta.textContent = '正在读取日志…';
    viewer.textContent = '加载中…';

    const data = await api('GET', `/logs?${params.toString()}`);
    logsLoaded = true;
    const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '—';
    const retention = data.retentionHours ? `最近 ${data.retentionHours} 小时` : '最近日志';
    const truncated = data.truncatedBytes
      ? ` · 仅读取末尾 ${Math.round((data.fileSize - data.truncatedBytes) / 1024)} KB`
      : '';
    meta.textContent =
      `${retention} · ${data.lineCount} 行 · 更新 ${updated}` +
      `${data.mappingId ? ` · 映射 ${data.mappingId}` : ''}` +
      `${data.level ? ` · ${data.level}` : ''}${truncated}`;
    viewer.innerHTML = (data.lines || [])
      .map((line) => `<span class="${logLineClass(line)}">${escapeHtml(line)}</span>`)
      .join('\n') || '<span class="log-line">暂无日志</span>';
    viewer.scrollTop = viewer.scrollHeight;
  }

  $('#btnRefreshLogs')?.addEventListener('click', () => {
    loadLogs()
      .then(() => toast('日志已刷新', 'success'))
      .catch((e) => toast(e.message, 'error'));
  });
  $('#logMappingFilter')?.addEventListener('change', () => loadLogs().catch((e) => toast(e.message, 'error')));
  $('#logLevelFilter')?.addEventListener('change', () => loadLogs().catch((e) => toast(e.message, 'error')));
  $('#logLineCount')?.addEventListener('change', () => loadLogs().catch((e) => toast(e.message, 'error')));

  // ==================== Upgrade ====================

  function renderUpgradeStatus(data) {
    const summary = $('#upgradeSummary');
    const dirty = data.dirty ? `<span class="badge badge-error">工作区有改动</span>` : '<span class="badge badge-on">工作区干净</span>';
    const update = data.behind > 0
      ? `<span class="badge badge-sync">可更新 ${data.behind} 个提交</span>`
      : '<span class="badge badge-on">已是最新</span>';
    const ahead = data.ahead > 0 ? `<span class="badge badge-error">领先 ${data.ahead} 个提交</span>` : '';
    summary.innerHTML = `<div class="upgrade-grid">
      <div><span>当前分支</span><strong>${escapeHtml(data.branch || '—')}</strong></div>
      <div><span>上游分支</span><strong>${escapeHtml(data.upstream || '未配置')}</strong></div>
      <div><span>当前版本</span><strong>${escapeHtml((data.head || '').slice(0, 12) || '—')}</strong></div>
      <div><span>远端版本</span><strong>${escapeHtml((data.upstreamHead || '').slice(0, 12) || '—')}</strong></div>
      <div><span>状态</span><strong>${dirty} ${update} ${ahead}</strong></div>
      <div><span>检查时间</span><strong>${escapeHtml(new Date(data.checkedAt).toLocaleString())}</strong></div>
    </div>
    ${data.dirtyFiles?.length ? `<div class="upgrade-warning">未提交改动：${escapeHtml(data.dirtyFiles.slice(0, 8).join('；'))}</div>` : ''}
    <div class="upgrade-note">在线升级会执行快进更新、安装依赖、重新构建，并在成功后重启服务。仅本机请求可以触发升级。</div>`;
  }

  async function loadUpgradeStatus(fetchRemote) {
    const output = $('#upgradeOutput');
    output.textContent = fetchRemote ? '正在从远端检查更新…' : '正在读取本地版本状态…';
    const data = await api(fetchRemote ? 'POST' : 'GET', fetchRemote ? '/upgrade/check' : '/upgrade/status');
    upgradeLoaded = true;
    renderUpgradeStatus(data);
    output.textContent = JSON.stringify(data, null, 2);
    return data;
  }

  $('#btnCheckUpgrade')?.addEventListener('click', () => {
    loadUpgradeStatus(true)
      .then(() => toast('更新检查完成', 'success'))
      .catch((e) => toast(e.message, 'error'));
  });

  $('#btnRunUpgrade')?.addEventListener('click', async () => {
    if (!confirm('在线升级会执行 git pull、npm install、npm run build，并在成功后重启服务。确定继续？')) return;
    const output = $('#upgradeOutput');
    try {
      output.textContent = '正在升级部署，请不要关闭页面…';
      const data = await api('POST', '/upgrade/run');
      output.textContent = JSON.stringify(data, null, 2);
      toast(data.message || '升级完成', 'success');
      if (data.restarted) {
        setTimeout(() => {
          refreshAll().catch(() => {});
        }, 4000);
      }
    } catch (e) {
      output.textContent = e.data ? JSON.stringify(e.data, null, 2) : e.message;
      toast(e.message, 'error');
    }
  });

  async function refreshAll() {
    await Promise.all([loadHealth(), loadMappings(), loadGlobalConfig(), refreshStatus()]);
    if (logsLoaded || $('#panel-logs')?.classList.contains('active')) {
      await loadLogs();
    }
    if (upgradeLoaded || $('#panel-upgrade')?.classList.contains('active')) {
      await loadUpgradeStatus(false);
    }
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
