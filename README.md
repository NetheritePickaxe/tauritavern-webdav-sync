# TauriTavern WebDAV 同步

TauriTavern 的纯前端第三方扩展，将你的数据目录同步到任意 WebDAV 服务器（r2-webdav、Nextcloud、ownCloud 等）。完全基于现有 TauriTavern 命令与路由构建，无需修改核心代码或 capability 配置。

## 功能

- **推送**：导出数据目录为 zip 压缩包，直接上传到 WebDAV 服务器（无需文件选择器）。
- **拉取**：从 WebDAV 下载 zip，导入到本地数据目录（相同路径文件会被覆盖）。
- **自动推送**：监听聊天事件（消息发送/编辑/删除、角色变更、聊天切换）并在 5 秒防抖后自动推送；同时支持定时兜底推送。
- **自动拉取（可选）**：默认关闭，开启后定时从 WebDAV 拉取并合并到本地。
- **凭据**：WebDAV 密码通过内置 SecretService 存储；URL / 用户名 / 文件名保存在扩展设置中。
- **整库快照**：同步基于整库 zip 快照（导出 → 上传 / 下载 → 导入），非增量。

## 安装

1. 将此仓库推送到任意 Git 托管平台（GitHub、GitLab 等）。
2. 在 TauriTavern 中打开 **扩展** 面板 → **安装扩展**。
3. 粘贴仓库 URL 并完成安装。扩展会以第三方扩展的形式安装。
4. 重新加载应用，然后在扩展设置中找到 **WebDAV Sync**。

## 配置

| 字段 | 说明 |
|------|------|
| WebDAV URL | 目标目录 URL，必须以 `/` 结尾（例如 `https://dav.example.com/tauritavern/`）|
| 用户名 | WebDAV 用户名 |
| 密码 | WebDAV 密码（以密钥形式存储）|
| 文件名 | 远程文件名（默认 `tauritavern-backup.zip`）|
| 用户目录 | TauriTavern 用户目录名（默认 `default-user`）|
| 定时间隔 | 定时自动推送间隔（分钟，默认 30）|

### r2-webdav

使用桶端点，例如 `https://<account>.r2.cloudflarestorage.com/<bucket>/tauritavern/`。
使用 R2 API 令牌（Access Key ID / Secret Access Key）作为用户名和密码。

### Nextcloud / ownCloud

使用 DAV 端点，例如 `https://<host>/remote.php/dav/files/<username>/tauritavern/`。
目标目录需在服务器上预先存在。

## 使用

### 推送（本地 → WebDAV）

点击 **推送到 WebDAV**。TauriTavern 会导出数据并直接上传到 WebDAV，全程无需手动选择文件。

### 拉取（WebDAV → 本地）

点击 **从 WebDAV 拉取**，确认后 TauriTavern 会下载远程 zip 并导入；完成后应用自动重新加载。

### 自动同步

- **自动推送**：开启后，在变更批次落定后触发（尾部防抖 5 秒内无新变更才推送），避免在流式生成中途发起全量导出；推送期间到达的新变更会打标记并在当前推送结束后立即补推，不会丢失。事件覆盖 GENERATION_ENDED、消息编辑/删除、聊天/角色/群组/设置等数据变更事件。每隔 N 分钟还会做一次定时兜底（防止无事件变更被遗漏）。
- **启动时推送**：应用重新加载完成后若已开启且已配置，立即推送一次。
- **自动拉取**：默认关闭，开启后会在相同定时周期内自动从 WebDAV 拉取并合并。由于拉取会覆盖本地相同路径的文件，建议谨慎开启。

## 边界

- 仅支持桌面端。移动端（`isAndroidRuntime` / `isIosRuntime`）流程未在此扩展中实现。
- 拉取是整目录合并操作：本地与远程 zip 中相同相对路径的文件会被覆盖。
- 每次推送会覆盖远程配置的文件名（单快照，服务器端无版本历史）。
- WebDAV 密码以明文 JSON 存储（`secrets.json`），与 TauriTavern/SillyTavern 其他密钥的方式相同。
- 自动推送是否包含 API 密钥（`secrets.json`）取决于宿主设置的 `allowKeysExposure`；如需不含密钥，请在宿主设置中关闭该选项。

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
