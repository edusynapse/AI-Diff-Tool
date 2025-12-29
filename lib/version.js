
'use strict';

function _trim(s) { return String(s || '').trim(); }

function _stripLeadingV(ver) {
  const v = _trim(ver);
  return v.replace(/^[vV]\s*/, '');
}

function _parseSemver(ver) {
  // Accepts: 1.2.3, v1.2.3, 1.2, 1, 1.2.3-beta.1
  const raw = _stripLeadingV(ver);
  if (!raw) return null;
  const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  const major = Number(m[1] || 0);
  const minor = Number(m[2] || 0);
  const patch = Number(m[3] || 0);
  const pre = m[4] ? String(m[4]) : '';
  if (![major, minor, patch].every(n => Number.isFinite(n))) return null;
  return { major, minor, patch, pre };
}

function _cmpNum(a, b) { return a === b ? 0 : (a > b ? 1 : -1); }

function _compareSemver(a, b) {
  const A = _parseSemver(a);
  const B = _parseSemver(b);
  if (!A || !B) return 0;
  let c = _cmpNum(A.major, B.major); if (c) return c;
  c = _cmpNum(A.minor, B.minor); if (c) return c;
  c = _cmpNum(A.patch, B.patch); if (c) return c;

  // Stable (no prerelease) > prerelease
  const aPre = _trim(A.pre);
  const bPre = _trim(B.pre);
  if (!aPre && !bPre) return 0;
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  // If both prerelease, do a simple lexical compare (good enough for UI gating)
  return aPre.localeCompare(bPre);
}

