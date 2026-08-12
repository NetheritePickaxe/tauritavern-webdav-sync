import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { translate } from '../../../i18n.js';
import { eventSource, event_types } from '../../../../script.js';
import { isAndroidRuntime, isIosRuntime } from '../../../util/mobile-runtime.js';

const MODULE_NAME = (() => {
    const match = import.meta.url.match(/\/scripts\/extensions\/(third-party\/[^/]+)\//);
    return match ? match[1] : 'webdav-sync';
})();

const SECRET_KEY = 'webdav_sync_password';
const JOB_POLL_INTERVAL_MS = 1200;
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const AUTO_PUSH_DEBOUNCE_MS = 5000;
const DEFAULT_FILENAME = 'tauritavern-backup.zip';
const DEFAULT_USER_HANDLE = 'default-user';
const DEFAULT_SYNC_INTERVAL_MINUTES = 30;
const OLD_APP_VERSION_NOTICE_KEY = 'webdav_sync.old_app_version_notice_shown';

function localize(key, fallback) {
    return translate(fallback, key);
}

function localizeTemplate(key, fallback, ...values) {
    const template = localize(key, fallback);
    return template.replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

const jobState = {
    jobId: '',
    starting: false,
    cancelRequested: false,
};

let autoPushPending = false;
let autoPushDebounceId = null;
let autoPushIntervalId = null;
let autoSyncDirty = false;

// Capability probe result, cached after first check.
// true  = /api/users/backup is supported (App >= v2.3.0)
// false = not supported (App < v2.3.0), use job-based fallback
// undefined = not yet probed
let _apiSupportsUserBackup = /** @type {boolean|null|undefined} */ (undefined);

function isAutoSyncBusy() {
    return autoPushPending || hasActiveJob();
}

function getSettings() {
    return (extension_settings.webdav_sync ??= {});
}

function persistSettings() {
    saveSettingsDebounced();
}

function readFailureMessage(response) {
    return response.text().then((text) => extractErrorMessage(text));
}

function extractErrorMessage(text) {
    if (!text) {
        return localize('webdav_sync.unknown_error', 'Unknown error');
    }

    try {
        const json = JSON.parse(text);
        if (typeof json?.error === 'string' && json.error.trim()) {
            return json.error.trim();
        }
        if (typeof json?.message === 'string' && json.message.trim()) {
            return json.message.trim();
        }
    } catch {
        // Fall through to plain text.
    }

    return String(text).trim() || localize('webdav_sync.unknown_error', 'Unknown error');
}

function normalizeCaughtError(error) {
    if (error instanceof Error && typeof error.message === 'string') {
        return extractErrorMessage(error.message);
    }

    return extractErrorMessage(String(error || ''));
}

function setStatusText(message) {
    $('#webdav_sync_status').text(String(message || ''));
}

function refreshControls() {
    const busy = hasActiveJob();
    $('#webdav_sync_save_button').prop('disabled', busy);
    $('#webdav_sync_push_button').prop('disabled', busy);
    $('#webdav_sync_pull_button').prop('disabled', busy);

    const cancelButton = $('#webdav_sync_cancel_button');
    if (jobState.jobId) {
        cancelButton.show();
        cancelButton.prop('disabled', jobState.cancelRequested);
        return;
    }

    cancelButton.hide();
    cancelButton.prop('disabled', false);
}

function hasActiveJob() {
    return jobState.starting || Boolean(jobState.jobId);
}

function markJobStarting() {
    jobState.jobId = '';
    jobState.starting = true;
    jobState.cancelRequested = false;
    refreshControls();
}

function startJobTracking(jobId) {
    jobState.jobId = jobId;
    jobState.starting = false;
    jobState.cancelRequested = false;
    refreshControls();
}

function stopJobTracking() {
    jobState.jobId = '';
    jobState.starting = false;
    jobState.cancelRequested = false;
    refreshControls();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probes whether the host App supports the /api/users/backup endpoint.
 * Result is cached in _apiSupportsUserBackup so subsequent calls are O(1).
 */
async function apiSupportsUserBackup() {
    if (_apiSupportsUserBackup !== undefined) {
        return _apiSupportsUserBackup;
    }
    try {
        const r = await fetch('/api/users/backup', { method: 'HEAD' });
        _apiSupportsUserBackup = r.status !== 404 && r.status !== 501;
    } catch {
        _apiSupportsUserBackup = false;
    }
    return _apiSupportsUserBackup;
}

async function findSecret(key) {
    const response = await fetch('/api/secrets/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
    });
    if (!response.ok) {
        return '';
    }

    const payload = await response.json();
    return String(payload?.value || '');
}

async function writeSecret(key, value) {
    const response = await fetch('/api/secrets/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, label: localize('webdav_sync.password_label', 'WebDAV Sync password') }),
    });
    if (!response.ok) {
        throw new Error(await readFailureMessage(response));
    }
}

function basicAuthHeader(username, password) {
    return 'Basic ' + btoa(`${username}:${password}`);
}

function readCredentials() {
    const url = String($('#webdav_sync_url_input').val() || '').trim();
    const username = String($('#webdav_sync_username_input').val() || '').trim();
    const password = String($('#webdav_sync_password_input').val() || '');
    const filename = String($('#webdav_sync_filename_input').val() || '').trim() || DEFAULT_FILENAME;

    if (!url) {
        throw new Error(localize('webdav_sync.url_required', 'WebDAV URL is required'));
    }
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(localize('webdav_sync.url_format', 'WebDAV URL must start with http:// or https://'));
    }
    if (!filename) {
        throw new Error(localize('webdav_sync.filename_required', 'Remote file name is required'));
    }

    return { url, username, password, filename };
}

