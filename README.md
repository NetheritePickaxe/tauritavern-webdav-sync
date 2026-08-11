# TauriTavern WebDAV 同步

TauriTavern 的纯前端第三方扩展，将你的数据目录同步到任意 WebDAV 服务器（r2-webdav、Nextcloud、ownCloud 等）。完全基于现有 TauriTavern 命令与路由构建，无需修改核心代码或 capability 配置。

## 功能

- **推送**：导出数据目录为 zip 压缩包，上传到 WebDAV 服务器。
- **拉取**：从 WebDAV 下载 zip，导入到本地数据目录（相同路径文件会被覆盖）。
- **凭据**：WebDAV 密码通过内置 SecretService 存储；URL / 用户名 / 文件名保存在扩展设置中。
- **整库快照**：同步基于整库 zip 快照（导出 → 上传 / 下载 → 导入），非增量。

## 安装

1. 将此仓库推送到任意 Git 托管平台（GitHub、GitLab 等）。
2. 在 TauriTavern 中打开 **扩展** 面板 → **安装扩展**。
3. 粘贴仓库 URL 并完成安装。扩展会以第三方扩展的形式安装。
4. 重新加载应用，然后在扩展设置中找到 **WebDAV Sync**。

## 配置

| 字段       | 说明                                                     |
|------------|----------------------------------------------------------|
| WebDAV URL | 目标目录 URL，必须以 `/` 结尾（例如 `https://dav.example.com/tauritavern/`）|
| 用户名     | WebDAV 用户名                                            |
| 密码       | WebDAV 密码（以密钥形式存储）                             |
| 文件名     | 远程文件名（默认 `tauritavern-backup.zip`）               |

### r2-webdav

使用桶端点，例如 `https://<account>.r2.cloudflarestorage.com/<bucket>/tauritavern/`。
使用 R2 API 令牌（Access Key ID / Secret Access Key）作为用户名和密码。

### Nextcloud / ownCloud

使用 DAV 端点，例如 `https://<host>/remote.php/dav/files/<username>/tauritavern/`。
目标目录需在服务器上预先存在。

## 使用

### 推送（本地 → WebDAV）

1. 点击 **推送到 WebDAV**。TauriTavern 会将数据导出到下载文件夹中的 `tauritavern-data-<timestamp>.zip`。
2. 文件选择器自动弹出 —— 选中刚刚导出的 zip 文件完成上传。

> 导出的 zip 由 TauriTavern 的导出命令写入下载文件夹。由于桌面端 TauriTavern 文件系统权限未开放 Downloads 的读取，扩展无法直接读取该文件，因此需要你通过选择器选中它。这与内置的数据迁移导入交互方式一致。

### 拉取（WebDAV → 本地）

1. 点击 **从 WebDAV 拉取**。
2. 确认合并提示。TauriTavern 会下载远程 zip 并导入；完成后应用自动重新加载。

## 边界

- 仅支持桌面端。移动端（`isAndroidRuntime` / `isIosRuntime`）流程未在此扩展中实现。
- 拉取是整目录合并操作：本地与远程 zip 中相同相对路径的文件会被覆盖。
- 每次推送会覆盖远程配置的文件名（单快照，服务器端无版本历史）。
- WebDAV 密码以明文 JSON 存储（`secrets.json`），与 TauriTavern/SillyTavern 其他密钥的方式相同。

## 本地化

本扩展支持简体中文与繁体中文。翻译文件位于 `locales/zh-cn.json` 与 `locales/zh-tw.json`，key 全部带 `webdav_sync.` 前缀以避免与全局翻译冲突。

如需新增语言：
1. 在 `manifest.json` 的 `i18n` 字段添加新的映射（例如 `"fr": "locales/fr.json"`）。
2. 创建对应的 `locales/<code>.json`，key 与前两个文件保持一致。
3. 翻译所有值。

## 开发

- `manifest.json` — 扩展清单（`js` 指向 `index.js`，`i18n` 声明本地化文件）。
- `index.js` — 核心逻辑（模块入口，由 TauriTavern 扩展加载器动态导入）。
- `settings.html` — 设置面板，渲染到 `#extensions_settings2`。
- `locales/zh-cn.json` / `locales/zh-tw.json` — 翻译文件。

本扩展无需构建步骤，直接使用 ES modules 运行。