function _parseGithubOwnerRepo(githubUrl) {
  // Accepts: https://github.com/owner/repo  (optional trailing slash / .git)
  const u = _trim(githubUrl).replace(/\.git$/i, '').replace(/\/+$/g, '');
  const m = u.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function _fetchLatestRelease({ owner, repo, timeoutMs = 4500 } = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;

  // AbortController is supported in Electron/Chromium; fallback to a timer if not.
  let ctrl = null;
  let t = null;
  try { ctrl = new AbortController(); } catch { ctrl = null; }
  if (ctrl) {
    t = setTimeout(() => { try { ctrl.abort(); } catch {} }, Math.max(500, timeoutMs));
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json'
      },
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res || !res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

function createVersionManager({
  window,
  document,
  ipcRenderer,
  t,
  tFmt,
  externalOpen,
  syncBodyModalOpen,
  modal
} = {}) {
  const SESSION_FLAG = 'version_check_done_v1';
  let _wired = false;

  const ids = modal || {};
  const $ = (id) => (id ? document.getElementById(id) : null);

  function _isOpen() {
    const o = $(ids.overlayId);
    return !!(o && !o.classList.contains('hidden'));
  }

  function applyI18nToUpdateModal() {
    const title = $(ids.titleId);
    const intro = $(ids.introId);
    const curLbl = $(ids.currentLabelId);
    const latLbl = $(ids.latestLabelId);
    const notesTitle = $(ids.notesTitleId);
    const dlBtn = $(ids.downloadBtnId);
    const laterBtn = $(ids.laterBtnId);
    const closeBtn = $(ids.closeBtnId);

    // appName is used in introFmt if you want it
    const appName = _trim($(ids.overlayId)?.dataset?.appName) || 'this app';

    if (title) title.textContent = t('versionUpdate.title', 'Update available');
    if (intro) intro.textContent = tFmt('versionUpdate.introFmt', { appName }, `A newer version of ${appName} is available.`);
    if (curLbl) curLbl.textContent = t('versionUpdate.currentLabel', 'Current');
    if (latLbl) latLbl.textContent = t('versionUpdate.latestLabel', 'Latest');
    if (notesTitle) notesTitle.textContent = t('versionUpdate.notesTitle', 'What’s new');
    if (dlBtn) dlBtn.textContent = t('versionUpdate.download', 'Download');
    if (laterBtn) laterBtn.textContent = t('versionUpdate.later', 'Later');
    if (closeBtn) closeBtn.setAttribute('aria-label', t('versionUpdate.closeAria', 'Close update'));
  }

  function closeUpdateModal({ force = false } = {}) {
    const overlay = $(ids.overlayId);
    if (!overlay) return;
    overlay.classList.add('hidden');
    try { overlay.dataset.releaseUrl = ''; } catch {}
    try { syncBodyModalOpen?.(); } catch {}
  }

  function openUpdateModal({ appName, currentVersion, latestVersion, notes, releaseUrl } = {}) {
    const overlay = $(ids.overlayId);
    if (!overlay) return;

    overlay.dataset.appName = _trim(appName);
    overlay.dataset.releaseUrl = _trim(releaseUrl);

    const curV = $(ids.currentValueId);
    const latV = $(ids.latestValueId);
    if (curV) curV.textContent = _trim(currentVersion) || '—';
    if (latV) latV.textContent = _trim(latestVersion) || '—';

    const wrap = $(ids.notesWrapId);
    const txt = $(ids.notesTextId);
    const cleanNotes = _trim(notes);
    if (wrap && txt) {
      if (cleanNotes) {
        txt.textContent = cleanNotes.slice(0, 8000);
        wrap.classList.remove('hidden');
      } else {
        txt.textContent = '';
        wrap.classList.add('hidden');
      }
    }

    applyI18nToUpdateModal();
    overlay.classList.remove('hidden');
    try { syncBodyModalOpen?.(); } catch {}

    setTimeout(() => {
      try { $(ids.downloadBtnId)?.focus?.(); } catch {}
    }, 0);
  }

  function _wireOnce() {
    if (_wired) return;
    _wired = true;

    const overlay = $(ids.overlayId);
    const closeBtn = $(ids.closeBtnId);
    const dlBtn = $(ids.downloadBtnId);
    const laterBtn = $(ids.laterBtnId);

    if (closeBtn) closeBtn.addEventListener('click', () => closeUpdateModal());
    if (laterBtn) laterBtn.addEventListener('click', () => closeUpdateModal());

    if (dlBtn) {
      dlBtn.addEventListener('click', () => {
        const url = _trim($(ids.overlayId)?.dataset?.releaseUrl);
        if (url) { try { externalOpen?.(url); } catch {} }
        closeUpdateModal({ force: true });
      });
    }

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeUpdateModal();
      });
    }

    // ESC closes this modal (capture so it wins)
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (_isOpen()) {
        e.preventDefault();
        e.stopPropagation();
        closeUpdateModal();
      }
    }, true);
  }

  async function checkAtStartup() {
    // Guard: once per renderer session
    try {
      if (window?.sessionStorage?.getItem(SESSION_FLAG) === '1') return { ok: true, skipped: true };
      window?.sessionStorage?.setItem(SESSION_FLAG, '1');
    } catch {}

    _wireOnce();

    let info = null;
    try { info = await ipcRenderer.invoke('about:getInfo'); } catch { info = null; }
    if (!info) return { ok: false, reason: 'no_about_info' };

    const appName = _trim(info.appName || '');
    const currentVersion = _trim(info.version || '');
    const githubUrl = _trim(info.githubUrl || '');

    const hint = $(ids.hintId);
    if (hint) hint.textContent = '';

    const repo = _parseGithubOwnerRepo(githubUrl);
    if (!repo || !currentVersion) return { ok: false, reason: 'missing_repo_or_version' };

    const latest = await _fetchLatestRelease({ owner: repo.owner, repo: repo.repo });
    if (!latest) {
      // Silent fail (no modal). Optionally set a hint if the modal is opened manually later.
      return { ok: false, reason: 'fetch_failed' };
    }

    // Ignore drafts/prereleases (latest endpoint usually excludes them, but be safe)
    if (latest.draft || latest.prerelease) return { ok: true, skipped: true };

    const tag = _trim(latest.tag_name || '');
    const latestVersion = _stripLeadingV(tag);
    const cmp = _compareSemver(latestVersion, currentVersion);
    if (cmp <= 0) return { ok: true, upToDate: true };

    const releaseUrl = _trim(latest.html_url || '') || `${githubUrl.replace(/\/+$/g, '')}/releases/latest`;
    const notes = _trim(latest.body || '');

    openUpdateModal({
      appName: appName || 'this app',
      currentVersion,
      latestVersion: latestVersion || tag,
      notes,
      releaseUrl
    });

    return { ok: true, updateAvailable: true, latestVersion };
  }

  return {
    checkAtStartup,
    openUpdateModal,
    closeUpdateModal,
    applyI18nToUpdateModal
  };
}

module.exports = { createVersionManager };