function buildTargetUrl(credentials) {
    const base = credentials.url.replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(credentials.filename)}`;
}

async function ensureRemoteDirectory(targetUrl, credentials) {
    const dirUrl = targetUrl.slice(0, targetUrl.lastIndexOf('/') + 1);
    try {
        await fetch(dirUrl, {
            method: 'MKCOL',
            headers: { 'Authorization': basicAuthHeader(credentials.username, credentials.password) },
        });
    } catch {
        // Directory creation is best-effort; many servers already have the
        // collection or reject MKCOL entirely. PUT will surface real failures.
    }
}

function startExportJob() {
    return fetch('/api/extensions/data-migration/export', { method: 'POST' })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(await readFailureMessage(response));
            }
            const payload = await response.json();
            if (typeof payload?.job_id !== 'string' || !payload.job_id.trim()) {
                throw new Error(localize('webdav_sync.export_job_id_missing', 'Export job id is missing'));
            }
            return payload.job_id.trim();
        });
}

async function fetchJobStatus(jobId) {
    const response = await fetch(`/api/extensions/data-migration/job?id=${encodeURIComponent(jobId)}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(await readFailureMessage(response));
    }
    return response.json();
}

function updateStatusFromJob(status) {
    const stage = String(status?.stage || '').trim();
    const message = String(status?.message || '').trim();
    const progress = Number(status?.progress_percent);

    const parts = [];
    if (stage) {
        parts.push(stage);
    }
    if (Number.isFinite(progress)) {
        parts.push(`${progress.toFixed(1)}%`);
    }
    if (message) {
        parts.push(message);
    }

    if (parts.length > 0) {
        setStatusText(parts.join(' | '));
    }
}

async function pollUntilTerminal(jobId) {
    while (true) {
        const status = await fetchJobStatus(jobId);
        updateStatusFromJob(status);

        if (TERMINAL_JOB_STATES.has(status.state)) {
            return status;
        }

        await sleep(JOB_POLL_INTERVAL_MS);
    }
}

async function saveExportArchive(jobId) {
    const response = await fetch('/api/extensions/data-migration/export/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
    });
    if (!response.ok) {
        throw new Error(await readFailureMessage(response));
    }
    const payload = await response.json();
    return {
        savedPath: String(payload?.saved_target || ''),
        cleanupError: payload?.cleanup_error ? String(payload.cleanup_error) : null,
    };
}

