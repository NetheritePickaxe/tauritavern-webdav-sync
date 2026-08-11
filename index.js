import { extension_settings, renderExtensionTemplateAsync, saveSettingsDebounced } from '../../../extensions.js';
import { translate } from '../../../i18n.js';

const MODULE_NAME = (() => {
    const match = import.meta.url.match(/\/scripts\/extensions\/(third-party\/[^/]+)\//);
    return match ? match[1] : 'webdav-sync';
})();

const SECRET_KEY = 'webdav_sync_password';
const JOB_POLL_INTERVAL_MS = 1200;
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_FILENAME = 'tauritavern-backup.zip';

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
    lastExportSavedPath: '',
};

function getSettings() {
    return (extension_settings.webdav_sync ??= {});
}

function persistSettings() {
    saveSettingsDebounced(MODULE_NAME);
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

function onSaveClick() {
    try {
        const credentials = readCredentials();
        const settings = getSettings();
        settings.url = credentials.url;
        settings.username = credentials.username;
        settings.filename = credentials.filename;
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
    } catch (error) {
        toastr.error(normalizeCaughtError(error), localize('webdav_sync.settings_save_failed', 'Failed to save settings'));
    }
}

async function uploadFileToWebdav(file) {
    let credentials;
    try {
        credentials = readCredentials();
    } catch (error) {
        toastr.error(normalizeCaughtError(error), localize('webdav_sync.upload_failed', 'Upload failed'));
        return;
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
    } catch (error) {
        const failureMessage = normalizeCaughtError(error);
        toastr.error(failureMessage, localize('webdav_sync.upload_failed', 'Upload failed'));
        setStatusText(failureMessage);
    }
}

function onUploadInputChange(event) {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    input.value = '';

    if (file) {
        uploadFileToWebdav(file);
    }
}

async function runPush() {
    if (hasActiveJob()) {
        toastr.warning(localize('webdav_sync.job_running', 'A job is already running'));
        return;
    }

    markJobStarting();
    try {
        const jobId = await startExportJob();
        startJobTracking(jobId);

        const finalStatus = await pollUntilTerminal(jobId);
        if (finalStatus.state !== 'completed') {
            throw new Error(normalizeCaughtError(finalStatus.error || new Error('Export failed')));
        }

        const saveResult = await saveExportArchive(jobId);
        if (saveResult.cleanupError) {
            toastr.warning(saveResult.cleanupError, localize('webdav_sync.export_cleanup_failed', 'Export cleanup failed'));
        }

        const savedPath = saveResult.savedPath;
        jobState.lastExportSavedPath = savedPath;
        stopJobTracking();

        if (savedPath) {
            const localizedPrompt = localizeTemplate('webdav_sync.export_saved_prompt', 'Export saved: ${0}. Select this file in the picker to finish the upload.', savedPath);
            setStatusText(localizeTemplate('webdav_sync.export_saved_status', 'Export saved: ${0}', savedPath));
            toastr.success(localizedPrompt, localize('webdav_sync.push_title', 'Push to WebDAV'), { timeOut: 9000 });
        } else {
            setStatusText(localize('webdav_sync.export_saved', 'Export saved'));
            toastr.success(localize('webdav_sync.select_exported', 'Select the exported zip file to finish the upload.'), localize('webdav_sync.push_title', 'Push to WebDAV'), { timeOut: 9000 });
        }

        $('#webdav_sync_upload_input').trigger('click');
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

jQuery(async () => {
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings2').append(html);

    const settings = getSettings();
    $('#webdav_sync_url_input').val(settings.url || '');
    $('#webdav_sync_username_input').val(settings.username || '');
    $('#webdav_sync_filename_input').val(settings.filename || DEFAULT_FILENAME);

    const storedPassword = await findSecret(SECRET_KEY);
    if (storedPassword) {
        $('#webdav_sync_password_input').val(storedPassword);
    }

    refreshControls();
    setStatusText(localize('webdav_sync.ready', 'Ready'));

    $('#webdav_sync_save_button').on('click', onSaveClick);
    $('#webdav_sync_push_button').on('click', runPush);
    $('#webdav_sync_pull_button').on('click', runPull);
    $('#webdav_sync_cancel_button').on('click', requestCancelActiveJob);
    $('#webdav_sync_upload_input').on('change', onUploadInputChange);
});
