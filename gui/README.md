# 切图仔 GUI

`img.sh` 的桌面版，支持 macOS / Windows / Linux。基于 Electron + React + Vite。

这里是开发文档。使用说明见仓库根目录的 [README](../README.md)（[简体中文](../docs/README.zh-CN.md)）。

![](build/icon.png)

## 功能

**主界面（类 Codex 布局）**

- 左侧：历史任务列表。按今天 / 昨天 / 近 7 天等分组，支持搜索、双击重命名、删除。运行中的任务显示加载图标。
- 右侧：工作区。每次生成是一条记录：右边是提示词和参考图，下面是结果宫格，带状态、耗时和参数标签。
- 底部输入框：不是聊天，回车后直接调用生图接口。

**输入框（对应 img.sh 的全部参数）**

| img.sh | GUI |
| --- | --- |
| `"提示词"` | 输入框；Enter 生成，Shift+Enter 换行 |
| `-n 数量` | 数量步进器，1–20 张，按设置里的并发数同时请求（所有任务共用这个上限，超出的排队） |
| `-i 原图`（可多张） | 🖼 按钮、拖入或粘贴图片；有参考图时自动切换为图生图（`/images/edits`） |
| `-m 蒙版` | 参考图不少于 2 张时，可以把其中一张标记为「蒙版」 |
| 输出文件名 | 「更多选项」→ 输出文件名，支持子目录；多张时自动加 `-1`、`-2` 后缀，同名文件已存在时加 ` (2)`，不覆盖；扩展名以图片实际格式为准 |
| `--dry-run` | `</>` 按钮：预览即将发送的请求，Key 打码显示 |
| `IMG_MODEL` / `IMG_SIZE` | 模型、尺寸、质量下拉框；也可以直接填自定义值。尺寸写成「宽x高」、比例（如 `16:9`，有些中转站只认比例）或 auto，`×`、`✖`、`*`、全角字符会自动换成标准写法。服务商自定义的写法（如 `2K`）可以在设置 → 可选尺寸里添加，会标成「非标准」并原样发送；旧版本存下的写法也原样保留 |
| `IMG_JOBS` | 设置 → 并发数（所有任务共用） |
| `IMG_CONFIG` / `img.config` | 设置 → 「从 img.config 导入」 |

另外支持：

- 批量模式：「更多选项」里打开「每行一个提示词」，每一行单独生成一组。
- 结果图：点击看大图（←/→ 切换）；可以作为参考图、复制到剪贴板、在文件夹中显示、另存为，也可以直接拖到 Figma、PS 等软件里。
- 每条记录都可以「重新生成」「编辑后重试」（把提示词、参考图和参数填回输入框）、「请求详情」、「停止」。
- 失败的那张会显示接口返回的错误信息，其他张不受影响。
- 每张结果图左下角显示实际尺寸。和请求的尺寸不一致时标成橙色，生成记录上会出现「尺寸未生效」或「尺寸有偏差」，悬停可以看到详情。
- 应用被关闭时还在跑的任务，下次打开会标记为「已中断」。

**设置页**

- 接口地址、API Key：Key 用系统钥匙串加密保存。另有「测试连接」，和可选的代理（留空则跟随系统代理）。
- 可用模型列表和默认模型（星标）；也可以「从接口获取」`/v1/models` 后点选添加。
- 默认尺寸、质量、数量、并发数、超时；可选尺寸和可选质量列表都能编辑。
- **把尺寸写进提示词**：有些中转接口会忽略 `size` 参数（比如用 ChatGPT / Codex 账号池代调的渠道），生成的图和选的尺寸对不上。打开后会在提示词末尾加上「输出图片尺寸为 1536x1024（横版，3:2）」这样的描述，`size` 参数照常发送。这种渠道下模型通常只能大致照做，精确尺寸需要在本地裁剪。
- **Agents 提示词**：开启后，每次请求都会把这段内容加在提示词最前面，中间空一行。生成记录上会显示 `Agents` 标签，悬停可以看到实际发送的完整提示词。
- 图片保存目录（默认 `~/Pictures/切图仔`）、主题（跟随系统 / 浅色 / 深色）。
- 界面语言：简体中文、繁體中文、English、日本語、한국어、Español、Français、Deutsch、Português、Русский，默认跟随系统。选了立即生效，不用点保存。

接口行为与 `img.sh` 保持一致：

- 接口地址会去掉末尾的 `/images/xxx`，并补上 `/v1`。
- 每次请求固定 `n=1`，按数量重复发送多次。
- 单张参考图用 `image` 字段，多张用 `image[]`。
- 响应兼容 `data` / `images` / `results` 三种数组，以及 `b64_json` / `b64` / `image_base64` / `base64` / `url` / `image_url` 这些字段。

## 开发

```bash
cd gui
npm install          # 如果 Electron 二进制下载失败，见下方「网络问题」
npm run dev          # Vite 热更新 + Electron
npm start            # 构建前端后用 Electron 运行
npm test             # 单元测试，不调用真实接口
```