async function startImportJobFromBlob(blob, filename) {
    const formData = new FormData();
    formData.append('archive', blob, filename);

    const response = await fetch('/api/extensions/data-migration/import', {
        method: 'POST',
        body: formData,
    });
    if (!response.ok) {
        throw new Error(await readFailureMessage(response));
    }

    const payload = await response.json();
    if (typeof payload?.job_id !== 'string' || !payload.job_id.trim()) {
        throw new Error(localize('webdav_sync.import_job_id_missing', 'Import job id is missing'));
    }
    return payload.job_id.trim();
}

async function requestCancelActiveJob() {
    if (!hasActiveJob() || jobState.cancelRequested) {
        return;
    }

    jobState.cancelRequested = true;
    refreshControls();

    try {
        const response = await fetch('/api/extensions/data-migration/job/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobState.jobId }),
        });
        if (!response.ok) {
            throw new Error(await readFailureMessage(response));
        }

        setStatusText(localize('webdav_sync.cancellation_requested', 'Cancellation requested...'));
        toastr.info(localize('webdav_sync.cancellation_requested', 'Cancellation requested'), localize('webdav_sync.push_title', 'Push to WebDAV'));
    } catch (error) {
        jobState.cancelRequested = false;
        refreshControls();
        toastr.error(normalizeCaughtError(error), localize('webdav_sync.cancel_failed', 'Failed to cancel job'));
    }
}

/**
 * Exports user data as a zip blob.
 * - New API (App >= v2.3.0): direct streaming via /api/users/backup, no local file.
 * - Fallback (App < v2.3.0): job-based export via /api/extensions/data-migration/export,
 *   saves to downloads, then reads back. Desktop is fully automatic; mobile shows
 *   a system file picker during the /save step.
 */
async function exportUserBackupArchive() {
    const supportsNewApi = await apiSupportsUserBackup();
    if (supportsNewApi) {
        return exportViaNewApi();
    }
    return exportViaJobFallback();
}

async function exportViaNewApi() {
    const handle = String(getSettings().userHandle || DEFAULT_USER_HANDLE).trim() || DEFAULT_USER_HANDLE;
    const response = await fetch('/api/users/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
    });
    if (!response.ok) {
        throw new Error(await readFailureMessage(response));
    }
    return response.blob();
}

async function exportViaJobFallback() {
    const jobId = await startExportJob();
    const finalStatus = await pollUntilTerminal(jobId);
    if (finalStatus.state !== 'completed') {
        throw new Error(normalizeCaughtError(finalStatus.error || new Error('Export failed')));
    }
    const { savedPath, cleanupError } = await saveExportArchive(jobId);
    if (cleanupError) {
        console.warn('Export cleanup warning:', cleanupError);
    }
    if (!savedPath) {
        throw new Error(localize('webdav_sync.export_saved_path_missing', 'Export saved path is missing'));
    }
    const response = await fetch(savedPath);
    if (!response.ok) {
        throw new Error(`Failed to read saved export: ${response.status}`);
    }
    return response.blob();
}

async function uploadFileToWebdav(file) {
    let credentials;
    try {
        credentials = readCredentials();
    } catch (error) {
        toastr.error(normalizeCaughtError(error), localize('webdav_sync.upload_failed', 'Upload failed'));
        return null;
    }

    const targetUrl = buildTargetUrl(credentials);

    try {
        setStatusText(localize('webdav_sync.uploading', 'Uploading to WebDAV...'));
        await ensureRemoteDirectory(targetUrl, credentials);

        const response = await fetch(targetUrl, {
            method: 'PUT',
            headers: {
                'Authorization': basicAuthHeader(credentials.username, credentials.password),
                'Content-Type': 'application/zip',
            },
            body: file,
        });
        if (!response.ok) {
            throw new Error(await readFailureMessage(response));
        }

        const localizedMsg = localizeTemplate('webdav_sync.uploaded', 'Backup uploaded: ${0}', targetUrl);
        toastr.success(localizedMsg, localize('webdav_sync.push_completed', 'Push completed'), { timeOut: 8000 });
        setStatusText(localize('webdav_sync.upload_completed', 'Upload completed'));
        return true;
    } catch (error) {
        const failureMessage = normalizeCaughtError(error);
        toastr.error(failureMessage, localize('webdav_sync.upload_failed', 'Upload failed'));
        setStatusText(failureMessage);
        return false;
    }
}

