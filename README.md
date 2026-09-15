# Comment Collector - B站 / YouTube / X

一个油猴（UserScript）脚本：在 B 站显示评论 IP 属地与粉丝数，并在 **B站 / YouTube / X** 上收藏视频、推文与评论，统一通过悬浮球和收藏面板查看。

## 功能

### B 站增强
- **IP 属地**：显示评论者 IP 属地（从评论组件内部数据提取）
- **粉丝数量**：通过 B 站公开接口实时获取，按量级分级配色
  - 格式：`128粉丝` / `1.2k粉丝` / `1.2w粉丝`
  - 配色：蓝灰 → 中蓝 → 琥珀 → 珊瑚红 → 金

### 多站点收藏
- **B站**：收藏视频（工具栏按钮 / 悬浮菜单）和评论；跨 `www` / `t` / `space` / `search` 子域同步
- **YouTube**：收藏视频（操作栏按钮 / 悬浮菜单）和评论
- **X / Twitter**：收藏推文 / 回复（每条推文操作栏按钮，收藏页推文可从悬浮菜单）
- **悬浮球**：右下角悬浮球可拖拽；靠近左右边缘自动半隐藏，hover 展开菜单；位置持久化到 `localStorage`
- **收藏面板**：毛玻璃 UI，支持跨站搜索、混合展示视频卡片与评论记录、打开原内容、单条删除、导出 JSON
- **主题自适应**：深色 / 浅色自动切换毛玻璃配色

### 跨站收藏夹
- **一处看全部**：任意站点（B站 / YouTube / X）打开收藏面板，都能看到**所有站点**的收藏，卡片带站点标签
- **跨站搜索**：搜标题、评论正文、作者、BV 号，也可以直接搜站点名（`b站` / `youtube` / `x`）
- **收藏数徽标**也是全站合计
- 跨站记录走油猴存储（`GM_getValue` / `GM_setValue`），因此升级后 Tampermonkey 会请求一次存储权限
- **删除语义**：本站记录 = 真删除；外站记录 = 从统一列表移除（不碰源站点数据，并留墓碑防止它再同步回来）
- 未授权 GM 存储时自动降级为单站模式，功能不受影响

### 离线访问（飞机 / 临时断网）
油猴脚本依赖网站页面运行：断网时站点本身打不开，脚本也不会执行。因此离线入口必须独立于网页。

- **离线副本（推荐）**：面板右上角离线按钮 → 「同步到文件夹」，选一个目录（默认定位到桌面）。
  之后每次收藏 / 删除都会自动把最新内容写入
  `<目录>/comment-collector-offline/index.html`，图片放在同级 `assets/`。
  **断网时双击 `index.html` 即可查看全部收藏**；建议把它拖到 Dock / 任务栏或发送桌面快捷方式。
  - 只有内容变化时才写盘；图片按哈希增量存放，不再被引用的图片自动清理
  - 同一浏览器会话内权限保持，收藏后无需任何操作；重启浏览器后首次点击会重新授权
- **下载单文件**：同一菜单里的另一条路径，图片内联为 data URL、零外链，适合分享或存进 U 盘
- **图片本地缓存**：收藏时封面 / 头像自动抓取为 Blob 存入 IndexedDB，面板在线与断网都用本地图，浏览更快
- **子域兜底**：B 站子域断网导致桥接 iframe 不可用时，回退到最近一次同步的本地镜像
- 视频文件本体不入库（体量过大）；离线页保留封面、标题、UP 主 / 作者、时长与原始链接
- 浏览器不支持目录访问（Safari / Firefox）时，离线按钮自动降级为单文件下载

### 站点支持
- Bilibili：**所有子域**（`www` / `t` / `space` / `search` / `live` / `passport` / `message` …）任意页面都能打开收藏夹
- YouTube：`www.youtube.com`、`m.youtube.com`
- X：`x.com`、`twitter.com`

## 常见问题

### 收藏点了没反应，或收藏列表突然空了？

多半是**同时开着多个同站点标签页**：脚本升级本地数据库时，旧标签页会占住旧版本的连接，升级被阻塞，收藏读写就会一直排队。

**处理**：关闭其它同站点标签页 → 刷新当前页即可恢复。

3.2.2 起不会再静默卡住：会明确提示"收藏数据库被其它标签页占用"，并且新版本标签页之间会自动让路。

## 安装

1. 安装油猴插件（Tampermonkey / Violentmonkey）
2. 将 `comment-collector.user.js` 导入为新建脚本（或安装 `.user.js` 直链）
3. 打开 B 站 / YouTube / X 页面即可看到悬浮球

## 技术要点

- 纯前端，`document-end` 注入；使用 `GM_getValue` / `GM_setValue` 做跨站存储，其余能力（IndexedDB / File System Access）在 GM 沙箱下用 `unsafeWindow` 兜底
- **站点适配层**：B站走 Shadow DOM 评论区；YouTube 走 `ytd-comment-*` / `#top-level-buttons-computed`；X 走 `article[data-testid="tweet"]` 与 `[role="group"]`
- **存储**：每个站点使用各自 origin 的 IndexedDB，`favorites` 存记录（keyPath=id）、`assets` 存图片 Blob（keyPath=url）、`mirror` 存子域离线镜像
  - B 站**任意子域**之间通过隐藏的 `www.bilibili.com/404` iframe + `postMessage` 桥接共享同一份收藏
  - 跨站索引存在油猴存储里（只存文本记录），图片仍按 origin 缓存在各自 IndexedDB
  - 资源缓存在各 origin 本地，打开面板时后台补齐缺失图片；总量超限按写入时间淘汰最旧资源
  - YouTube / X 目前为站点独立收藏夹；跨站统一收藏需要改用油猴 `GM_setValue` 存储
- 悬浮球使用 Pointer Events 拖拽、边缘吸附与半隐藏
- 收藏面板使用原生 `<dialog>.showModal()` 进入 top layer，避免页面 `transform` 影响定位
- 收藏内容渲染前统一 HTML 转义与 URL 协议校验
- 导出优先用 File System Access API，降级为浏览器下载
- 离线副本用 File System Access 目录句柄（存于 IndexedDB `handles`），增量写 `index.html` + `assets/`；相对路径在 `file://` 下可直接加载
- 单文件快照为完全自包含 HTML（无任何外链资源），并按 `prefers-color-scheme` 适配深浅色

## License

MIT
