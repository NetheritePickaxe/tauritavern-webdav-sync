# TauriTavern WebDAV Sync

A pure-frontend third-party extension for [TauriTavern](https://github.com/Darkatse/TauriTavern) that syncs your data directory to any WebDAV server (r2-webdav, Nextcloud, ownCloud, ...). Built entirely on existing TauriTavern commands and routes — no core code or capability changes are required.

## Features

- **Push**: exports your data directory to a zip archive and uploads it to the WebDAV server.
- **Pull**: downloads the remote zip and imports it into your local data directory (same-path files are overwritten).
- **Credentials**: the WebDAV password is stored via the built-in SecretService; URL / username / file name are kept in extension settings.
- **Full-library snapshot**: sync is whole-library zip-based (export → upload / download → import), not incremental.

## Installation

1. Push this repository to any Git host (GitHub, GitLab, ...).
2. In TauriTavern, open the **Extensions** panel → **Install extension**.
3. Paste the repository URL and install. The extension is installed as a third-party extension.
4. Reload the app, then open **Extensions** → **WebDAV Sync** in the settings.

## Configuration

| Field      | Description                                             |
|------------|---------------------------------------------------------|
| WebDAV URL | Target directory URL, must end with `/` (e.g. `https://dav.example.com/tauritavern/`) |
| Username   | WebDAV username                                         |
| Password   | WebDAV password (stored as a secret)                    |
| File name  | Remote file name (default `tauritavern-backup.zip`)     |

### r2-webdav

Use the bucket endpoint, e.g. `https://<account>.r2.cloudflarestorage.com/<bucket>/tauritavern/`.
Use an R2 API token (Access Key ID / Secret Access Key) as the username / password.

### Nextcloud / ownCloud

Use the DAV endpoint, e.g. `https://<host>/remote.php/dav/files/<username>/tauritavern/`.
The target directory must already exist on the server.

## Usage

### Push (local → WebDAV)

1. Click **Push to WebDAV**. TauriTavern exports your data to `tauritavern-data-<timestamp>.zip` in the Downloads folder.
2. A file picker opens — select the just-exported zip file to finish the upload to WebDAV.

> The exported zip is written to your Downloads folder by TauriTavern's export command. Because the TauriTavern filesystem capability does not expose the Downloads folder for reads on desktop, the extension asks you to pick that file in the picker instead of reading it directly. This is the same interaction used by the built-in data migration import.

### Pull (WebDAV → local)

1. Click **Pull from WebDAV**.
2. Confirm the merge prompt. TauriTavern downloads the remote zip and imports it; the app reloads when done.

## Boundaries

- Desktop only. Mobile (`isAndroidRuntime` / `isIosRuntime`) flows are not handled by this extension.
- Pull is a whole-directory merge: files present locally at the same relative paths as in the remote zip are overwritten.
- Push overwrites the configured remote file on each run (single remote snapshot, no server-side versioning).
- The WebDAV password is stored in plaintext JSON (`secrets.json`, the same as every other TauriTavern/SillyTavern secret).

## Development

- `manifest.json` — extension manifest (`js` points to `index.js`).
- `index.js` — main logic (module entry, imported by TauriTavern's extension loader).
- `settings.html` — settings panel, rendered into `#extensions_settings2`.

The extension uses no build step; it is plain ES modules.