async function runExportAndUpload() {
    let blob;
    try {
        blob = await exportUserBackupArchive();
    } catch (error) {
        const failureMessage = normalizeCaughtError(error);
        toastr.error(failureMessage, localize('webdav_sync.export_failed', 'Export failed'));
        setStatusText(failureMessage);
        return false;
    }

    return uploadFileToWebdav(blob);
}

async function runPush() {
    if (hasActiveJob()) {
        toastr.warning(localize('webdav_sync.job_running', 'A job is already running'));
        return;
    }

    markJobStarting();
    try {
        const success = await runExportAndUpload();
        if (success) {
            const now = new Date().toLocaleString();
            const settings = getSettings();
            settings.lastAutoSyncTime = now;
            persistSettings();
            setStatusText(localizeTemplate('webdav_sync.synced_at', 'Last sync: ${0}', now));
        }
        stopJobTracking();
    } catch (error) {
        const failureMessage = normalizeCaughtError(error);
        toastr.error(failureMessage, localize('webdav_sync.push_failed', 'Push failed'));
        setStatusText(failureMessage);
        stopJobTracking();
    }
}

async function runPull() {
    if (hasActiveJob()) {
        toastr.warning(localize('webdav_sync.job_running', 'A job is already running'));
        return;
    }

    const confirmed = window.confirm(localize('webdav_sync.pull_confirm', 'Pulling will merge into your current local data directory (same-path files will be overwritten). Continue?'));
    if (!confirmed) {
        return;
    }

    markJobStarting();
    try {
        const credentials = readCredentials();
        const targetUrl = buildTargetUrl(credentials);

        setStatusText(localize('webdav_sync.downloading', 'Downloading backup from WebDAV...'));
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: { 'Authorization': basicAuthHeader(credentials.username, credentials.password) },
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(await readFailureMessage(response));
        }

        const blob = await response.blob();
        const jobId = await startImportJobFromBlob(blob, credentials.filename);
        startJobTracking(jobId);

        const finalStatus = await pollUntilTerminal(jobId);
        if (finalStatus.state === 'completed') {
            toastr.success(localize('webdav_sync.imported_reload', 'Backup imported. Reloading...'), localize('webdav_sync.pull_completed', 'Pull completed'), { timeOut: 6000 });
            setStatusText(localize('webdav_sync.import_completed', 'Import completed'));
            setTimeout(() => location.reload(), 800);
            return;
        }

        if (finalStatus.state === 'cancelled') {
            toastr.info(localize('webdav_sync.import_cancelled', 'Import cancelled'), localize('webdav_sync.pull_cancelled', 'Pull cancelled'));
            setStatusText(localize('webdav_sync.import_cancelled', 'Import cancelled'));
            return;
        }

        throw new Error(normalizeCaughtError(finalStatus.error || new Error('Import failed')));
    } catch (error) {
        const failureMessage = normalizeCaughtError(error);
        toastr.error(failureMessage, localize('webdav_sync.pull_failed', 'Pull failed'));
        setStatusText(failureMessage);
        stopJobTracking();
    }
}

async function runAutoPushOnce() {
    if (isAutoSyncBusy()) {
        return;
    }
    autoPushPending = true;
    try {
        const success = await runExportAndUpload();
        if (success) {
            const now = new Date().toLocaleString();
            const settings = getSettings();
            settings.lastAutoSyncTime = now;
            persistSettings();
            setStatusText(localizeTemplate('webdav_sync.synced_at', 'Last sync: ${0}', now));
        }
    } catch (error) {
        // runExportAndUpload already surfaces errors via toastr; we just need to unlock.
    } finally {
        autoPushPending = false;
    }
    if (autoSyncDirty) {
        autoSyncDirty = false;
        runAutoPushOnce();
    }
}