测试在 `test/` 目录，用的是 Node 自带的 `node:test`：

- `generator.test.js`：并发上限、取消、各种响应格式和无效响应、请求体、输出命名。
- `store.test.js`：历史记录的持久化和中断恢复，两次保存设置交错时不会互相覆盖。
- `draft.test.js`：保存设置后输入框草稿怎么跟着变（`src/draft.mjs`）。
- `i18n.test.js`：每种语言的键、占位符和复数形式是否齐全，系统语言能否对应到支持的语言。
- `imgsh.test.js`：在本地起一个假接口，实际运行 `img.sh`。只在 Linux 上跑，需要 bash、curl、jq。

CI 会在打包前先跑一遍测试。

## 打包

```bash
npm run dist:mac     # 在 macOS 上执行：dmg + zip（arm64 / x64）
npm run dist:win     # 在 Windows 上执行：NSIS 安装包 + 便携版
npm run dist:linux   # 在 Linux 上执行：AppImage + deb
```

产物输出在 `release/` 目录。各平台的安装包要在对应系统上打：dmg 依赖 macOS 自带的 `hdiutil`，签名也只能在 macOS 上做。

### macOS

需要一台 Mac（Apple Silicon 或 Intel 都可以，会同时打出 arm64 和 x64 两套），以及 Node.js 22.12 或更高版本。

```bash
# 把 gui/ 拷到 Mac 上，不要带 node_modules/ 和 release/（里面是 Linux 版的 Electron）
cd gui
npm install
npm run dist:mac
```

产物：

- `release/qietuzai-<版本号>-mac-arm64.dmg`：Apple Silicon（M 系列芯片）
- `release/qietuzai-<版本号>-mac-x64.dmg`：Intel 芯片
- 另外还有对应的 `.zip`，解压就是 `切图仔.app`

没有 Mac 的话，可以用 GitHub Actions。仓库根目录（`切图仔/`）带了 `.github/workflows/build.yml`，推送 `v*` tag 或者在 Actions 页面手动触发，就会在 macOS、Windows、Linux 上各打一份，打完在这次运行的 Artifacts 里下载。

### macOS 签名

没有 Apple 开发者证书时，用的是临时签名（`package.json` 里的 `mac.identity: "-"`）。这样 Apple Silicon 上能正常运行，但因为没有经过 Apple 公证，第一次打开会被系统拦下：

- macOS 15 及以上：先双击打开一次，再到「系统设置 → 隐私与安全性」页面底部点「仍要打开」。
- macOS 14 及以下：右键 →「打开」。
- 或者在终端执行 `xattr -dr com.apple.quarantine /Applications/切图仔.app`。

如果要正式分发给别人，需要 Apple Developer 账号：删掉 `mac.identity` 和 `mac.hardenedRuntime` 两项，再按 [electron-builder 的说明](https://www.electron.build/code-signing-mac) 配置证书和公证用的环境变量。

### 其他

- `package.json` 里的 `homepage` 不能删，打 deb 包时必须有这个字段。

## 多语言

界面文字都在 `shared/locales/` 下，键以 `zh-CN.mjs` 为准：

- 加新文字：先在 `zh-CN.mjs` 里加键，再给其他 9 个文件补上翻译。界面里用 `const t = useT()` 取翻译函数，主进程直接用 `i18n.mjs` 导出的 `t`。
- 占位符写成 `{name}`，调用时 `t('key', { name })`。
- 跟数量有关的文字写成 `{ one: '…', other: '…' }`（俄语还要 `few`、`many`），调用时传 `count`。
- `npm test` 会检查每种语言的键、占位符和复数形式有没有缺。

主进程的报错、对话框标题、写进提示词的尺寸描述也跟界面用同一种语言（`main.js` 里的 `applyLanguage()`）。历史记录里已经存下的错误信息不会跟着换语言。

## 网络问题

Electron 二进制默认从 GitHub 下载。Node 自带的 fetch 不会读取 `HTTPS_PROXY`，有代理时可以这样装：

```bash
NODE_USE_ENV_PROXY=1 npm install
# 或者使用镜像
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## 目录结构

```
gui/
├── electron/
│   ├── main.js        # 主进程：窗口、IPC、本地图片协议 qtz://、任务调度
│   ├── generator.js   # 生图核心逻辑（从 img.sh 移植）
│   ├── store.js       # 设置 / 历史记录持久化
│   └── preload.js     # 暴露给页面的 window.api
├── shared/            # 主进程和界面共用：尺寸写法规则、多语言（i18n.mjs）
│   └── locales/       # 各语言的界面文字，一种语言一个文件
├── test/              # 单元测试（npm test）
├── src/               # React 界面
│   ├── App.jsx
│   └── components/    # Sidebar / Workspace / Composer / RunCard / Settings / Lightbox
└── build/icon.*       # 应用图标
```

数据保存在系统的应用数据目录（设置页「关于」里可以直接打开）：

- `settings.json`：设置
- `history.json`：历史记录
- `inputs/`：参考图副本。这样即使原图被移动，历史记录依然能用。
