# Comment Collector

B站、YouTube、X 的收藏各存各的，想翻之前存过的东西得挨个站点找。这个脚本把它们合成一个**跨站收藏夹**：一处搜索全部视频、评论和推文，还能导出成断网可看的离线副本。顺带给 B站 评论区加上 IP 属地与粉丝数。

## ▣ Installation / 安装

浏览器需先装油猴插件：[Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。

```bash
# macOS
open https://raw.githubusercontent.com/0xlxx/comment-collector/main/comment-collector.user.js

# Windows (PowerShell)
start https://raw.githubusercontent.com/0xlxx/comment-collector/main/comment-collector.user.js
```

打开链接后 Tampermonkey 会弹出安装页，确认即可。它会请求**跨站存储权限**（`GM_getValue` / `GM_setValue`）——跨站搜索依赖它；不同意也不会报错，只是降级为单站收藏夹。

脚本自身带 `@updateURL`，之后会自动更新。

## ▣ Quick Start / 快速上手

安装后打开任意 B站 / YouTube / X 页面，右下角出现悬浮球。

```
收藏
  B站 视频      视频页工具栏「临时收藏」
  B站 评论      评论操作栏的书签图标
  YouTube       视频操作栏收藏按钮 / 评论下方按钮
  X             推文操作栏收藏按钮

查看
  悬浮球 → 我的收藏           ← 三个站点的收藏都在这里
  搜索框                      ← 搜标题/评论/作者，也可以直接打 b站、youtube、x

离线
  收藏面板右上角「离线」→ 同步到文件夹
  断网时双击 <目录>/comment-collector-offline/index.html
```

悬浮球可拖拽，靠近屏幕边缘自动半隐藏；位置会记住。

B站 支持**所有子域**（`www` / `t` / `space` / `search` / `live` / `passport` / `message` …），任意页面都能打开收藏夹。

## ▣ 功能 / Features

### 跨站收藏夹
- 任意站点打开面板，都能看到**全部站点**的收藏，卡片带站点标签
- 跨站搜索：标题、评论正文、作者、BV 号，或站点名（`b站` / `youtube` / `x`）
- 收藏数徽标是全站合计
- **删除语义**：本站记录 = 真删除；外站记录 = 从统一列表移除（不碰源站点数据，并留墓碑防止再同步回来）

### B 站增强
- **IP 属地**：从评论组件内部数据提取
- **粉丝数量**：走 B 站公开接口，按量级分级配色（`128粉丝` / `1.2k粉丝` / `1.2w粉丝`）

### 离线访问（飞机 / 临时断网）

油猴脚本依赖网站页面运行：断网时站点本身打不开，脚本也不会执行。所以离线入口必须独立于网页。

- **离线副本（推荐）**：面板「离线」→「同步到文件夹」，选一个目录（默认定位桌面）。之后每次收藏 / 删除都会自动写入 `<目录>/comment-collector-offline/index.html`，图片放在同级 `assets/`。**断网时双击这个 HTML 即可查看全部收藏**，建议拖到 Dock / 任务栏。
  - 内容没变化时不写盘；图片按哈希增量存放，不再引用的自动清理
  - 同一浏览器会话内权限保持；重启浏览器后首次点击会重新授权（文件本身一直可读）
- **下载单文件**：同一菜单里的另一条路径，图片内联为 data URL、零外链，适合分享或存 U 盘
- **图片本地缓存**：收藏时封面 / 头像抓成 Blob 存入 IndexedDB，在线与断网都用本地图
- 视频文件本体不入库（体量过大）；离线页保留封面、标题、UP 主 / 作者、时长与原始链接
- 浏览器不支持目录访问（Safari / Firefox）时自动降级为单文件下载

## ▣ 常见问题

**收藏点了没反应，或者收藏列表突然空了？**

多半是**同时开着多个同站点标签页**：脚本升级本地数据库时，旧标签页占住旧版本连接，升级被阻塞，读写就一直排队。

处理：关闭其它同站点标签页 → 刷新当前页。

3.2.2 起不会再静默卡住，会明确提示"收藏数据库被其它标签页占用"；新版本标签页之间也会自动让路。

## ▣ 技术要点

- 纯前端，`document-end` 注入。跨站存储用 `GM_getValue` / `GM_setValue`；其余能力（IndexedDB / File System Access）在 GM 沙箱下用 `unsafeWindow` 兜底
- **站点适配层**：B站走 Shadow DOM 评论区；YouTube 走 `ytd-comment-*` / `#top-level-buttons-computed`；X 走 `article[data-testid="tweet"]` 与 `[role="group"]`
- **存储分层**：
  - IndexedDB（按 origin）：`favorites` 存记录、`assets` 存图片 Blob、`mirror` 存子域离线镜像、`handles` 存目录句柄
  - 油猴存储（跨站）：只存文本索引，让任意站点都能搜索全部收藏
  - B 站任意子域之间通过隐藏的 `www.bilibili.com/404` iframe + `postMessage` 桥接共享同一份收藏
  - 图片按 origin 本地缓存，打开面板时后台补齐缺失项；总量超限按写入时间淘汰
- 悬浮球用 Pointer Events 拖拽 + 边缘吸附；面板用原生 `<dialog>.showModal()` 进入 top layer，避免被页面 `transform` 影响定位
- 收藏内容渲染前统一 HTML 转义与 URL 协议校验
- 导出优先 File System Access API，降级为浏览器下载；离线副本增量写 `index.html` + `assets/`，相对路径在 `file://` 下直接可用
- 单文件快照完全自包含（无外链资源），按 `prefers-color-scheme` 适配深浅色

## ▣ License

MIT