/**
 * Schedules periodic auto-push. On mobile with an old App (< v2.3.0) that lacks
 * /api/users/backup, the job-based fallback would trigger a system file picker
 * on every interval tick, disrupting the user. In that case we disable the
 * interval and show a one-time notification.
 */
async function scheduleAutoPush() {
    const settings = getSettings();
    if (autoPushIntervalId !== null) {
        clearInterval(autoPushIntervalId);
        autoPushIntervalId = null;
    }

    if (!settings.autoPushEnabled || !settings.url) {
        return;
    }

    // On mobile with an old App, auto-push is unsupported — show one-time notice.
    if (isAndroidRuntime() || isIosRuntime()) {
        const supportsNewApi = await apiSupportsUserBackup();
        if (!supportsNewApi) {
            showOldAppMobileNoticeOnce();
            return;
        }
    }

    autoPushIntervalId = setInterval(() => {
        if (isAutoSyncBusy()) {
            autoSyncDirty = true;
            return;
        }
        runAutoPushOnce();
    }, (Number(settings.syncIntervalMinutes) || DEFAULT_SYNC_INTERVAL_MINUTES) * 60 * 1000);
}

function showOldAppMobileNoticeOnce() {
    if (sessionStorage.getItem(OLD_APP_VERSION_NOTICE_KEY)) {
        return;
    }
    sessionStorage.setItem(OLD_APP_VERSION_NOTICE_KEY, '1');
    toastr.warning(
        localize('webdav_sync.old_app_mobile_unsupported', 'Auto-push is unavailable on mobile with this App version. Please upgrade to TauriTavern v2.3.0+ or use manual push on desktop.'),
        localize('webdav_sync.push_title', 'Push to WebDAV')
    );
    setStatusText(localize('webdav_sync.old_app_mobile_unsupported', 'Auto-push unavailable on mobile (App < v2.3.0)'));
}

function onEventDebounced() {
    const settings = getSettings();
    if (!settings.autoPushEnabled) {
        return;
    }
    if (isAutoSyncBusy()) {
        autoSyncDirty = true;
        return;
    }
    if (autoPushDebounceId !== null) {
        clearTimeout(autoPushDebounceId);
    }
    autoPushDebounceId = setTimeout(() => {
        autoPushDebounceId = null;
        if (isAutoSyncBusy()) {
            autoSyncDirty = true;
            return;
        }
        runAutoPushOnce();
    }, AUTO_PUSH_DEBOUNCE_MS);
}

function onSaveClick() {
    try {
        const credentials = readCredentials();
        const settings = getSettings();
        settings.url = credentials.url;
        settings.username = credentials.username;
        settings.filename = credentials.filename;
        settings.userHandle = String($('#webdav_sync_user_handle_input').val() || '').trim() || DEFAULT_USER_HANDLE;
        settings.syncIntervalMinutes = Number($('#webdav_sync_interval_input').val()) || DEFAULT_SYNC_INTERVAL_MINUTES;
        settings.autoPushEnabled = $('#webdav_sync_auto_push_toggle').is(':checked');
        settings.autoPullEnabled = $('#webdav_sync_auto_pull_toggle').is(':checked');
        persistSettings();

        const password = String($('#webdav_sync_password_input').val() || '');
        if (password) {
            writeSecret(SECRET_KEY, password)
                .then(() => {
                    toastr.success(localize('webdav_sync.settings_saved', 'Settings saved'), localize('webdav_sync.push_title', 'Push to WebDAV'));
                })
                .catch((error) => {
                    toastr.error(normalizeCaughtError(error), localize('webdav_sync.password_save_failed', 'Failed to save password'));
                });
        } else {
            toastr.success(localize('webdav_sync.settings_saved', 'Settings saved'), localize('webdav_sync.push_title', 'Push to WebDAV'));
        }

        scheduleAutoPush();
    } catch (error) {
        toastr.error(normalizeCaughtError(error), localize('webdav_sync.settings_save_failed', 'Failed to save settings'));
    }
}

jQuery(async () => {
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings2').append(html);

    const settings = getSettings();
    $('#webdav_sync_url_input').val(settings.url || '');
    $('#webdav_sync_username_input').val(settings.username || '');
    $('#webdav_sync_filename_input').val(settings.filename || DEFAULT_FILENAME);
    $('#webdav_sync_user_handle_input').val(settings.userHandle || DEFAULT_USER_HANDLE);
    $('#webdav_sync_interval_input').val(settings.syncIntervalMinutes || DEFAULT_SYNC_INTERVAL_MINUTES);
    $('#webdav_sync_auto_push_toggle').prop('checked', Boolean(settings.autoPushEnabled));
    $('#webdav_sync_auto_pull_toggle').prop('checked', Boolean(settings.autoPullEnabled));

    const storedPassword = await findSecret(SECRET_KEY);
    if (storedPassword) {
        $('#webdav_sync_password_input').val(storedPassword);
    }

    refreshControls();
    setStatusText(settings.lastAutoSyncTime
        ? localizeTemplate('webdav_sync.synced_at', 'Last sync: ${0}', settings.lastAutoSyncTime)
        : localize('webdav_sync.ready', 'Ready')
    );

    $('#webdav_sync_save_button').on('click', onSaveClick);
    $('#webdav_sync_push_button').on('click', runPush);
    $('#webdav_sync_pull_button').on('click', runPull);
    $('#webdav_sync_cancel_button').on('click', requestCancelActiveJob);

    eventSource.on(event_types.GENERATION_ENDED, onEventDebounced);
    eventSource.on(event_types.MESSAGE_UPDATED, onEventDebounced);
    eventSource.on(event_types.MESSAGE_EDITED, onEventDebounced);
    eventSource.on(event_types.MESSAGE_DELETED, onEventDebounced);
    eventSource.on(event_types.MESSAGE_SWIPED, onEventDebounced);
    eventSource.on(event_types.MESSAGE_FILE_EMBEDDED, onEventDebounced);
    eventSource.on(event_types.CHAT_CHANGED, onEventDebounced);
    eventSource.on(event_types.CHAT_CREATED, onEventDebounced);
    eventSource.on(event_types.CHAT_RENAMED, onEventDebounced);
    eventSource.on(event_types.CHAT_DELETED, onEventDebounced);
    eventSource.on(event_types.GROUP_UPDATED, onEventDebounced);
    eventSource.on(event_types.GROUP_CHAT_CREATED, onEventDebounced);
    eventSource.on(event_types.GROUP_CHAT_DELETED, onEventDebounced);
    eventSource.on(event_types.CHARACTER_EDITED, onEventDebounced);
    eventSource.on(event_types.CHARACTER_DELETED, onEventDebounced);
    eventSource.on(event_types.CHARACTER_DUPLICATED, onEventDebounced);
    eventSource.on(event_types.CHARACTER_RENAMED, onEventDebounced);
    eventSource.on(event_types.PERSONA_CREATED, onEventDebounced);
    eventSource.on(event_types.PERSONA_UPDATED, onEventDebounced);
    eventSource.on(event_types.PERSONA_RENAMED, onEventDebounced);
    eventSource.on(event_types.PERSONA_DELETED, onEventDebounced);
    eventSource.on(event_types.WORLDINFO_UPDATED, onEventDebounced);
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, onEventDebounced);
    eventSource.on(event_types.PRESET_CHANGED, onEventDebounced);
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, onEventDebounced);
    eventSource.on(event_types.SECRET_WRITTEN, onEventDebounced);
    eventSource.on(event_types.SECRET_DELETED, onEventDebounced);
    eventSource.on(event_types.SECRET_ROTATED, onEventDebounced);
    eventSource.on(event_types.SETTINGS_UPDATED, onEventDebounced);

    await scheduleAutoPush();

    if (settings.autoPushEnabled && settings.url) {
        if (isAutoSyncBusy()) {
            autoSyncDirty = true;
            setStatusText(localize('webdav_sync.auto_push_running', 'Auto-push is currently running'));
        } else {
            runAutoPushOnce();
        }
    }
});
