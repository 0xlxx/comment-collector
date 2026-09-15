// ==UserScript==
// @name         Comment Collector - 评论收藏增强
// @namespace    comment-collector
// @version      3.2.3
// @description  在 B站 / YouTube / X 收藏视频、推文与评论，B站额外显示 IP 属地与粉丝数
// @author       biliip
// @updateURL   https://raw.githubusercontent.com/0xlxx/comment-collector/main/comment-collector.user.js
// @downloadURL https://raw.githubusercontent.com/0xlxx/comment-collector/main/comment-collector.user.js
// @match        https://*.bilibili.com/*
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtube.com/*
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // Module 1: 配置与常量
    // ═══════════════════════════════════════════════════════════════

    const STORAGE_KEY = 'bili-enhancer-settings';

    const DEFAULT_SETTINGS = { showIp: true, showFans: true, enableFavorite: true };

    const CONFIG = {
        // 仅在下列页面增强评论区（注入 IP / 粉丝 / 收藏按钮）
        enabledPages: ['video', 'space', 'dynamic'],
        position: 'before-like',
    };

    const PAGE_PATTERNS = {
        video: 'https://www.bilibili.com/video/',
        space: 'https://space.bilibili.com/',
        dynamic: 'https://t.bilibili.com/',
        dynamicDetail: 'https://www.bilibili.com/opus/',
        watchLater: 'https://www.bilibili.com/list/watchlater',
    };

    /**
     * 需要注入浮窗 UI 的主站页面。
     * 与评论区增强解耦：即使当前页面没有评论，也能打开收藏面板。
     */
    const UI_HOSTS = new Set([
        'www.bilibili.com',
        't.bilibili.com',
        'space.bilibili.com',
        'search.bilibili.com',
    ]);

    /** 当前站点：bilibili / youtube / x */
    const SITE = (() => {
        const host = window.location.hostname;
        if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
        if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
        if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
        return null;
    })();

    const SITE_LABELS = {
        bilibili: 'B站',
        youtube: 'YouTube',
        x: 'X',
    };

    /**
     * YouTube 等站点启用了 require-trusted-types-for 'script'。
     * 用独立策略包装扩展自身的 innerHTML，避免破坏页面原有策略。
     */
    let beTrustedHtmlPolicy = null;
    function getTrustedHtmlPolicy() {
        if (beTrustedHtmlPolicy) return beTrustedHtmlPolicy;
        try {
            if (window.trustedTypes && window.trustedTypes.createPolicy) {
                const name = 'be-enhancer-' + Math.random().toString(36).slice(2);
                beTrustedHtmlPolicy = window.trustedTypes.createPolicy(name, {
                    createHTML: (html) => html,
                });
            }
        } catch (_) { /* Trusted Types 不可用时回退 */ }
        return beTrustedHtmlPolicy;
    }

    /** 兼容 Trusted Types 的 innerHTML 赋值 */
    function setHtml(el, html) {
        if (!el) return;
        const policy = getTrustedHtmlPolicy();
        el.innerHTML = policy ? policy.createHTML(html) : html;
    }

    /** 粉丝数颜色分级 */
    const FAN_TIERS = [
        { max: 100,     color: '#78909C' },   // 蓝灰 — 少量
        { max: 1000,    color: '#42A5F5' },   // 中蓝 — 百级
        { max: 10000,   color: '#FF9800' },   // 暖琥珀 — 千级
        { max: 100000,  color: '#EF5350' },   // 珊瑚红 — 万级
        { max: Infinity, color: '#F9A825' },  // 金 — 十万+
    ];

    // ═══════════════════════════════════════════════════════════════
    // Module 2: 持久化设置
    // ═══════════════════════════════════════════════════════════════

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                // 合并默认值，向前兼容后续新增字段
                return { ...DEFAULT_SETTINGS, ...saved };
            }
        } catch (_) { /* corrupted JSON — fall through */ }
        return { ...DEFAULT_SETTINGS };
    }

    function saveSettings(s) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        } catch (_) { /* quota exceeded — silently degrade */ }
    }

    let settings = loadSettings();

    // ═══════════════════════════════════════════════════════════════
    // Module 3: 数据提取
    // ═══════════════════════════════════════════════════════════════

    /**
     * 从评论 shadow root 提取 IP 属地和用户 mid
     * @param {ShadowRoot} root - 评论项的 shadow root
     * @returns {{ ip: string|null, mid: string|null }}
     */
    function extractCommentData(root) {
        try {
            // IP：沿用已验证路径 — footer 内 action-buttons 元素的 __data
            const footer = root.getElementById('footer');
            const controlEl = footer && footer.children[0];
            const controlData = controlEl && controlEl.__data;
            const ip = controlData?.reply_control?.location || null;

            // mid：从宿主元素 __data.member 获取用户 ID
            const hostData = root.host && root.host.__data;
            const mid = hostData?.member?.mid || null;
            const uname = hostData?.member?.uname || null;
            const face = hostData?.member?.face || null;
            const content = hostData?.content?.message || hostData?.content?.text || null;
            const ctime = hostData?.ctime || null;
            const rpid = hostData?.rpid || null;

            return {
                ip,
                mid: mid ? String(mid) : null,
                uname,
                face,
                content,
                ctime,
                rpid,
            };
        } catch (_e) {
            return { ip: null, mid: null, uname: null, face: null, content: null, ctime: null, rpid: null };
        }
    }

    /**
     * 获取粉丝数对应的颜色等级
     */
    function getFanTier(n) {
        for (let i = 0; i < FAN_TIERS.length; i++) {
            if (n < FAN_TIERS[i].max) return i + 1;
        }
        return FAN_TIERS.length;
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 4: 粉丝数 API 获取与缓存
    // ═══════════════════════════════════════════════════════════════

    /** 粉丝数缓存：mid → { count: number, ts: number } */
    const fanCache = new Map();
    /** 正在请求中的 mid → Promise，避免重复请求 */
    const fanPending = new Map();
    const CACHE_TTL = 10 * 60 * 1000; // 缓存 10 分钟

    /**
     * 通过 Bilibili API 获取用户粉丝数
     * @param {string} mid
     * @returns {Promise<number|null>}
     */
    async function fetchFanCount(mid) {
        // 检查缓存
        const cached = fanCache.get(mid);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
            return cached.count;
        }

        // 去重：同一 mid 的并发请求共享 Promise
        if (fanPending.has(mid)) {
            return fanPending.get(mid);
        }

        const promise = (async () => {
            try {
                const resp = await fetch(
                    `https://api.bilibili.com/x/relation/stat?vmid=${mid}`,
                    { credentials: 'omit' }
                );
                if (!resp.ok) return null;
                const json = await resp.json();
                if (json.code !== 0 || !json.data) return null;
                const count = Number(json.data.follower);
                if (isNaN(count)) return null;
                fanCache.set(mid, { count, ts: Date.now() });
                return count;
            } catch (_) {
                return null;
            } finally {
                fanPending.delete(mid);
            }
        })();

        fanPending.set(mid, promise);
        return promise;
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 5: 格式化
    // ═══════════════════════════════════════════════════════════════

    /**
     * 格式化粉丝数
     * < 1000  → "128粉丝"
     * 1k-10k  → "1.2k粉丝"
     * >= 10k  → "1.2w粉丝"
     */
    function formatFans(n) {
        if (n == null || isNaN(n)) return null;
        if (n < 1000) return n + '粉丝';
        if (n < 10000) {
            const v = (n / 1000).toFixed(1).replace(/\.0$/, '');
            return v + 'k粉丝';
        }
        const v = (n / 10000).toFixed(1).replace(/\.0$/, '');
        return v + 'w粉丝';
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 6: CSS 样式注入
    // ═══════════════════════════════════════════════════════════════

    function injectStyles() {
        if (document.getElementById('be-styles')) return;

        const style = document.createElement('style');
        style.id = 'be-styles';
        style.textContent = `
            /* ── 主题感知基色（浅色 / 深色共用一套变量） ── */
            :root {
                --be-fan-base: #9499a0;
                --be-surface: #ffffff;
                --be-text: #18191c;
                --be-text-secondary: #61666d;
                --be-text-tertiary: #9499a0;
                --be-panel-bg: rgba(255, 255, 255, 0.72);
                --be-panel-bg-strong: rgba(255, 255, 255, 0.88);
                --be-panel-border: rgba(255, 255, 255, 0.72);
                --be-panel-shadow: rgba(15, 23, 42, 0.16);
                --be-overlay-bg: rgba(15, 23, 42, 0.18);
                --be-item-bg: rgba(255, 255, 255, 0.55);
                --be-item-hover: rgba(255, 255, 255, 0.82);
                --be-divider: rgba(15, 23, 42, 0.08);
                --be-accent: #00aeec;
                --be-accent-soft: rgba(0, 174, 236, 0.12);
                --be-danger: #f04b4b;
                --be-danger-soft: rgba(240, 75, 75, 0.12);
                --be-glass-blur: blur(28px) saturate(180%);
            }
            html[data-be-theme="dark"],
            html[data-theme="dark"],
            html[data-dark-theme="dark"],
            html.bili_dark {
                --be-fan-base: #8b8b8b;
                --be-surface: #1a1a1a;
                --be-text: #f1f2f3;
                --be-text-secondary: #b5b9c0;
                --be-text-tertiary: #8a8f99;
                --be-panel-bg: rgba(28, 28, 32, 0.72);
                --be-panel-bg-strong: rgba(28, 28, 32, 0.9);
                --be-panel-border: rgba(255, 255, 255, 0.1);
                --be-panel-shadow: rgba(0, 0, 0, 0.5);
                --be-overlay-bg: rgba(0, 0, 0, 0.42);
                --be-item-bg: rgba(255, 255, 255, 0.045);
                --be-item-hover: rgba(255, 255, 255, 0.08);
                --be-divider: rgba(255, 255, 255, 0.08);
                --be-accent: #4cc9f0;
                --be-accent-soft: rgba(76, 201, 240, 0.14);
                --be-danger: #ff6b6b;
                --be-danger-soft: rgba(255, 107, 107, 0.14);
            }

            /* ── 可见性控制（CSS 自定义属性穿透 Shadow DOM） ── */
            :root {
                --be-show-ip: inline-flex;
                --be-show-fans: inline-flex;
                --be-show-fav: inline-flex;
            }

            /* ── 通用 Badge ── */
            .be-badge {
                display: inline-flex;
                align-items: center;
                height: 22px;
                padding: 0 6px;
                margin-right: 6px;
                font-size: 11px;
                line-height: 22px;
                border-radius: 4px;
                white-space: nowrap;
                user-select: none;
                flex-shrink: 0;
                font-weight: 500;
                letter-spacing: 0.01em;
                vertical-align: middle;
            }

            /* ── IP 属地 Badge（低调灰，color-mix 适配主题） ── */
            .be-badge-ip {
                display: var(--be-show-ip);
                color: color-mix(in srgb, #9499a0 90%, var(--be-fan-base) 10%);
                background: color-mix(in srgb, #9499a0 13%, transparent);
                border: 0.5px solid color-mix(in srgb, #9499a0 18%, transparent);
            }

            /* ── 粉丝 Badge（颜色通过 inline style 设置，绕过 Shadow DOM 隔离） ── */
            .be-badge-fans {
                display: var(--be-show-fans);
            }

            /* ── 悬浮球 + 悬浮菜单 ── */
            #be-fab-wrap {
                position: fixed;
                left: calc(100% - 48px);
                top: 45%;
                z-index: 99999;
                width: 48px;
                height: 48px;
                touch-action: none;
                user-select: none;
                transition: left .18s ease, top .18s ease;
            }
            #be-fab-wrap.be-dragging {
                transition: none;
            }
            #be-fab-ball {
                position: relative;
                width: 48px;
                height: 48px;
                padding: 0;
                border: 1px solid var(--be-panel-border);
                border-radius: 50%;
                background: var(--be-panel-bg);
                backdrop-filter: var(--be-glass-blur);
                -webkit-backdrop-filter: var(--be-glass-blur);
                box-shadow: 0 8px 24px var(--be-panel-shadow);
                color: var(--be-text-secondary);
                cursor: grab;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform .24s cubic-bezier(.2,.8,.2,1), background .2s ease, color .2s ease, box-shadow .2s ease;
            }
            #be-fab-ball:hover {
                background: var(--be-panel-bg-strong);
                color: var(--be-text);
                box-shadow: 0 12px 30px var(--be-panel-shadow);
            }
            #be-fab-wrap.be-dragging #be-fab-ball { cursor: grabbing; }
            #be-fab-ball svg {
                width: 20px;
                height: 20px;
                fill: none;
                stroke: currentColor;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
            #be-fab-wrap[data-side="right"] #be-fab-ball { transform: translateX(50%); }
            #be-fab-wrap[data-side="right"]:hover #be-fab-ball { transform: translateX(0); }
            #be-fab-wrap[data-side="left"] #be-fab-ball { transform: translateX(-50%); }
            #be-fab-wrap[data-side="left"]:hover #be-fab-ball { transform: translateX(0); }
            #be-fab-wrap.be-dragging #be-fab-ball { transform: none !important; }
            #be-fab-wrap.be-menu-open #be-fab-ball,
            #be-fab-wrap.be-favorites-open #be-fab-ball { color: var(--be-accent); }
            .be-fab-count {
                position: absolute;
                top: -4px;
                right: -4px;
                min-width: 18px;
                height: 18px;
                padding: 0 5px;
                border-radius: 9px;
                background: var(--be-accent);
                color: #fff;
                font-size: 10px;
                font-weight: 700;
                line-height: 18px;
                text-align: center;
                box-shadow: 0 2px 8px rgba(0, 174, 236, .35);
                display: none;
                pointer-events: none;
            }
            #be-fab-wrap[data-side="right"] #be-fab-ball .be-fab-count {
                right: auto;
                left: -4px;
            }

            /* ── hover 菜单 ── */
            #be-fab-menu {
                position: absolute;
                top: 50%;
                width: 210px;
                max-height: min(420px, calc(100vh - 32px));
                overflow-y: auto;
                padding: 6px;
                border: 1px solid var(--be-panel-border);
                border-radius: 18px;
                background: var(--be-panel-bg);
                backdrop-filter: var(--be-glass-blur);
                -webkit-backdrop-filter: var(--be-glass-blur);
                box-shadow: 0 20px 50px var(--be-panel-shadow);
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transform: translateY(-50%) scale(.96);
                transition: opacity .2s ease, transform .2s ease, visibility .2s;
            }
            #be-fab-wrap[data-menu="right"] #be-fab-menu {
                left: calc(100% + 10px);
                transform-origin: left center;
            }
            #be-fab-wrap[data-menu="left"] #be-fab-menu {
                right: calc(100% + 10px);
                transform-origin: right center;
            }
            #be-fab-wrap.be-menu-open #be-fab-menu,
            #be-fab-wrap:hover #be-fab-menu {
                opacity: 1;
                visibility: visible;
                pointer-events: auto;
                transform: translateY(-50%) scale(1);
            }
            #be-fab-wrap.be-dragging #be-fab-menu {
                opacity: 0 !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }
            .be-fab-menu-item {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 8px;
                border: none;
                border-radius: 10px;
                background: transparent;
                color: var(--be-text-secondary);
                font-size: 13px;
                cursor: pointer;
                text-align: left;
                transition: background .2s ease, color .2s ease;
            }
            .be-fab-menu-item:hover {
                background: var(--be-item-hover);
                color: var(--be-text);
            }
            .be-fab-menu-item[hidden] { display: none; }
            #be-fab-video-fav.be-faved { color: var(--be-accent); }
            #be-fab-video-fav.be-faved svg { fill: currentColor; }
            .be-fab-menu-item svg {
                width: 16px;
                height: 16px;
                fill: none;
                stroke: currentColor;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
                flex-shrink: 0;
            }
            .be-fab-menu-item .be-fab-count {
                position: static;
                display: none;
                margin-left: auto;
            }
            .be-fab-menu-divider {
                height: 1px;
                margin: 4px;
                background: var(--be-divider);
            }
            .be-fab-menu-footer {
                display: flex;
                justify-content: flex-end;
                padding: 2px 2px 0;
            }
            .be-fab-icon-btn {
                width: 30px;
                height: 30px;
                padding: 0;
                border: none;
                border-radius: 9px;
                background: transparent;
                color: var(--be-text-tertiary);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background .2s ease, color .2s ease;
            }
            .be-fab-icon-btn:hover {
                background: var(--be-item-hover);
                color: var(--be-text);
            }
            .be-fab-icon-btn svg {
                width: 15px;
                height: 15px;
                fill: none;
                stroke: currentColor;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            /* ── 开关行（菜单内） ── */
            .be-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 7px 8px;
                border-radius: 10px;
            }
            .be-row:hover { background: var(--be-item-bg); }
            .be-row-label {
                font-size: 12px;
                font-weight: 500;
                color: var(--be-text-secondary);
                user-select: none;
            }

            /* ── Solid Pill 开关 ── */
            .be-toggle {
                position: relative;
                display: inline-block;
                width: 40px;
                height: 24px;
                flex-shrink: 0;
                cursor: pointer;
            }
            .be-toggle input {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
                pointer-events: none;
            }
            .be-toggle-track {
                display: block;
                width: 100%;
                height: 100%;
                border-radius: 12px;
                background: color-mix(in srgb, var(--be-text-tertiary) 32%, transparent);
                transition: background 0.22s ease;
                position: relative;
            }
            .be-toggle input:checked + .be-toggle-track { background: var(--be-accent); }
            .be-toggle-thumb {
                position: absolute;
                top: 3px;
                left: 3px;
                width: 18px;
                height: 18px;
                border-radius: 50%;
                background: #ffffff;
                box-shadow: 0 1px 3px rgba(0,0,0,0.15);
                transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
            }
            .be-toggle input:checked + .be-toggle-track .be-toggle-thumb {
                transform: translateX(16px);
            }

            /* ── 收藏管理面板（毛玻璃） ── */
            #be-fav-overlay {
                position: fixed;
                inset: 0;
                z-index: 100001;
                display: none;
                width: 100%;
                max-width: none;
                height: 100%;
                max-height: none;
                margin: 0;
                padding: 20px;
                border: none;
                box-sizing: border-box;
                background: transparent;
                overflow: hidden;
                align-items: center;
                justify-content: center;
            }
            #be-fav-overlay[open] {
                display: flex;
                animation: be-fav-overlay-in .24s ease both;
            }
            #be-fav-overlay::backdrop {
                background: var(--be-overlay-bg, rgba(15, 23, 42, 0.18));
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
            }
            html[data-be-theme="dark"] #be-fav-overlay::backdrop,
            html[data-theme="dark"] #be-fav-overlay::backdrop,
            html[data-dark-theme="dark"] #be-fav-overlay::backdrop,
            html.bili_dark #be-fav-overlay::backdrop {
                background: rgba(0, 0, 0, 0.42);
            }
            @keyframes be-fav-overlay-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes be-fav-panel-in {
                from { opacity: 0; transform: translateY(14px) scale(.985); }
                to { opacity: 1; transform: none; }
            }
            #be-fav-overlay[open] #be-fav-panel {
                animation: be-fav-panel-in .28s cubic-bezier(.2,.8,.2,1) both;
            }
            #be-fav-panel {
                position: relative;
                width: min(680px, calc(100vw - 32px));
                max-height: min(760px, calc(100vh - 48px));
                display: flex;
                flex-direction: column;
                overflow: hidden;
                background: var(--be-panel-bg);
                backdrop-filter: var(--be-glass-blur);
                -webkit-backdrop-filter: var(--be-glass-blur);
                border: 1px solid var(--be-panel-border);
                border-radius: 22px;
                box-shadow: 0 24px 80px var(--be-panel-shadow);
            }

            .be-fav-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                padding: 18px 20px 14px;
                border-bottom: 1px solid var(--be-divider);
            }
            .be-fav-heading {
                display: flex;
                align-items: center;
                gap: 12px;
                min-width: 0;
            }
            .be-fav-heading-icon {
                width: 38px;
                height: 38px;
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--be-accent);
                background: var(--be-accent-soft);
                flex-shrink: 0;
            }
            .be-fav-heading-icon svg,
            .be-icon-btn svg,
            .be-fav-empty-icon svg,
            .be-fav-del svg,
            .be-fav-original-link svg,
            .be-offline-item-icon svg,
            .be-fav-search svg {
                fill: none;
                stroke: currentColor;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
            .be-fav-heading-icon svg { width: 19px; height: 19px; }
            .be-fav-title {
                margin: 0;
                font-size: 16px;
                line-height: 1.3;
                font-weight: 650;
                color: var(--be-text);
            }
            .be-fav-count-pill {
                min-width: 22px;
                height: 22px;
                padding: 0 7px;
                border-radius: 11px;
                background: var(--be-accent-soft);
                color: var(--be-accent);
                font-size: 11px;
                font-weight: 700;
                line-height: 22px;
                text-align: center;
                flex-shrink: 0;
            }
            .be-fav-offline-pill {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                height: 22px;
                padding: 0 8px;
                border-radius: 11px;
                background: var(--be-item-hover);
                color: var(--be-text-secondary);
                font-size: 11px;
                font-weight: 600;
                flex-shrink: 0;
            }
            .be-fav-offline-pill::before {
                content: '';
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: currentColor;
                opacity: .7;
            }
            .be-fav-offline-pill[hidden] { display: none; }
            .be-fav-header-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-shrink: 0;
            }
            .be-icon-btn {
                width: 34px;
                height: 34px;
                padding: 0;
                border: none;
                border-radius: 10px;
                background: transparent;
                color: var(--be-text-secondary);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background .2s ease, color .2s ease, transform .2s ease;
            }
            .be-icon-btn:hover { background: var(--be-item-hover); color: var(--be-text); }
            .be-icon-btn.be-offline-ready { color: var(--be-accent); background: var(--be-accent-soft); }
            .be-icon-btn.be-offline-warn { color: #e08b1a; background: rgba(224, 139, 26, .14); }
            .be-icon-btn:active { transform: scale(.94); }
            .be-icon-btn svg { width: 17px; height: 17px; }

            .be-offline-menu {
                position: absolute;
                top: 64px;
                right: 20px;
                z-index: 6;
                min-width: 236px;
                padding: 6px;
                border: 1px solid var(--be-panel-border);
                border-radius: 14px;
                background: var(--be-panel-bg);
                backdrop-filter: var(--be-glass-blur);
                -webkit-backdrop-filter: var(--be-glass-blur);
                box-shadow: 0 16px 44px var(--be-panel-shadow);
                animation: be-offline-menu-in .16s cubic-bezier(.2,.8,.2,1) both;
            }
            .be-offline-menu[hidden] { display: none; }
            @keyframes be-offline-menu-in {
                from { opacity: 0; transform: translateY(-6px) scale(.98); }
                to { opacity: 1; transform: none; }
            }
            .be-offline-item {
                display: flex;
                align-items: center;
                gap: 10px;
                width: 100%;
                padding: 9px 10px;
                border: none;
                border-radius: 10px;
                background: transparent;
                color: var(--be-text);
                cursor: pointer;
                text-align: left;
                transition: background .16s ease;
            }
            .be-offline-item:hover { background: var(--be-item-hover); }
            .be-offline-item-icon {
                width: 30px;
                height: 30px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 9px;
                background: var(--be-accent-soft);
                color: var(--be-accent);
            }
            .be-offline-item-icon svg { width: 16px; height: 16px; }
            .be-offline-item-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
            .be-offline-item-title { font-size: 13px; font-weight: 600; line-height: 1.3; }
            .be-offline-item-desc { font-size: 11px; line-height: 1.35; color: var(--be-text-tertiary); }

            .be-fav-toolbar { padding: 14px 20px 10px; }
            .be-fav-search { position: relative; display: flex; align-items: center; }
            .be-fav-search svg {
                position: absolute;
                left: 12px;
                width: 15px;
                height: 15px;
                color: var(--be-text-tertiary);
                pointer-events: none;
            }
            #be-fav-search {
                width: 100%;
                height: 38px;
                padding: 0 12px 0 36px;
                border: 1px solid var(--be-divider);
                border-radius: 12px;
                outline: none;
                background: var(--be-item-bg);
                color: var(--be-text);
                font-size: 13px;
                transition: border-color .2s ease, background .2s ease, box-shadow .2s ease;
            }
            #be-fav-search::placeholder { color: var(--be-text-tertiary); }
            #be-fav-search:focus {
                border-color: color-mix(in srgb, var(--be-accent) 55%, transparent);
                background: var(--be-item-hover);
                box-shadow: 0 0 0 3px var(--be-accent-soft);
            }

            .be-fav-list {
                flex: 1;
                overflow-y: auto;
                overscroll-behavior: contain;
                padding: 4px 14px 12px;
            }
            .be-fav-list::-webkit-scrollbar { width: 8px; }
            .be-fav-list::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, var(--be-text-tertiary) 30%, transparent);
                border-radius: 4px;
                border: 2px solid transparent;
                background-clip: padding-box;
            }
            .be-fav-list::-webkit-scrollbar-track { background: transparent; }

            .be-fav-empty {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 10px;
                min-height: 260px;
                padding: 40px 20px;
                text-align: center;
                color: var(--be-text-tertiary);
            }
            .be-fav-empty-icon {
                width: 52px;
                height: 52px;
                border-radius: 18px;
                background: var(--be-item-bg);
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--be-text-tertiary);
            }
            .be-fav-empty-icon svg { width: 24px; height: 24px; }
            .be-fav-empty-title { font-size: 14px; font-weight: 600; color: var(--be-text-secondary); }
            .be-fav-empty-desc { font-size: 12px; line-height: 1.6; max-width: 280px; }

            .be-fav-item {
                position: relative;
                padding: 14px 16px;
                margin-bottom: 10px;
                border: 1px solid var(--be-divider);
                border-radius: 16px;
                background: var(--be-item-bg);
                transition: background .2s ease, border-color .2s ease, transform .2s ease, box-shadow .2s ease;
            }
            .be-fav-item:last-child { margin-bottom: 0; }
            .be-fav-item:hover {
                background: var(--be-item-hover);
                border-color: color-mix(in srgb, var(--be-accent) 22%, var(--be-divider));
                transform: translateY(-1px);
                box-shadow: 0 8px 24px color-mix(in srgb, var(--be-panel-shadow) 70%, transparent);
            }
            .be-fav-item-head {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 10px;
            }
            .be-fav-avatar-wrap {
                position: relative;
                width: 34px;
                height: 34px;
                flex-shrink: 0;
            }
            .be-fav-avatar {
                width: 34px;
                height: 34px;
                border-radius: 50%;
                object-fit: cover;
                display: block;
                background: linear-gradient(135deg, color-mix(in srgb, var(--be-accent) 55%, #8b5cf6), var(--be-accent));
                color: #fff;
                font-size: 13px;
                font-weight: 700;
                line-height: 34px;
                text-align: center;
            }
            .be-fav-avatar-fallback {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .be-fav-item-info { min-width: 0; flex: 1; }
            .be-fav-uname {
                display: block;
                font-size: 13px;
                font-weight: 650;
                color: var(--be-text);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .be-fav-meta {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px;
                margin-top: 3px;
                font-size: 11px;
                color: var(--be-text-tertiary);
            }
            .be-fav-tag {
                display: inline-flex;
                align-items: center;
                height: 18px;
                padding: 0 6px;
                border-radius: 6px;
                background: var(--be-item-hover);
                color: var(--be-text-secondary);
                font-size: 10px;
            }
            .be-fav-del {
                width: 30px;
                height: 30px;
                padding: 0;
                border: none;
                border-radius: 9px;
                background: transparent;
                color: var(--be-text-tertiary);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                transition: background .2s ease, color .2s ease;
            }
            .be-fav-del:hover { background: var(--be-danger-soft); color: var(--be-danger); }
            .be-fav-del svg { width: 15px; height: 15px; }
            .be-fav-item-content {
                margin: 0 0 12px;
                font-size: 13px;
                line-height: 1.65;
                color: var(--be-text-secondary);
                white-space: pre-wrap;
                word-break: break-word;
                display: -webkit-box;
                -webkit-line-clamp: 5;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .be-fav-item-foot {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }
            .be-fav-saved { font-size: 11px; color: var(--be-text-tertiary); }

            .be-fav-video-main {
                display: flex;
                align-items: flex-start;
                gap: 12px;
            }
            .be-fav-video-thumb {
                position: relative;
                width: 132px;
                aspect-ratio: 16 / 9;
                flex-shrink: 0;
                overflow: hidden;
                border-radius: 11px;
                background: linear-gradient(135deg, color-mix(in srgb, var(--be-accent) 18%, transparent), var(--be-item-hover));
                color: var(--be-text-tertiary);
                text-decoration: none;
            }
            .be-fav-video-thumb img {
                width: 100%;
                height: 100%;
                display: block;
                object-fit: cover;
            }
            .be-fav-video-cover-fallback {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .be-fav-video-cover-fallback svg {
                width: 26px;
                height: 26px;
                fill: none;
                stroke: currentColor;
                stroke-width: 1.6;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
            .be-fav-video-duration {
                position: absolute;
                right: 5px;
                bottom: 5px;
                padding: 2px 5px;
                border-radius: 5px;
                background: rgba(0, 0, 0, .72);
                color: #fff;
                font-size: 10px;
                line-height: 1.3;
                font-variant-numeric: tabular-nums;
            }
            .be-fav-video-info {
                min-width: 0;
                flex: 1;
                align-self: stretch;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .be-fav-video-title {
                color: var(--be-text);
                font-size: 14px;
                line-height: 1.45;
                font-weight: 650;
                text-decoration: none;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .be-fav-video-title:hover { color: var(--be-accent); }
            .be-fav-video-uploader {
                display: block;
                font-size: 12px;
                color: var(--be-text-secondary);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .be-fav-video-meta {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px;
                margin-top: auto;
                font-size: 11px;
                color: var(--be-text-tertiary);
            }
            .be-fav-original-link {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 5px 10px;
                border-radius: 9px;
                background: var(--be-accent-soft);
                color: var(--be-accent);
                font-size: 12px;
                font-weight: 600;
                text-decoration: none;
                transition: background .2s ease, transform .2s ease;
            }
            .be-fav-original-link:hover {
                background: color-mix(in srgb, var(--be-accent) 20%, transparent);
                transform: translateY(-1px);
            }
            .be-fav-original-link svg { width: 13px; height: 13px; }


            /* ── 轻量提示条 ── */
            #be-fav-toast {
                position: fixed;
                left: 50%;
                bottom: 34px;
                z-index: 100002;
                max-width: calc(100vw - 32px);
                padding: 9px 16px;
                border-radius: 12px;
                background: var(--be-panel-bg-strong);
                backdrop-filter: var(--be-glass-blur);
                -webkit-backdrop-filter: var(--be-glass-blur);
                border: 1px solid var(--be-panel-border);
                box-shadow: 0 12px 32px var(--be-panel-shadow);
                color: var(--be-text);
                font-size: 13px;
                opacity: 0;
                pointer-events: none;
                transform: translate(-50%, 8px);
                transition: opacity .2s ease, transform .2s ease;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #be-fav-toast.be-show { opacity: 1; transform: translate(-50%, 0); }

            /* 打开收藏面板时锁定页面滚动，并补偿滚动条消失造成的横向重排 */
            html.be-fav-page-locked,
            html.be-fav-page-locked body { overflow: hidden !important; }
            html.be-fav-page-locked {
                padding-right: var(--be-fav-scrollbar-compensation, 0px) !important;
            }

            /* ── 站点原生收藏按钮（B站 / YouTube / X） ── */
            .be-site-collect {
                box-sizing: border-box;
                font-family: inherit;
                cursor: pointer;
                transition: background .2s ease, color .2s ease, opacity .2s ease;
            }
            .be-site-collect svg {
                width: 18px;
                height: 18px;
                fill: none;
                stroke: currentColor;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
                flex-shrink: 0;
            }
            .be-site-collect.be-collected { color: var(--be-accent); }
            .be-site-collect.be-collected svg { fill: color-mix(in srgb, var(--be-accent) 22%, transparent); }

            /* B 站视频工具栏（竖排图标 + 文案） */
            #be-bili-video-collect {
                display: inline-flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 4px;
                min-width: 52px;
                height: 56px;
                padding: 0 6px;
                border: none;
                background: transparent;
                color: #61666d;
                font-size: 13px;
                line-height: 1.2;
            }
            #be-bili-video-collect:hover { color: var(--be-accent); }
            #be-bili-video-collect svg { width: 24px; height: 24px; }
            html[data-be-theme="dark"] #be-bili-video-collect { color: #aeb3bb; }

            /* YouTube 视频操作栏 */
            .be-yt-collect {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 36px;
                padding: 0 16px;
                border: none;
                border-radius: 18px;
                background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, .05));
                color: var(--yt-spec-text-primary, #0f0f0f);
                font-size: 14px;
                font-weight: 500;
                white-space: nowrap;
                margin-left: 8px;
            }
            .be-yt-collect:hover { background: var(--yt-spec-button-chip-background-hover, rgba(0, 0, 0, .1)); }
            .be-yt-collect.be-collected { color: #065fd4; }
            html[dark] .be-yt-collect { background: rgba(255, 255, 255, .1); color: #f1f1f1; }
            html[dark] .be-yt-collect:hover { background: rgba(255, 255, 255, .2); }
            html[dark] .be-yt-collect.be-collected { color: #3ea6ff; }

            /* YouTube 评论操作栏 */
            .be-yt-comment-collect {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: var(--yt-spec-text-secondary, #606060);
            }
            .be-yt-comment-collect:hover { background: rgba(0, 0, 0, .05); }
            .be-yt-comment-collect.be-collected { color: #065fd4; }
            html[dark] .be-yt-comment-collect { color: #aaa; }
            html[dark] .be-yt-comment-collect:hover { background: rgba(255, 255, 255, .1); }
            html[dark] .be-yt-comment-collect.be-collected { color: #3ea6ff; }

            /* X / Twitter 操作栏 */
            .be-x-collect {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 34px;
                height: 34px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: rgb(83, 100, 113);
                margin-left: 4px;
            }
            .be-x-collect:hover { background: rgba(29, 155, 240, .1); color: rgb(29, 155, 240); }
            .be-x-collect.be-collected { color: rgb(29, 155, 240); }
            .be-x-collect svg { width: 18px; height: 18px; }
            html[data-be-theme="dark"] .be-x-collect { color: rgb(113, 118, 123); }
            html[data-be-theme="dark"] .be-x-collect:hover { background: rgba(29, 155, 240, .15); color: rgb(29, 155, 240); }

            @media (max-width: 640px) {
                #be-fab-menu {
                    width: min(210px, calc(100vw - 76px));
                    max-height: min(420px, calc(100vh - 24px));
                }
                #be-fav-overlay { padding: 12px; align-items: flex-end; }
                #be-fav-panel {
                    width: 100%;
                    max-height: calc(100vh - 24px);
                    border-radius: 20px 20px 16px 16px;
                }
                .be-fav-header { padding: 16px 16px 12px; }
                .be-fav-toolbar { padding: 12px 16px 8px; }
                .be-fav-list { padding: 4px 10px 10px; }
                .be-fav-item-foot { flex-direction: column; align-items: flex-start; }
                .be-fav-video-thumb { width: 108px; }
            }
        `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════════
    // 页面匹配
    // ═══════════════════════════════════════════════════════════════

    function matchPage(enabledPages) {
        const href = window.location.href;
        for (const page of enabledPages) {
            if (page === 'dynamic') {
                if (href.startsWith(PAGE_PATTERNS.dynamic) || href.startsWith(PAGE_PATTERNS.dynamicDetail)) {
                    return true;
                }
            }
            if (href.startsWith(PAGE_PATTERNS[page])) {
                return true;
            }
        }
        if (enabledPages.includes('video') && href.startsWith(PAGE_PATTERNS.watchLater)) {
            return true;
        }
        return false;
    }

    /**
     * 是否注入浮窗 UI（设置 / 收藏入口）。
     * 主站首页、动态页、空间页、视频页都可打开收藏面板。
     */
    function shouldInjectUI() {
        if (window.top !== window.self) return false; // 不在 iframe 内重复注入
        if (SITE === 'bilibili') return UI_HOSTS.has(window.location.hostname);
        return SITE === 'youtube' || SITE === 'x';
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 7: Badge 渲染
    // ═══════════════════════════════════════════════════════════════

    /**
     * 创建粉丝 Badge 元素
     */
    /**
     * 将 hex 颜色转为 rgb 分量
     */
    function hexToRgb(hex) {
        return {
            r: parseInt(hex.slice(1, 3), 16),
            g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16),
        };
    }

    let currentTheme = 'light';

    /** 解析 CSS 颜色亮度，用于在 B 站没有显式主题属性时判断页面明暗 */
    function parseColorLuminance(color) {
        const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(color || '');
        if (!match) return null;
        const alpha = match[4] == null
            ? 1
            : (match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]));
        if (!alpha) return null;
        const channel = (v) => {
            const n = Math.min(255, Math.max(0, parseFloat(v))) / 255;
            return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
    }

    function hasDarkClass(el) {
        if (!el || !el.classList) return false;
        return el.classList.contains('bili_dark') ||
            el.classList.contains('dark') ||
            el.classList.contains('dark-theme');
    }

    /**
     * 识别 B 站主题：兼容 data-theme / data-dark-theme / bili_dark class，
     * 最后再根据实际页面背景亮度兜底。
     */
    function detectTheme() {
        const html = document.documentElement;
        const body = document.body;
        const explicit = [
            html.getAttribute('data-theme'),
            html.getAttribute('data-dark-theme'),
            html.getAttribute('data-darkreader-scheme'),
            body && body.getAttribute('data-theme'),
        ].filter(Boolean).map(v => String(v).toLowerCase());

        if (explicit.some(v => v === 'dark' || v === 'true' || v.includes('dark'))) return 'dark';
        if (explicit.some(v => v === 'light' || v === 'false' || v.includes('light'))) return 'light';
        if (hasDarkClass(html) || hasDarkClass(body)) return 'dark';

        // YouTube：html[dark] 表示深色模式
        if (html.hasAttribute('dark') || (document.querySelector('ytd-app')?.hasAttribute('dark'))) return 'dark';

        // X / Twitter：通过 color-scheme 或 data-color-mode 判断
        const colorMode = String(html.getAttribute('data-color-mode') || '').toLowerCase();
        if (colorMode.includes('dark')) return 'dark';
        if (String(html.style.colorScheme || body?.style.colorScheme || '').toLowerCase().includes('dark')) return 'dark';

        const candidates = [body, document.querySelector('ytd-app'), document.getElementById('react-root'), document.getElementById('app'), html].filter(Boolean);
        for (const el of candidates) {
            const lum = parseColorLuminance(getComputedStyle(el).backgroundColor);
            if (lum != null) return lum < 0.45 ? 'dark' : 'light';
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    /** 刷新主题标记并同步重绘 badge 颜色 */
    function refreshTheme() {
        const next = detectTheme();
        const root = document.documentElement;
        if (next === currentTheme && root.getAttribute('data-be-theme') === next) return;
        currentTheme = next;
        root.setAttribute('data-be-theme', next);
        recolorAllFanBadges();
    }

    /** 检测当前是否为深色模式 */
    function isDarkTheme() {
        return currentTheme === 'dark';
    }

    /** 监听 B 站主题切换（属性 / class / 系统偏好） */
    function observeThemeChanges() {
        const refresh = () => refreshTheme();
        const observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'dark', 'data-theme', 'data-dark-theme', 'data-darkreader-scheme', 'data-color-mode', 'style'],
        });
        if (document.body) {
            observer.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'data-theme', 'style'],
            });
        }
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) mq.addEventListener('change', refresh);
        else if (mq.addListener) mq.addListener(refresh);
        return observer;
    }

    /**
     * 给 badge 元素设置通用结构样式（inline，绕过 Shadow DOM 隔离）
     */
    function applyBaseBadgeStyles(el, displayVar) {
        const s = el.style;
        s.display = `var(${displayVar})`;
        s.alignItems = 'center';
        s.height = '22px';
        s.padding = '0 6px';
        s.marginRight = '6px';
        s.fontSize = '11px';
        s.lineHeight = '22px';
        s.borderRadius = '4px';
        s.whiteSpace = 'nowrap';
        s.userSelect = 'none';
        s.flexShrink = '0';
        s.fontWeight = '500';
        s.letterSpacing = '0.01em';
        s.verticalAlign = 'middle';
    }

    /**
     * 为粉丝 Badge 设置颜色（inline style，绕过 Shadow DOM 隔离）
     */
    function applyFanBadgeColors(el, tier) {
        const tierIdx = tier - 1;
        const accentHex = FAN_TIERS[tierIdx].color;
        const dark = isDarkTheme();
        const { r, g, b } = hexToRgb(accentHex);

        // 深色模式下提亮文字
        const lightenAmount = dark ? 40 : 0;
        const tr = Math.min(255, r + lightenAmount);
        const tg = Math.min(255, g + lightenAmount);
        const tb = Math.min(255, b + lightenAmount);

        el.style.color = dark
            ? `rgb(${tr},${tg},${tb})`
            : `rgb(${Math.max(0, r - 20)},${Math.max(0, g - 20)},${Math.max(0, b - 20)})`;
        el.style.backgroundColor = `rgba(${r},${g},${b},0.14)`;
        el.style.border = `0.5px solid rgba(${r},${g},${b},0.24)`;
    }

    function createFanBadge(count) {
        const tier = getFanTier(count);
        const text = formatFans(count);
        if (!text) return null;

        const el = document.createElement('div');
        el.className = 'be-badge be-badge-fans';
        el.setAttribute('data-tier', String(tier));
        el.textContent = text;

        applyBaseBadgeStyles(el, '--be-show-fans');
        applyFanBadgeColors(el, tier);

        return el;
    }

    /**
     * 在 reply-control 中插入 fan badge（放在 IP badge 后面、like 前面）
     */
    function insertFanBadge(replyControlRoot, fanEl) {
        // 已有则跳过
        if (replyControlRoot.querySelector('.be-badge-fans')) return;

        // 找到参考位置：IP badge 后面，或 like 前面
        const ipBadge = replyControlRoot.querySelector('.be-badge-ip');
        if (ipBadge && ipBadge.nextSibling) {
            replyControlRoot.insertBefore(fanEl, ipBadge.nextSibling);
        } else if (replyControlRoot.children.like) {
            replyControlRoot.insertBefore(fanEl, replyControlRoot.children.like);
        } else {
            replyControlRoot.appendChild(fanEl);
        }
    }

    /**
     * 在评论操作栏中渲染 IP Badge，并异步加载粉丝 Badge
     */
    function renderBadges(root, data, replyControlRoot) {
        // 确保 reply-control 已渲染子元素
        if (!replyControlRoot.children || replyControlRoot.children.length === 0) return;

        // ── IP Badge（同步） ──
        if (data.ip && !replyControlRoot.querySelector('.be-badge-ip')) {
            const ipEl = document.createElement('div');
            ipEl.className = 'be-badge be-badge-ip';
            ipEl.textContent = data.ip;

            applyBaseBadgeStyles(ipEl, '--be-show-ip');
            // IP badge 的低调灰配色（inline，绕过 Shadow DOM）
            ipEl.style.color = '#9499a0';
            ipEl.style.backgroundColor = 'rgba(148,153,160,0.12)';
            ipEl.style.border = '0.5px solid rgba(148,153,160,0.18)';

            if (CONFIG.position === 'before-like' && replyControlRoot.children.like) {
                replyControlRoot.insertBefore(ipEl, replyControlRoot.children.like);
            } else {
                replyControlRoot.appendChild(ipEl);
            }
        }

        // ── 粉丝 Badge（异步，通过 API 获取） ──
        if (data.mid && !replyControlRoot.querySelector('.be-badge-fans')) {
            fetchFanCount(data.mid).then(count => {
                if (count == null) return;
                // 二次确认 footer 和 replyControlRoot 仍存在
                const footer = root.getElementById('footer');
                if (!footer || !footer.children[0]) return;
                const rcRoot = footer.children[0].shadowRoot;
                if (!rcRoot) return;
                const fanEl = createFanBadge(count);
                if (fanEl) insertFanBadge(rcRoot, fanEl);
            });
        }
    }

    /**
     * 通过 CSS 自定义属性控制所有 badge 的可见性
     * CSS 自定义属性会穿透 Shadow DOM，无需遍历 shadow tree
     */
    function applyVisibility() {
        document.documentElement.style.setProperty(
            '--be-show-ip',
            settings.showIp ? 'inline-flex' : 'none'
        );
        document.documentElement.style.setProperty(
            '--be-show-fans',
            settings.showFans ? 'inline-flex' : 'none'
        );
        document.documentElement.style.setProperty(
            '--be-show-fav',
            settings.enableFavorite ? 'inline-flex' : 'none'
        );
        applySiteCollectVisibility();
    }

    /**
     * 主题切换时重新给所有粉丝 Badge 上色
     */
    function recolorAllFanBadges() {
        // 粉丝 badge 在 shadow DOM 内，document.querySelectorAll 找不到它们
        // 但我们可以遍历所有 bili-comments 下的 shadow tree
        const comments = document.getElementsByTagName('bili-comments');
        for (const comment of comments) {
            const shadow = comment.shadowRoot;
            if (!shadow) continue;
            const feed = shadow.children?.contents?.children?.feed;
            if (!feed) continue;
            for (const stack of feed.children) {
                const ss = stack.shadowRoot;
                if (!ss) continue;
                // 主评论
                const main = ss.children.comment;
                if (main?.shadowRoot) {
                    recolorInShadowRoot(main.shadowRoot);
                }
                // 回复
                const replies = ss.children?.replies?.children?.[0];
                if (replies?.shadowRoot) {
                    const renderers = replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
                    for (const r of renderers) {
                        if (r.shadowRoot) recolorInShadowRoot(r.shadowRoot);
                    }
                }
            }
        }
    }

    function recolorInShadowRoot(root) {
        const footer = root.getElementById('footer');
        if (!footer?.children?.[0]) return;
        const rc = footer.children[0].shadowRoot;
        if (!rc) return;
        const fanBadge = rc.querySelector('.be-badge-fans');
        if (fanBadge) {
            const tier = parseInt(fanBadge.getAttribute('data-tier'), 10);
            if (tier) applyFanBadgeColors(fanBadge, tier);
        }
        const favBtn = rc.querySelector('.be-fav-btn');
        if (favBtn) setFavButtonState(favBtn, favBtn.classList.contains('be-faved'));
    }

    /** 收藏缓存从 IndexedDB / 跨域桥接加载完成后，刷新已渲染评论的收藏按钮状态 */
    function refreshFavoriteButtonStates() {
        const comments = document.getElementsByTagName('bili-comments');
        for (const comment of comments) {
            const shadow = comment.shadowRoot;
            if (!shadow) continue;
            const feed = shadow.children?.contents?.children?.feed;
            if (!feed) continue;
            for (const stack of feed.children) {
                const ss = stack.shadowRoot;
                if (!ss) continue;
                const main = ss.children.comment;
                if (main?.shadowRoot) refreshFavButtonInShadowRoot(main.shadowRoot);
                const replies = ss.children?.replies?.children?.[0];
                if (replies?.shadowRoot) {
                    const renderers = replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
                    for (const r of renderers) {
                        if (r.shadowRoot) refreshFavButtonInShadowRoot(r.shadowRoot);
                    }
                }
            }
        }
    }

    function refreshFavButtonInShadowRoot(root) {
        const footer = root.getElementById('footer');
        if (!footer?.children?.[0]) return;
        const rc = footer.children[0].shadowRoot;
        if (!rc) return;
        const btn = rc.querySelector('.be-fav-btn');
        if (!btn) return;
        const id = btn.getAttribute('data-rpid');
        if (id) setFavButtonState(btn, favoriteIdSet.has(id));
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 8: 评论遍历与 Observation
    // ═══════════════════════════════════════════════════════════════

    /**
     * 处理单个评论根节点：提取数据、渲染 badge、注册 observer
     */
    function processCommentRoot(commentRoot, observer) {
        observer.observe(commentRoot, { childList: true, subtree: true });

        const data = extractCommentData(commentRoot);
        if (!data) return;

        const footer = commentRoot.getElementById('footer');
        if (!footer || !footer.children[0]) return;

        const replyControlRoot = footer.children[0].shadowRoot;
        if (!replyControlRoot) return;

        observer.observe(replyControlRoot, { childList: true, subtree: true });

        renderBadges(commentRoot, data, replyControlRoot);
        addFavoriteButton(commentRoot, data, replyControlRoot);
    }

    /**
     * 遍历所有 bili-comments 并标注 IP + 粉丝
     */
    function labelAllComments(observer) {
        const comments = document.getElementsByTagName('bili-comments');
        if (comments.length === 0) return;

        for (const comment of comments) {
            // 观察 bili-comments 自身的 shadow root
            const commentShadow = comment.shadowRoot;
            if (!commentShadow) continue;
            observer.observe(commentShadow, { childList: true, subtree: true });

            const feed = commentShadow.children?.contents?.children?.feed;
            if (!feed) continue;

            for (const commentStack of feed.children) {
                const stackShadow = commentStack.shadowRoot;
                if (!stackShadow) continue;
                observer.observe(stackShadow, { childList: true, subtree: true });

                // ── 主评论 ──
                const mainComment = stackShadow.children.comment;
                if (mainComment && mainComment.shadowRoot) {
                    processCommentRoot(mainComment.shadowRoot, observer);
                }

                // ── 回复 ──
                const replies = stackShadow.children?.replies;
                if (!replies || !replies.children[0]) continue;

                const replyContainer = replies.children[0];
                if (replyContainer.shadowRoot) {
                    observer.observe(replyContainer.shadowRoot, { childList: true, subtree: true });
                    const replyRenderers = replyContainer.shadowRoot.querySelectorAll(
                        'bili-comment-reply-renderer'
                    );
                    for (const replyRenderer of replyRenderers) {
                        if (replyRenderer.shadowRoot) {
                            processCommentRoot(replyRenderer.shadowRoot, observer);
                        }
                    }
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 8.5: 评论收藏功能（IndexedDB 无感存储 + 收藏面板）
    // ═══════════════════════════════════════════════════════════════

    const FAV_DB_NAME = 'bili-enhancer-fav';
    const FAV_DB_STORE = 'favorites';            // keyPath: id
    const FAV_ASSET_STORE = 'assets';            // keyPath: url（封面 / 头像 Blob 缓存）
    const FAV_MIRROR_STORE = 'mirror';           // keyPath: key（www 收藏的离线镜像）
    const FAV_HANDLE_STORE = 'handles';          // keyPath: key（离线副本目录句柄）
    const FAV_DB_VERSION = 4;
    const FAV_DB_BLOCKED_BACKOFF = 6000;       // 被其它标签页占用时，多久内不再重试（关掉旧标签页后能尽快恢复）
    const OFFLINE_DIR_KEY = 'offline-dir';
    const OFFLINE_BUNDLE_NAME = 'comment-collector-offline';
    const FAV_ASSET_MAX_BYTES = 6 * 1024 * 1024;         // 单张图片上限
    const FAV_ASSET_BUDGET_BYTES = 160 * 1024 * 1024;    // 资源缓存总量软上限
    const FAV_EXPORT_PREFIX = 'bilibili-favorites';
    const FAV_EXPORT_TYPES = [{ description: 'JSON 收藏文件', accept: { 'application/json': ['.json'] } }];
    const FAV_OFFLINE_TYPES = [{ description: '离线收藏页面', accept: { 'text/html': ['.html'] } }];

    const FAV_ICONS = {
        bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V21l-6-4-6 4z"/></svg>',
        download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
        close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12"/><path d="M18 6 6 18"/></svg>',
        search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
        trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
        open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>',
        video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>',
        offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18"/><path d="M5.5 12.4A10 10 0 0 1 9 10.3"/><path d="M15.2 10.4A10 10 0 0 1 18.5 12.4"/><path d="M8.7 15.6a5 5 0 0 1 6.6 0"/><path d="M12 19.5h.01"/></svg>',
        folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.8 2h8A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-14A1.5 1.5 0 0 1 3 17.5z"/></svg>',
        file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5"/><path d="M19 8.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8z"/></svg>',
    };

    let favoriteIdSet = new Set();               // 本会话已知的已收藏 id
    let favoriteLoaded = false;                  // 是否已从 IndexedDB 初始化
    let favoriteRecords = [];                    // 当前收藏缓存（面板渲染用）
    let favoriteCount = 0;                       // 收藏总数（FAB 角标用）
    let favDbPromise = null;
    let favDbBlockedUntil = 0;                 // 数据库升级被占用时的退避截止时间
    let favPanelEl = null;
    let favSearchQuery = '';
    let favPanelOpener = null;
    const FAV_SCROLL_LOCK_CLASS = 'be-fav-page-locked';
    const FAV_SCROLLBAR_VAR = '--be-fav-scrollbar-compensation';

    /** 锁定页面滚动，同时保持滚动条占位，避免打开面板时内容横向重排 */
    function lockFavPageScroll() {
        const root = document.documentElement;
        if (root.classList.contains(FAV_SCROLL_LOCK_CLASS)) return;

        const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
        const currentPaddingRight = parseFloat(getComputedStyle(root).paddingRight) || 0;
        root.style.setProperty(FAV_SCROLLBAR_VAR, `${currentPaddingRight + scrollbarWidth}px`);
        root.classList.add(FAV_SCROLL_LOCK_CLASS);
    }

    function unlockFavPageScroll() {
        const root = document.documentElement;
        root.classList.remove(FAV_SCROLL_LOCK_CLASS);
        root.style.removeProperty(FAV_SCROLLBAR_VAR);
    }

    /** 打开（或创建）收藏数据库 */
    function favDbBlockedError() {
        const siteName = SITE === 'x' ? 'X' : (SITE === 'youtube' ? 'YouTube' : 'B站');
        return new Error(`收藏数据库被其它 ${siteName} 标签页占用，请关闭其它标签页后重试`);
    }

    function openFavDb() {
        // 升级被阻塞时 IndexedDB 并不会取消已发出的 open 请求：它会一直排队，
        // 后续请求只能排在后面一起卡住（表现就是"收藏点了没反应"）。
        // 因此进入退避窗口后直接快速失败，让 UI 能给出提示。
        if (Date.now() < favDbBlockedUntil) return Promise.reject(favDbBlockedError());
        if (favDbPromise) return favDbPromise;
        favDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(FAV_DB_NAME, FAV_DB_VERSION);
            let abandoned = false;

            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(FAV_DB_STORE)) {
                    db.createObjectStore(FAV_DB_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(FAV_ASSET_STORE)) {
                    db.createObjectStore(FAV_ASSET_STORE, { keyPath: 'url' });
                }
                if (!db.objectStoreNames.contains(FAV_MIRROR_STORE)) {
                    db.createObjectStore(FAV_MIRROR_STORE, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(FAV_HANDLE_STORE)) {
                    db.createObjectStore(FAV_HANDLE_STORE, { keyPath: 'key' });
                }
            };

            req.onsuccess = () => {
                const db = req.result;
                // 其它标签页要升级数据库时主动让路：否则旧连接会把升级卡死，
                // 表现就是"收藏点了没反应"。
                db.onversionchange = () => {
                    try { db.close(); } catch (_) { /* ignore */ }
                    favDbPromise = null;
                };
                if (abandoned) {
                    // 之前已因阻塞放弃，请求现在才完成：关掉连接，别继续占用
                    try { db.close(); } catch (_) { /* ignore */ }
                    return;
                }
                resolve(db);
            };

            req.onerror = () => {
                if (!abandoned) reject(req.error || new Error('IndexedDB 打开失败'));
            };

            // 升级被别的标签页挡住时，请求会无限等待。这里主动失败并给出可操作的提示，
            // 而不是让收藏按钮一直转/一直禁用。
            req.onblocked = () => {
                abandoned = true;
                favDbBlockedUntil = Date.now() + FAV_DB_BLOCKED_BACKOFF;
                reject(favDbBlockedError());
            };
        }).catch((e) => {
            favDbPromise = null;   // 允许之后重试（用户关掉旧标签页即可恢复）
            throw e;
        });
        return favDbPromise;
    }

    /** 读取全部收藏 */
    async function favGetAllLocal() {
        try {
            const db = await openFavDb();
            const list = await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_DB_STORE, 'readonly');
                const r = tx.objectStore(FAV_DB_STORE).getAll();
                r.onsuccess = () => resolve(r.result || []);
                r.onerror = () => reject(r.error);
            });
            return list;
        } catch (_) { return []; }
    }

    /** 写入单条收藏记录 */
    async function favPutLocal(record) {
        const db = await openFavDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FAV_DB_STORE, 'readwrite');
            tx.objectStore(FAV_DB_STORE).put(record);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // ── 离线镜像 ──
    // 子域页面靠 www 的 iframe 桥接读取收藏，而 iframe 需要联网才能加载。
    // 这里把最近一次成功同步的结果镜像到本地，供断网时兜底读取。

    const FAV_MIRROR_KEY = 'favorites';

    async function favMirrorWrite(records) {
        if (!Array.isArray(records)) return;
        try {
            const db = await openFavDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_MIRROR_STORE, 'readwrite');
                tx.objectStore(FAV_MIRROR_STORE).put({
                    key: FAV_MIRROR_KEY,
                    records,
                    saved_at: new Date().toISOString(),
                });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (_) { /* ignore */ }
    }

    async function favMirrorRead() {
        try {
            const db = await openFavDb();
            const rec = await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_MIRROR_STORE, 'readonly');
                const r = tx.objectStore(FAV_MIRROR_STORE).get(FAV_MIRROR_KEY);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
            return rec && Array.isArray(rec.records) ? rec.records : [];
        } catch (_) { return []; }
    }

    /** 离线镜像的乐观更新：离线增删后，本地视图立刻一致 */
    async function favMirrorUpsert(record) {
        const records = await favMirrorRead();
        const next = records.filter(r => r && r.id !== record.id);
        next.unshift(record);
        await favMirrorWrite(next);
    }

    async function favMirrorRemove(id) {
        const records = await favMirrorRead();
        if (!records.length) return;
        const next = records.filter(r => r && r.id !== id);
        if (next.length === records.length) return;
        await favMirrorWrite(next);
    }

    // ── 离线副本目录（File System Access）──
    // 断网时网站本身打不开，油猴脚本也不会运行，所以离线入口必须独立于网页。
    // 这里让收藏在本地目录里自动维护一份可双击打开的离线页面：
    //   <目录>/comment-collector-offline/index.html
    //   <目录>/comment-collector-offline/assets/<hash>.<ext>
    // 图片走相对路径，file:// 下可直接加载，不必每次重写整包。

    let offlineDirHandle = null;       // 已授权的目录句柄（内存缓存）
    let offlineDirChecked = false;     // 是否已尝试从 IndexedDB 恢复句柄
    let offlineSyncTimer = null;
    let offlineSyncRunning = false;
    let offlineLastSyncAt = 0;
    let offlineLastError = '';

    function supportsOfflineDir() {
        return typeof window.showDirectoryPicker === 'function';
    }

    async function offlineDirGetStored() {
        try {
            const db = await openFavDb();
            const rec = await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_HANDLE_STORE, 'readonly');
                const r = tx.objectStore(FAV_HANDLE_STORE).get(OFFLINE_DIR_KEY);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
            return rec && rec.handle ? rec.handle : null;
        } catch (_) { return null; }
    }

    async function offlineDirStore(handle) {
        const db = await openFavDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FAV_HANDLE_STORE, 'readwrite');
            tx.objectStore(FAV_HANDLE_STORE).put({
                key: OFFLINE_DIR_KEY,
                handle,
                saved_at: new Date().toISOString(),
            });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    async function offlineDirForget() {
        offlineDirHandle = null;
        offlineLastError = '';
        try {
            const db = await openFavDb();
            await new Promise((resolve) => {
                const tx = db.transaction(FAV_HANDLE_STORE, 'readwrite');
                tx.objectStore(FAV_HANDLE_STORE).delete(OFFLINE_DIR_KEY);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
                tx.onabort = resolve;
            });
        } catch (_) { /* ignore */ }
        updateOfflineSyncState();
    }

    /** 恢复已保存的目录句柄（不申请权限，仅复用同会话内仍有效的授权） */
    async function offlineDirRestore() {
        if (offlineDirChecked) return offlineDirHandle;
        offlineDirChecked = true;
        const stored = await offlineDirGetStored();
        if (!stored) return null;
        offlineDirHandle = stored;
        return stored;
    }

    async function offlineDirEnsurePermission(handle, interactive) {
        if (!handle) return false;
        try {
            const opts = { mode: 'readwrite' };
            let state = 'granted';
            if (typeof handle.queryPermission === 'function') {
                state = await handle.queryPermission(opts);
            }
            if (state === 'granted') return true;
            if (!interactive) return false;
            if (typeof handle.requestPermission !== 'function') return false;
            state = await handle.requestPermission(opts);
            return state === 'granted';
        } catch (_) { return false; }
    }

    /** 图片落盘为 assets/<hash>.<ext>，返回相对路径；已存在则直接复用 */
    async function writeOfflineAsset(assetsDir, url, blob) {
        const ext = (() => {
            const fromType = (blob.type || '').split('/')[1] || '';
            const clean = fromType.replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (clean) return clean === 'jpeg' ? 'jpg' : clean;
            const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
            return m ? m[1].toLowerCase() : 'jpg';
        })();
        const name = 'a' + simpleHash(url) + '.' + ext;
        const rel = 'assets/' + name;
        try {
            await assetsDir.getFileHandle(name);
            return rel; // 已存在，跳过写入
        } catch (_) { /* 不存在，继续写入 */ }
        const fileHandle = await assetsDir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return rel;
    }

    /** 取图片 Blob：优先本地缓存，缺失时在线抓取并顺手缓存 */
    async function resolveAssetBlob(rawUrl) {
        const url = safeImageUrl(rawUrl);
        if (!url) return null;
        const cached = await favAssetGetLocal(url);
        if (cached && cached.blob) return cached.blob;
        try {
            const res = await fetch(url, {
                mode: 'cors',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                cache: 'force-cache',
            });
            if (!res.ok) return null;
            const blob = await res.blob();
            if (!blob || !blob.size || blob.size > FAV_ASSET_MAX_BYTES) return null;
            await favAssetPutLocal(url, blob);
            registerFavAssetObjectUrl(url, blob);
            return blob;
        } catch (_) { return null; }
    }

    /** 按统一结构准备离线条目，src 由调用方决定（dataURL 或相对路径） */
    async function buildOfflineEntries(records, resolveSrc, onProgress) {
        const entries = [];
        // 同一张图片（例如默认头像）可能被多条记录引用，复用同一个 Promise
        const memo = new Map();
        const resolveOnce = (raw) => {
            const key = safeImageUrl(raw);
            if (!key) return Promise.resolve('');
            if (!memo.has(key)) {
                memo.set(key, Promise.resolve(resolveSrc(key)).catch(() => ''));
            }
            return memo.get(key);
        };
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const isMedia = record.type === 'video' || record.type === 'post';
            const [coverSrc, faceSrc] = await Promise.all([
                isMedia && (record.cover || record.cover_fallback)
                    ? resolveOnce(record.cover || record.cover_fallback)
                    : Promise.resolve(''),
                record.face ? resolveOnce(record.face) : Promise.resolve(''),
            ]);
            entries.push({ record, coverSrc: coverSrc || '', faceSrc: faceSrc || '' });
            if (onProgress) onProgress(i + 1, records.length);
        }
        return entries;
    }

    const OFFLINE_SIG_KEY = 'be-offline-sync-signature';

    function offlineRecordsSignature(records) {
        return simpleHash((records || []).map(r => (r.id || '') + ':' + (r.saved_at || '')).sort().join('|'));
    }

    function offlineReadSignature() {
        try { return localStorage.getItem(OFFLINE_SIG_KEY) || ''; } catch (_) { return ''; }
    }

    function offlineWriteSignature(sig) {
        try { localStorage.setItem(OFFLINE_SIG_KEY, sig); } catch (_) { /* ignore */ }
    }

    async function offlineFileExists(dir, name) {
        try { await dir.getFileHandle(name); return true; } catch (_) { return false; }
    }

    /** 把当前收藏同步到本地目录（首次需要用户授权） */
    async function syncOfflineBundle(options) {
        const opts = options || {};
        if (offlineSyncRunning) return { ok: false, reason: 'busy' };
        const handle = offlineDirHandle || await offlineDirRestore();
        if (!handle) return { ok: false, reason: 'unconfigured' };
        if (!await offlineDirEnsurePermission(handle, !!opts.interactive)) {
            offlineLastError = 'permission';
            updateOfflineSyncState();
            return { ok: false, reason: 'permission' };
        }

        offlineSyncRunning = true;
        const toast = opts.toast !== false ? showFavProgress('正在同步离线副本…') : null;
        try {
            const list = await favGetAll();
            const sorted = list.slice().sort((a, b) => toTimestamp(b.saved_at) - toTimestamp(a.saved_at));
            const root = await handle.getDirectoryHandle(OFFLINE_BUNDLE_NAME, { create: true });

            // 收藏没变且入口文件还在时跳过，避免每次打开页面都重写磁盘
            const signature = offlineRecordsSignature(sorted);
            if (!opts.force && offlineReadSignature() === signature && await offlineFileExists(root, 'index.html')) {
                offlineLastSyncAt = Date.now();
                offlineLastError = '';
                updateOfflineSyncState();
                if (toast) toast.done('离线副本已是最新');
                return { ok: true, skipped: true, count: sorted.length };
            }

            const assetsDir = await root.getDirectoryHandle('assets', { create: true });

            const usedAssets = new Set();
            let assetFailed = false;
            const entries = await buildOfflineEntries(sorted, async (rawUrl) => {
                const url = safeImageUrl(rawUrl);
                if (!url) return '';
                const blob = await resolveAssetBlob(url);
                if (!blob) { assetFailed = true; return ''; }
                try {
                    const rel = await writeOfflineAsset(assetsDir, url, blob);
                    usedAssets.add(rel.slice('assets/'.length));
                    return rel;
                } catch (_) { assetFailed = true; return ''; }
            }, (done, total) => {
                if (toast) toast.update('正在同步离线副本… ' + done + '/' + total);
            });

            // 清掉已不再被任何收藏引用的图片，避免目录无限增长。
            // 有资源取回失败时跳过，避免离线状态误删仍在用的文件。
            try {
                if (assetFailed) throw new Error('skip-cleanup');
                const stale = [];
                for await (const [name] of assetsDir.entries()) {
                    if (!usedAssets.has(name)) stale.push(name);
                }
                for (const name of stale) {
                    try { await assetsDir.removeEntry(name); } catch (_) { /* ignore */ }
                }
            } catch (_) { /* 目录枚举不可用时跳过清理 */ }

            const html = offlinePageHtml(entries, new Date().toISOString());
            const htmlFile = await root.getFileHandle('index.html', { create: true });
            const writable = await htmlFile.createWritable();
            await writable.write(html);
            await writable.close();

            offlineWriteSignature(signature);
            offlineLastSyncAt = Date.now();
            offlineLastError = '';
            updateOfflineSyncState();
            if (toast) toast.done('离线副本已更新（' + sorted.length + ' 条）');
            return { ok: true, count: sorted.length };
        } catch (e) {
            offlineLastError = String((e && e.name) || e);
            updateOfflineSyncState();
            if (toast) toast.done('离线副本同步失败');
            return { ok: false, reason: offlineLastError };
        } finally {
            offlineSyncRunning = false;
        }
    }

    /** 收藏 / 删除后延迟同步，避免连续操作时反复写盘 */
    function scheduleOfflineSync(delay) {
        if (!offlineDirHandle) return;
        clearTimeout(offlineSyncTimer);
        offlineSyncTimer = setTimeout(() => {
            syncOfflineBundle({ toast: false }).catch(() => {});
        }, typeof delay === 'number' ? delay : 2500);
    }

    /** 选择离线副本目录（需要用户手势），并把当前收藏写入其中 */
    async function configureOfflineDir() {
        if (!supportsOfflineDir()) return { ok: false, reason: 'unsupported' };
        let handle;
        try {
            handle = await window.showDirectoryPicker({
                id: 'comment-collector-offline',
                mode: 'readwrite',
                startIn: 'desktop',
            });
        } catch (e) {
            if (e && e.name === 'AbortError') return { ok: false, reason: 'cancelled' };
            return { ok: false, reason: String((e && e.name) || e) };
        }
        offlineDirHandle = handle;
        offlineDirChecked = true;
        try { await offlineDirStore(handle); } catch (_) { /* 句柄存不下时仍可用于本会话 */ }
        updateOfflineSyncState();
        return syncOfflineBundle({ interactive: true, force: true });
    }

    /** 离线菜单内容：随是否已绑定目录变化 */
    function renderOfflineMenu() {
        const menu = document.getElementById('be-offline-menu');
        if (!menu) return;
        const hasDir = !!offlineDirHandle;
        const items = [];
        if (supportsOfflineDir()) {
            items.push({
                action: hasDir ? 'sync' : 'bind',
                icon: FAV_ICONS.folder,
                title: hasDir ? '立即同步' : '同步到文件夹',
                desc: hasDir ? '更新本地离线副本' : '自动更新，断网双击即可打开',
            });
            if (hasDir) {
                items.push({
                    action: 'bind',
                    icon: FAV_ICONS.folder,
                    title: '更换文件夹',
                    desc: '重新选择离线副本位置',
                });
            }
        }
        items.push({
            action: 'file',
            icon: FAV_ICONS.file,
            title: '下载单文件',
            desc: '图片全部内联，便于分享备份',
        });
        setHtml(menu, items.map((it) => `
            <button type="button" class="be-offline-item" role="menuitem" data-action="${it.action}">
                <span class="be-offline-item-icon">${it.icon}</span>
                <span class="be-offline-item-text">
                    <span class="be-offline-item-title">${escapeHtml(it.title)}</span>
                    <span class="be-offline-item-desc">${escapeHtml(it.desc)}</span>
                </span>
            </button>`).join(''));
    }

    function toggleOfflineMenu(force) {
        const menu = document.getElementById('be-offline-menu');
        if (!menu) return;
        const show = typeof force === 'boolean' ? force : menu.hasAttribute('hidden');
        if (!show) { menu.setAttribute('hidden', ''); return; }
        renderOfflineMenu();
        menu.removeAttribute('hidden');
    }

    /** 执行离线菜单动作 */
    async function runOfflineAction(action) {
        toggleOfflineMenu(false);
        if (action === 'file') {
            await exportOfflineSnapshot();
            return;
        }
        if (!supportsOfflineDir()) {
            await exportOfflineSnapshot();
            return;
        }
        if (action === 'bind' || !offlineDirHandle) {
            if (!offlineDirHandle) await offlineDirRestore();
        }
        if (action === 'bind' || !offlineDirHandle) {
            const res = await configureOfflineDir();
            if (res.ok) return;
            if (res.reason === 'cancelled') return;
            showFavToast('离线副本设置失败');
            return;
        }
        // 手动同步走全量：既确保目录完整，也顺手清掉不再引用的资源
        const res = await syncOfflineBundle({ interactive: true, force: true });
        if (res.ok) return;
        if (res.reason === 'permission') showFavToast('未获得目录写入权限');
        else if (res.reason !== 'busy') showFavToast('离线副本同步失败');
    }

    /** 删除单条收藏记录 */
    async function favDeleteLocal(id) {
        const db = await openFavDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FAV_DB_STORE, 'readwrite');
            tx.objectStore(FAV_DB_STORE).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // ── 本地资源缓存（封面 / 头像）──
    // 图片以 Blob 存进 IndexedDB，断网时收藏面板仍能完整呈现内容。
    // 不缓存视频文件本体：体量过大，离线页面保留封面、标题与原始链接。

    const favAssetObjectUrls = new Map();   // 原始图片 URL → objectURL

    /** 图片 URL 列表（封面、封面回退、头像） */
    function recordAssetUrls(record) {
        const urls = [];
        if (!record) return urls;
        const push = (raw) => {
            const url = safeImageUrl(raw);
            if (url && !urls.includes(url)) urls.push(url);
        };
        push(record.cover);
        push(record.cover_fallback);
        push(record.face);
        return urls;
    }

    /** 已缓存资源的 objectURL，命中则直接返回，供渲染同步使用 */
    function cachedAssetSrc(url) {
        const key = safeImageUrl(url);
        if (!key) return '';
        return favAssetObjectUrls.get(key) || key;
    }

    async function favAssetGetLocal(url) {
        try {
            const db = await openFavDb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_ASSET_STORE, 'readonly');
                const r = tx.objectStore(FAV_ASSET_STORE).get(url);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
        } catch (_) { return null; }
    }

    async function favAssetPutLocal(url, blob) {
        const db = await openFavDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(FAV_ASSET_STORE, 'readwrite');
            tx.objectStore(FAV_ASSET_STORE).put({
                url,
                blob,
                size: blob.size || 0,
                type: blob.type || '',
                saved_at: new Date().toISOString(),
            });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    async function favAssetDeleteLocal(url) {
        try {
            const db = await openFavDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(FAV_ASSET_STORE, 'readwrite');
                tx.objectStore(FAV_ASSET_STORE).delete(url);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (_) { /* ignore */ }
    }

    /** 批量读取资源，返回 Map(原始 URL → Blob) */
    async function favAssetGetManyLocal(urls) {
        const found = new Map();
        const keys = [...new Set((urls || []).filter(Boolean))];
        if (!keys.length) return found;
        try {
            const db = await openFavDb();
            await new Promise((resolve) => {
                const tx = db.transaction(FAV_ASSET_STORE, 'readonly');
                const store = tx.objectStore(FAV_ASSET_STORE);
                keys.forEach((url) => {
                    const r = store.get(url);
                    r.onsuccess = () => {
                        const rec = r.result;
                        if (rec && rec.blob) found.set(url, rec.blob);
                    };
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            });
        } catch (_) { /* ignore */ }
        return found;
    }

    function registerFavAssetObjectUrl(url, blob) {
        if (!url || !blob) return '';
        const existing = favAssetObjectUrls.get(url);
        if (existing) return existing;
        try {
            const objectUrl = URL.createObjectURL(blob);
            favAssetObjectUrls.set(url, objectUrl);
            return objectUrl;
        } catch (_) { return ''; }
    }

    /** 把记录引用到的图片读进内存缓存，供面板同步渲染 */
    async function hydrateFavoriteAssets(records) {
        const pending = [];
        const seen = new Set();
        for (const record of records || []) {
            for (const url of recordAssetUrls(record)) {
                if (seen.has(url) || favAssetObjectUrls.has(url)) continue;
                seen.add(url);
                pending.push(url);
            }
        }
        if (!pending.length) return;
        const found = await favAssetGetManyLocal(pending);
        found.forEach((blob, url) => registerFavAssetObjectUrl(url, blob));
    }

    /** 拉取一张图片并写入缓存；失败（离线 / 防盗链 / 超限）时静默跳过 */
    async function cacheOneAsset(url) {
        if (!url) return false;
        if (favAssetObjectUrls.has(url)) return true;
        try {
            const res = await fetch(url, {
                mode: 'cors',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                cache: 'force-cache',
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            if (!blob || !blob.size) throw new Error('empty');
            if (blob.size > FAV_ASSET_MAX_BYTES) throw new Error('too large');
            await favAssetPutLocal(url, blob);
            registerFavAssetObjectUrl(url, blob);
            return true;
        } catch (_) {
            return false;
        }
    }

    /** 收藏时把封面 / 头像落盘，保证之后离线可看 */
    async function cacheFavoriteAssets(record) {
        const urls = recordAssetUrls(record);
        if (!urls.length) return;
        for (const url of urls) {
            const cached = await favAssetGetLocal(url);
            if (cached && cached.blob) {
                registerFavAssetObjectUrl(url, cached.blob);
                continue;
            }
            await cacheOneAsset(url);
        }
        await pruneFavAssets().catch(() => {});
    }

    /** 缓存超过软上限时按写入时间淘汰最旧的资源 */
    async function pruneFavAssets() {
        let db;
        try { db = await openFavDb(); } catch (_) { return; }
        const all = await new Promise((resolve) => {
            try {
                const tx = db.transaction(FAV_ASSET_STORE, 'readonly');
                const r = tx.objectStore(FAV_ASSET_STORE).getAll();
                r.onsuccess = () => resolve(r.result || []);
                r.onerror = () => resolve([]);
            } catch (_) { resolve([]); }
        });
        let total = all.reduce((sum, item) => sum + (item && item.size ? item.size : 0), 0);
        if (total <= FAV_ASSET_BUDGET_BYTES) return;
        const ordered = all.slice().sort((a, b) => toTimestamp(a.saved_at) - toTimestamp(b.saved_at));
        for (const item of ordered) {
            if (total <= FAV_ASSET_BUDGET_BYTES) break;
            await favAssetDeleteLocal(item.url);
            const objectUrl = favAssetObjectUrls.get(item.url);
            if (objectUrl) {
                try { URL.revokeObjectURL(objectUrl); } catch (_) { /* ignore */ }
                favAssetObjectUrls.delete(item.url);
            }
            total -= item.size || 0;
        }
    }

    /** 补齐旧收藏缺失的图片资源（打开面板时后台执行，限流避免打满网络） */
    let favAssetBackfillRunning = false;
    async function backfillFavoriteAssets(records) {
        if (favAssetBackfillRunning) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        favAssetBackfillRunning = true;
        try {
            const missing = [];
            const seen = new Set();
            for (const record of records || []) {
                for (const url of recordAssetUrls(record)) {
                    if (seen.has(url) || favAssetObjectUrls.has(url)) continue;
                    seen.add(url);
                    missing.push(url);
                }
            }
            if (!missing.length) return;

            // 先批量命中本地缓存，只对真正缺失的资源发网络请求
            const found = await favAssetGetManyLocal(missing);
            found.forEach((blob, url) => registerFavAssetObjectUrl(url, blob));
            for (const url of missing) {
                if (found.has(url)) continue;
                await cacheOneAsset(url);
                await new Promise(r => setTimeout(r, 60));
            }
            await pruneFavAssets().catch(() => {});
        } finally {
            favAssetBackfillRunning = false;
        }
    }

    function hasFsAccessApi() {
        return typeof window.showSaveFilePicker === 'function';
    }


    // ── 跨子域收藏同步桥 ──
    // IndexedDB 按 origin 隔离，www / t / space / search 四个子域互相看不到数据。
    // 这里用 www.bilibili.com 的轻量 404 页面做隐藏 iframe，
    // 通过 postMessage 把读写请求转发到 www 的 IndexedDB。
    const FAV_BRIDGE_ORIGIN = 'https://www.bilibili.com';
    const FAV_BRIDGE_URL = FAV_BRIDGE_ORIGIN + '/404?be_fav_bridge=1';
    const FAV_BRIDGE_PARAM = 'be_fav_bridge';
    const FAV_BRIDGE_TIMEOUT = 6000;
    const FAV_BRIDGE_ALLOWED_ORIGINS = new Set([
        'https://www.bilibili.com',
        'https://t.bilibili.com',
        'https://space.bilibili.com',
        'https://search.bilibili.com',
    ]);

    let favBridgeFrame = null;
    let favBridgeReadyPromise = null;
    let favBridgeReadyResolve = null;
    let favBridgeMessageBound = false;
    let favBridgeRequestSeq = 0;
    let favBridgeFailed = false;
    const favBridgePending = new Map();

    function isCanonicalFavOrigin() {
        return window.location.origin === FAV_BRIDGE_ORIGIN;
    }

    function isFavBridgeFrame() {
        if (window.top === window.self) return false;
        try {
            return new URLSearchParams(window.location.search).has(FAV_BRIDGE_PARAM);
        } catch (_) {
            return false;
        }
    }

    function sanitizeFavoriteRecord(record) {
        if (!record || typeof record !== 'object') return null;
        const id = record.id != null ? String(record.id).slice(0, 200) : '';
        if (!id) return null;
        const str = (value, max) => value == null ? null : String(value).slice(0, max);
        return {
            id,
            type: record.type === 'video' ? 'video' : (record.type === 'post' ? 'post' : 'comment'),
            site: str(record.site, 20),
            mid: str(record.mid, 64),
            uname: str(record.uname, 200),
            face: str(record.face, 1000),
            content: str(record.content, 10000),
            ctime: typeof record.ctime === 'number' ? record.ctime : null,
            ip: str(record.ip, 100),
            fans: typeof record.fans === 'number' ? record.fans : null,
            page: str(record.page, 2000),
            bvid: str(record.bvid, 32),
            aid: str(record.aid, 32),
            cover: str(record.cover, 2000),
            cover_fallback: str(record.cover_fallback, 2000),
            duration: typeof record.duration === 'number' ? record.duration : null,
            time_text: str(record.time_text, 100),
            saved_at: str(record.saved_at, 100) || new Date().toISOString(),
        };
    }

    /** 运行在 www.bilibili.com 隐藏 iframe 内：接收父页面的读写请求 */
    function initFavBridgeFrame() {
        const sendReady = () => {
            try {
                window.parent.postMessage({ type: 'be-fav-bridge-ready' }, '*');
            } catch (_) { /* ignore */ }
        };

        window.addEventListener('message', async (event) => {
            if (!FAV_BRIDGE_ALLOWED_ORIGINS.has(event.origin)) return;
            if (event.source !== window.parent) return;
            const data = event.data;
            if (!data || data.type !== 'be-fav-bridge-request' || typeof data.id !== 'string') return;

            const reply = (payload) => {
                try {
                    event.source.postMessage(
                        { type: 'be-fav-bridge-response', id: data.id, ...payload },
                        event.origin
                    );
                } catch (_) { /* ignore */ }
            };

            try {
                let result;
                if (data.action === 'getAll') {
                    result = await favGetAllLocal();
                } else if (data.action === 'put') {
                    const record = sanitizeFavoriteRecord(data.payload);
                    if (!record) throw new Error('invalid record');
                    await favPutLocal(record);
                    result = true;
                } else if (data.action === 'delete') {
                    const id = data.payload && data.payload.id != null ? String(data.payload.id) : '';
                    if (!id) throw new Error('invalid id');
                    await favDeleteLocal(id);
                    result = true;
                } else {
                    throw new Error('unknown action');
                }
                reply({ ok: true, result });
            } catch (e) {
                reply({ ok: false, error: String((e && e.message) || e) });
            }
        });

        sendReady();
        window.addEventListener('load', sendReady);
        setTimeout(sendReady, 500);
    }

    function bindFavBridgeMessages() {
        if (favBridgeMessageBound) return;
        favBridgeMessageBound = true;
        window.addEventListener('message', (event) => {
            if (event.origin !== FAV_BRIDGE_ORIGIN) return;
            if (favBridgeFrame && event.source !== favBridgeFrame.contentWindow) return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'be-fav-bridge-ready') {
                if (favBridgeReadyResolve) {
                    const resolve = favBridgeReadyResolve;
                    favBridgeReadyResolve = null;
                    resolve(favBridgeFrame);
                }
                return;
            }

            if (data.type === 'be-fav-bridge-response') {
                const pending = favBridgePending.get(data.id);
                if (!pending) return;
                favBridgePending.delete(data.id);
                clearTimeout(pending.timer);
                if (data.ok) pending.resolve(data.result);
                else pending.reject(new Error(data.error || 'bridge error'));
            }
        });
    }

    function ensureFavBridgeFrame() {
        if (favBridgeFrame && favBridgeFrame.isConnected) return favBridgeFrame;
        favBridgeFrame = document.createElement('iframe');
        favBridgeFrame.id = 'be-fav-bridge-frame';
        favBridgeFrame.src = FAV_BRIDGE_URL;
        favBridgeFrame.setAttribute('aria-hidden', 'true');
        favBridgeFrame.tabIndex = -1;
        favBridgeFrame.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;opacity:0;pointer-events:none;border:0;';
        document.body.appendChild(favBridgeFrame);
        return favBridgeFrame;
    }

    function initFavBridgeClient() {
        if (favBridgeFailed) return Promise.reject(new Error('bridge unavailable'));
        if (favBridgeReadyPromise && favBridgeFrame && favBridgeFrame.isConnected) return favBridgeReadyPromise;

        bindFavBridgeMessages();
        favBridgeReadyPromise = new Promise((resolve, reject) => {
            favBridgeReadyResolve = resolve;
            ensureFavBridgeFrame();
            setTimeout(() => {
                if (!favBridgeReadyResolve) return;
                favBridgeReadyResolve = null;
                favBridgeFailed = true;
                reject(new Error('bridge timeout'));
            }, FAV_BRIDGE_TIMEOUT);
        });
        return favBridgeReadyPromise;
    }

    async function favBridgeRequest(action, payload) {
        if (isCanonicalFavOrigin()) throw new Error('not a bridge origin');
        const frame = await initFavBridgeClient();
        const id = 'be-' + Date.now() + '-' + (++favBridgeRequestSeq);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                favBridgePending.delete(id);
                reject(new Error('bridge request timeout'));
            }, FAV_BRIDGE_TIMEOUT);
            favBridgePending.set(id, { resolve, reject, timer });
            frame.contentWindow.postMessage(
                { type: 'be-fav-bridge-request', id, action, payload },
                FAV_BRIDGE_ORIGIN
            );
        });
    }

    /**
     * 读取全部收藏：B 站非 www 子域走桥接，其它站点使用本站 IndexedDB。
     * 桥接不可用（断网 / iframe 加载失败）时回退到最近一次同步的本地镜像。
     */
    async function favGetAll() {
        if (SITE === 'bilibili' && !isCanonicalFavOrigin()) {
            try {
                const list = await favBridgeRequest('getAll');
                favMirrorWrite(list).catch(() => {});
                return list;
            } catch (e) {
                favBridgeFailed = true;
                const emptyMirror = await favMirrorRead();
                if (emptyMirror.length) {
                    console.warn('[评论增强] B 站跨页面同步不可用，已启用离线镜像');
                    return emptyMirror;
                }
                console.warn('[评论增强] B 站跨页面收藏同步不可用，已回退本地存储：', e);
            }
        }
        return favGetAllLocal();
    }

    /** 写入单条收藏：B 站非 www 子域走桥接，其它站点使用本站 IndexedDB */
    async function favPut(record) {
        const safeRecord = sanitizeFavoriteRecord(record);
        if (!safeRecord) throw new Error('invalid record');
        if (SITE === 'bilibili' && !isCanonicalFavOrigin()) {
            try {
                await favBridgeRequest('put', safeRecord);
                favMirrorUpsert(safeRecord).catch(() => {});
                return;
            } catch (e) {
                favBridgeFailed = true;
                console.warn('[评论增强] B 站跨页面收藏同步不可用，已回退本地存储：', e);
            }
            await favMirrorUpsert(safeRecord).catch(() => {});
        }
        await favPutLocal(safeRecord);
    }

    /** 删除收藏：B 站非 www 子域走桥接，其它站点使用本站 IndexedDB */
    async function favDelete(id) {
        const safeId = id != null ? String(id) : '';
        if (!safeId) return;
        if (SITE === 'bilibili' && !isCanonicalFavOrigin()) {
            try {
                await favBridgeRequest('delete', { id: safeId });
                favMirrorRemove(safeId).catch(() => {});
                return;
            } catch (e) {
                favBridgeFailed = true;
                console.warn('[评论增强] B 站跨页面收藏同步不可用，已回退本地存储：', e);
            }
            await favMirrorRemove(safeId).catch(() => {});
        }
        await favDeleteLocal(safeId);
    }

    /** HTML 转义，避免收藏内容 / 用户名注入 */
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 仅允许 http(s) 链接，防止收藏记录里的异常协议 */
    function safeUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(String(url), window.location.origin);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
        } catch (_) {
            return '';
        }
    }

    /** 仅允许 https 图片，兼容 B 站协议相对头像地址 */
    function safeImageUrl(url) {
        if (!url) return '';
        const raw = String(url).trim();
        const normalized = raw.startsWith('//')
            ? window.location.protocol + raw
            : (raw.startsWith('http://') ? 'https://' + raw.slice(7) : raw);
        try {
            const parsed = new URL(normalized, window.location.origin);
            return parsed.protocol === 'https:' ? parsed.href : '';
        } catch (_) {
            return '';
        }
    }

    /** 生成评论唯一 id */
    function commentUniqueId(data) {
        if (data.rpid) return String(data.rpid);
        return `${data.mid || 'anon'}-${data.ctime || 0}-${(data.content || '').slice(0, 20)}`;
    }

    /** 解析当前视频页的 BV / av 号，只收藏整支视频，不区分分 P */
    function getCurrentVideoRef() {
        const match = window.location.pathname.match(/^\/video\/((?:BV[0-9A-Za-z]+)|(?:av\d+))/i);
        if (!match) return null;

        const raw = match[1];
        const isAv = /^av\d+$/i.test(raw);
        return {
            raw,
            bvid: isAv ? null : raw,
            aid: isAv ? raw.slice(2) : null,
            page: 'https://www.bilibili.com/video/' + raw + '/',
        };
    }

    function videoFavoriteId(ref) {
        return 'video:' + (ref.bvid || ('av' + ref.aid));
    }

    /** 视频接口失败时使用页面已有信息兜底 */
    function getCurrentVideoFallback() {
        const heading = document.querySelector('h1');
        const title = (heading && heading.textContent || document.title || '')
            .trim()
            .replace(/[_｜|]\s*哔哩哔哩.*$/i, '');
        const ownerEl = document.querySelector('.up-name, [class*="up-name"]');
        const cover = document.querySelector('meta[property="og:image"]');
        return {
            title,
            uname: (ownerEl && ownerEl.textContent || '').trim(),
            cover: cover ? cover.content : null,
        };
    }

    async function fetchCurrentVideoInfo(ref) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const param = ref.bvid
            ? 'bvid=' + encodeURIComponent(ref.bvid)
            : 'aid=' + encodeURIComponent(ref.aid);
        try {
            const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?${param}`, {
                credentials: 'omit',
                signal: controller.signal,
            });
            if (!resp.ok) return null;
            const json = await resp.json();
            return json.code === 0 && json.data ? json.data : null;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function buildVideoFavoriteRecord(ref) {
        const fallback = getCurrentVideoFallback();
        const info = await fetchCurrentVideoInfo(ref);
        const owner = info && info.owner ? info.owner : {};
        const bvid = (info && info.bvid) || ref.bvid || null;
        const aid = info && info.aid != null ? String(info.aid) : ref.aid;
        const videoKey = bvid || ('av' + aid);

        return {
            id: videoFavoriteId(ref),
            type: 'video',
            site: 'bilibili',
            mid: owner.mid != null ? String(owner.mid) : null,
            uname: owner.name || fallback.uname || '未知 UP 主',
            face: owner.face || null,
            content: (info && info.title) || fallback.title || `视频 ${videoKey}`,
            ctime: info && typeof info.pubdate === 'number' ? info.pubdate : null,
            ip: null,
            fans: null,
            page: 'https://www.bilibili.com/video/' + videoKey + '/',
            bvid,
            aid,
            cover: (info && info.pic) || fallback.cover || null,
            duration: info && typeof info.duration === 'number' ? info.duration : null,
            saved_at: new Date().toISOString(),
        };
    }

    /** 构建规范评论链接（视频 / opus / 动态详情均带评论锚点） */
    function buildCommentUrl(data) {
        const rpid = data.rpid ? String(data.rpid) : '';
        const loc = window.location;
        if (!rpid) return loc.href;

        const query = 'comment_on=1&comment_root_id=' + encodeURIComponent(rpid) + '&share_tag=s_i';
        const hash = '#reply' + rpid;

        const video = loc.pathname.match(/^\/video\/([A-Za-z0-9]+)/);
        if (video) return loc.origin + '/video/' + video[1] + '?' + query + hash;

        const opus = loc.pathname.match(/^\/opus\/(\d+)/);
        if (opus) return loc.origin + '/opus/' + opus[1] + '?' + query + hash;

        if (loc.hostname === 't.bilibili.com') {
            const dyn = loc.pathname.match(/^\/(\d+)/);
            if (dyn) return 'https://t.bilibili.com/' + dyn[1] + '?' + query + hash;
        }

        return loc.href;
    }

    /** 打开原评论时规范化链接：老收藏若不带锚点，尝试用页面类型 + id 重建 */
    function normalizeRecordUrl(record) {
        const page = (record && record.page) || '';
        if (record && (record.type === 'video' || record.type === 'post')) return page;
        if (/comment_root_id=/.test(page) && /#reply/.test(page)) return page;

        const rpid = record && record.id ? String(record.id) : '';
        if (!rpid) return page;

        const query = 'comment_on=1&comment_root_id=' + encodeURIComponent(rpid) + '&share_tag=s_i';
        const hash = '#reply' + rpid;
        const video = page.match(/\/video\/([A-Za-z0-9]+)/);
        if (video) return 'https://www.bilibili.com/video/' + video[1] + '?' + query + hash;

        const opus = page.match(/\/opus\/(\d+)/);
        if (opus) return 'https://www.bilibili.com/opus/' + opus[1] + '?' + query + hash;

        const dyn = page.match(/^https?:\/\/t\.bilibili\.com\/(\d+)/);
        if (dyn) return 'https://t.bilibili.com/' + dyn[1] + '?' + query + hash;

        return page;
    }

    function buildFavoriteRecord(data) {
        return {
            id: commentUniqueId(data),
            type: 'comment',
            site: 'bilibili',
            mid: data.mid,
            uname: data.uname,
            face: data.face || null,
            content: data.content,
            ctime: data.ctime,
            ip: data.ip,
            fans: data.fans || null,
            page: buildCommentUrl(data),
            saved_at: new Date().toISOString(),
        };
    }

    function toTimestamp(value) {
        if (!value) return 0;
        const t = new Date(value).getTime();
        return isNaN(t) ? 0 : t;
    }

    function formatDateTime(ts) {
        if (!ts) return '未知时间';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '未知时间';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatRelativeTime(ts) {
        if (!ts) return '未知时间';
        const diff = Date.now() - ts;
        if (diff < 0) return formatDateTime(ts);
        if (diff < 60 * 1000) return '刚刚';
        if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + ' 分钟前';
        if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / (60 * 60 * 1000)) + ' 小时前';
        if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / (24 * 60 * 60 * 1000)) + ' 天前';
        return formatDateTime(ts);
    }

    function formatVideoDuration(seconds) {
        if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '';
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    /** 从 IndexedDB 刷新收藏缓存与 FAB 角标 */
    async function refreshFavoriteCache() {
        try {
            const list = await favGetAll();
            favoriteRecords = list
                .filter(r => r && r.id)
                .sort((a, b) => toTimestamp(b.saved_at) - toTimestamp(a.saved_at));
            favoriteIdSet = new Set(favoriteRecords.map(r => r.id));
            favoriteCount = favoriteRecords.length;
        } catch (_) {
            favoriteRecords = [];
            favoriteIdSet = new Set();
            favoriteCount = 0;
        }
        favoriteLoaded = true;
        updateFavCountBadge();
        return favoriteRecords;
    }

    function updateFavCountBadge() {
        const badges = document.querySelectorAll('.be-fab-count');
        if (!badges.length) return;
        const text = favoriteCount > 99 ? '99+' : String(favoriteCount);
        badges.forEach(badge => {
            if (favoriteCount > 0) {
                badge.textContent = text;
                badge.style.display = 'block';
            } else {
                badge.textContent = '';
                badge.style.display = 'none';
            }
        });
    }

    function updateVideoFavoriteMenuItem() {
        updatePrimaryFavoriteMenuItem();
    }

    async function toggleCurrentVideoFavorite() {
        return togglePrimaryFavorite();
    }

    function isFavPanelOpen() {
        const overlay = document.getElementById('be-fav-overlay');
        return !!(overlay && (overlay.open || overlay.classList.contains('be-open')));
    }

    function isOfflineNow() {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }

    /** 离线副本按钮状态：已启用 / 权限失效 / 未配置 */
    function updateOfflineSyncState() {
        const btn = document.getElementById('be-fav-offline');
        if (!btn) return;
        if (!supportsOfflineDir()) {
            btn.classList.remove('be-offline-ready', 'be-offline-warn');
            btn.title = '导出离线页面（无网络也能查看）';
            return;
        }
        if (!offlineDirHandle) {
            btn.classList.remove('be-offline-ready', 'be-offline-warn');
            btn.title = '设置离线副本：自动同步到本地文件夹，断网可双击打开';
            return;
        }
        const needsAuth = offlineLastError === 'permission';
        btn.classList.toggle('be-offline-ready', !needsAuth);
        btn.classList.toggle('be-offline-warn', needsAuth);
        btn.title = needsAuth
            ? '目录写入权限已失效，点击重新授权并同步'
            : '离线副本已启用，点击立即同步';
    }

    /** 离线时在面板标题旁显示状态标记 */
    function updateFavOfflineIndicator() {
        const pill = document.getElementById('be-fav-offline-pill');
        if (!pill) return;
        if (isOfflineNow()) pill.removeAttribute('hidden');
        else pill.setAttribute('hidden', '');
    }

    if (typeof window !== 'undefined' && !window.__beFavOfflineBound) {
        window.__beFavOfflineBound = true;
        window.addEventListener('online', updateFavOfflineIndicator);
        window.addEventListener('offline', updateFavOfflineIndicator);
    }

    /** 收藏 / 取消收藏一条评论（无感写入 IndexedDB） */
    async function toggleFavorite(data) {
        const id = commentUniqueId(data);
        try {
            if (favoriteIdSet.has(id)) {
                await favDelete(id);
                favoriteIdSet.delete(id);
                favoriteRecords = favoriteRecords.filter(r => r && r.id !== id);
                favoriteCount = favoriteRecords.length;
                updateFavCountBadge();
                updateSiteCollectButtonStates();
                if (isFavPanelOpen()) renderFavoritesList();
                scheduleOfflineSync();
                return { ok: true, action: 'removed' };
            }

            const record = buildFavoriteRecord(data);
            await favPut(record);
            cacheFavoriteAssets(record).catch(() => {});
            scheduleOfflineSync();
            favoriteIdSet.add(id);
            favoriteRecords.unshift(record);
            favoriteCount = favoriteRecords.length;
            updateFavCountBadge();
            updateSiteCollectButtonStates();
            if (isFavPanelOpen()) renderFavoritesList();
            return { ok: true, action: 'added' };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    /**
     * 旧版本可能把收藏写在了 t / space 子域的本地 IndexedDB。
     * 首次启动时把这些记录合并到 www 主库，之后所有子域共用同一份收藏。
     */
    async function migrateLocalFavorites() {
        if (SITE !== 'bilibili' || isCanonicalFavOrigin()) return;

        // 记录的是"上次已合并的本地 id 集合签名"，而不是布尔值：
        // 这样断网期间在子域新收藏的内容，恢复网络后还会再合并一次。
        const migrationKey = 'be-fav-bridge-migrated-v2';

        const local = await favGetAllLocal();
        if (!local.length) return;

        const signature = simpleHash(local.map(r => (r && r.id) || '').sort().join('|'));
        try {
            if (localStorage.getItem(migrationKey) === signature) return;
        } catch (_) { /* localStorage 不可用时不阻塞，重复合并按 id 幂等 */ }

        const canonical = await favGetAll();
        if (favBridgeFailed) return;

        const canonicalIds = new Set(canonical.map(r => r && r.id).filter(Boolean));
        for (const record of local) {
            if (record && record.id && !canonicalIds.has(record.id)) {
                await favPut(record);
                if (favBridgeFailed) return;
                cacheFavoriteAssets(record).catch(() => {});
            }
        }

        try { localStorage.setItem(migrationKey, signature); } catch (_) { /* ignore */ }
    }

    /** 初始化：从 IndexedDB / 跨域桥接读取收藏缓存 */
    async function initFavoriteState() {
        if (favoriteLoaded) return;
        await migrateLocalFavorites();
        await refreshFavoriteCache();
        // 数据库不可用时收藏列表会读成空，这里主动提示，避免用户以为收藏丢了
        openFavDb().catch((e) => {
            const msg = String((e && e.message) || e);
            if (/标签页/.test(msg)) showFavToast(msg);
        });

        // 恢复离线副本目录句柄：同一浏览器会话内权限仍有效时，收藏即可自动写盘。
        // 另外在页面加载后补一次静默同步，覆盖"在动态页收藏、主站副本过期"的情况：
        // 内容没变化时只做一次签名比对，不写盘。
        offlineDirRestore()
            .then(() => {
                updateOfflineSyncState();
                if (offlineDirHandle) scheduleOfflineSync(4000);
            })
            .catch(() => {});
    }

    /** 导出收藏到本地文件（优先 File System Access API，降级为下载） */
    async function exportFavorites() {
        const list = await favGetAll();
        if (!list.length) {
            showFavToast('暂无收藏可导出');
            return;
        }
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const prefix = SITE === 'youtube' ? 'youtube-favorites' : (SITE === 'x' ? 'x-favorites' : FAV_EXPORT_PREFIX);
        const filename = `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
        const json = JSON.stringify(list, null, 2);

        if (hasFsAccessApi()) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: FAV_EXPORT_TYPES,
                });
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                showFavToast('已导出 ' + handle.name);
                return;
            } catch (e) {
                // 用户取消或失败 → 回退到下载
                if (e && e.name === 'AbortError') return; // 用户主动取消，静默
            }
        }

        // 降级：触发浏览器下载
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showFavToast('已导出：' + filename);
    }

    // ── 离线快照 ──
    // 油猴脚本依赖网站页面，断网时站点本身打不开，脚本自然不会运行。
    // 因此这里把收藏导出成单文件 HTML：图片内联为 data URL，双击即可离线查看。

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    /** 取图片的内联数据（离线或防盗链失败时留空） */
    async function resolveAssetDataUrl(rawUrl) {
        const blob = await resolveAssetBlob(rawUrl);
        if (!blob) return '';
        try { return await blobToDataUrl(blob); } catch (_) { return ''; }
    }

    function offlineCardHtml(entry) {
        const { record, coverSrc, faceSrc } = entry;
        const isMedia = record.type === 'video' || record.type === 'post';
        const site = record.site || 'bilibili';
        const siteLabel = SITE_LABELS[site] || site;
        const kindLabel = isMedia ? (record.type === 'post' ? '推文' : '视频') : '评论';
        const uname = record.uname || '未知作者';
        const initial = escapeHtml(Array.from(uname)[0] || '?');
        const page = safeUrl(record.page) || safeUrl(normalizeRecordUrl(record));
        const published = record.ctime ? formatDateTime(record.ctime * 1000) : (record.time_text || '未知时间');
        const savedAt = formatRelativeTime(record.saved_at ? new Date(record.saved_at).getTime() : 0);
        const duration = formatVideoDuration(record.duration);
        const ipTag = record.ip ? `<span class="tag">IP ${escapeHtml(record.ip)}</span>` : '';
        const searchBlob = escapeHtml([
            uname, record.content || '', siteLabel, kindLabel, record.bvid || '', record.page || '',
        ].join(' ').toLowerCase());

        const avatar = faceSrc
            ? `<img class="avatar" src="${escapeHtml(faceSrc)}" alt="">`
            : `<span class="avatar avatar-fallback">${initial}</span>`;

        let media = '';
        if (isMedia) {
            const cover = coverSrc
                ? `<img class="cover" src="${escapeHtml(coverSrc)}" alt="">`
                : `<span class="cover cover-fallback">${FAV_ICONS.video}</span>`;
            media = `<div class="thumb">${cover}${duration ? `<span class="duration">${escapeHtml(duration)}</span>` : ''}</div>`;
        }

        // 媒体卡片用标题；评论卡片直接展示正文，避免同一段文字出现两次
        const title = escapeHtml(record.content || ('未命名' + kindLabel));
        const titleEl = !isMedia
            ? ''
            : (page
                ? `<a class="title" href="${escapeHtml(page)}">${title}</a>`
                : `<span class="title">${title}</span>`);
        const body = isMedia
            ? ''
            : `<p class="body">${escapeHtml(record.content || '（无文字内容）')}</p>`;
        const link = page
            ? `<a class="open" href="${escapeHtml(page)}">打开原${kindLabel} ${FAV_ICONS.open}</a>`
            : '';

        return `<article class="card${isMedia ? ' card-media' : ''}" data-search="${searchBlob}">
            <div class="card-head">${avatar}<div class="who"><span class="name">${escapeHtml(uname)}</span><div class="meta"><span class="tag">${escapeHtml(siteLabel)}</span><span class="tag">${kindLabel}</span>${ipTag}<span class="time">${escapeHtml(published)}</span></div></div></div>
            <div class="card-body">${media}<div class="text">${titleEl}${body}</div></div>
            <div class="card-foot"><span class="saved">收藏于 ${escapeHtml(savedAt)}</span>${link}</div>
        </article>`;
    }

    function offlinePageHtml(entries, exportedAt) {
        const cards = entries.map(offlineCardHtml).join('\n');
        const total = entries.length;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="comment-collector">
<meta name="exported-at" content="${escapeHtml(exportedAt)}">
<title>我的收藏 · 离线副本</title>
<style>
:root {
  color-scheme: light dark;
  --bg-a: #f5f6fa;
  --bg-b: #e9ebf3;
  --text: #16181d;
  --text-2: #4b515c;
  --text-3: #878d99;
  --card: rgba(255,255,255,.72);
  --card-border: rgba(255,255,255,.85);
  --divider: rgba(16,18,24,.08);
  --accent: #3b82f6;
  --accent-soft: rgba(59,130,246,.12);
  --shadow: rgba(16,18,24,.12);
  --bar: rgba(255,255,255,.7);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-a: #0e1117;
    --bg-b: #171b24;
    --text: #f2f4f7;
    --text-2: #c2c7d0;
    --text-3: #868d99;
    --card: rgba(30,35,45,.66);
    --card-border: rgba(255,255,255,.08);
    --divider: rgba(255,255,255,.09);
    --accent: #60a5fa;
    --accent-soft: rgba(96,165,250,.16);
    --shadow: rgba(0,0,0,.5);
    --bar: rgba(20,24,32,.72);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  padding: 0 0 64px;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: var(--text);
  background: linear-gradient(160deg, var(--bg-a), var(--bg-b));
  background-attachment: fixed;
  -webkit-font-smoothing: antialiased;
}
.bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px max(20px, calc((100vw - 880px) / 2));
  background: var(--bar);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid var(--divider);
}
.bar h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: .2px; }
.count {
  min-width: 22px; height: 22px; padding: 0 7px;
  border-radius: 11px; background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 700; line-height: 22px; text-align: center;
}
.search {
  margin-left: auto;
  width: min(240px, 40vw);
  height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--divider);
  background: var(--card);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color .2s ease, box-shadow .2s ease;
}
.search::placeholder { color: var(--text-3); }
.search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.list {
  padding: 20px max(20px, calc((100vw - 880px) / 2)) 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card {
  padding: 14px 16px;
  border: 1px solid var(--card-border);
  border-radius: 16px;
  background: var(--card);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  box-shadow: 0 6px 24px var(--shadow);
  transition: transform .2s ease, box-shadow .2s ease;
}
.card:hover { transform: translateY(-1px); box-shadow: 0 10px 32px var(--shadow); }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.avatar {
  width: 34px; height: 34px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 55%, #8b5cf6), var(--accent));
}
.avatar-fallback {
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 13px; font-weight: 700;
}
.who { min-width: 0; flex: 1; }
.name { display: block; font-size: 13px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 3px; font-size: 11px; color: var(--text-3); }
.tag {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-size: 10px; font-weight: 600;
}
.time { font-size: 11px; color: var(--text-3); }
.card-body { display: flex; gap: 12px; }
.card-media .card-body { align-items: center; }
.thumb {
  position: relative; flex-shrink: 0;
  width: 168px; aspect-ratio: 16 / 9;
  border-radius: 10px; overflow: hidden;
  background: color-mix(in srgb, var(--text-3) 18%, transparent);
}
.cover { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-fallback { display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.cover-fallback svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.duration {
  position: absolute; right: 6px; bottom: 6px;
  padding: 1px 5px; border-radius: 5px;
  background: rgba(0,0,0,.66); color: #fff; font-size: 11px; font-variant-numeric: tabular-nums;
}
.text { min-width: 0; flex: 1; }
.title {
  display: block; font-size: 13.5px; font-weight: 600; line-height: 1.5; color: var(--text);
  text-decoration: none; overflow-wrap: anywhere;
}
a.title:hover { color: var(--accent); }
.body { margin: 0; max-width: 78ch; font-size: 13px; line-height: 1.65; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.card-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--divider);
  font-size: 11px; color: var(--text-3);
}
.open { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; font-weight: 600; }
.open svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.empty { padding: 80px 20px; text-align: center; color: var(--text-3); }
@media (max-width: 620px) {
  .card-media .card-body { flex-direction: column; }
  .thumb { width: 100%; }
}
</style>
</head>
<body>
<header class="bar">
  <h1>我的收藏</h1>
  <span class="count" id="count">${total}</span>
  <input class="search" id="search" type="search" placeholder="搜索收藏…" autocomplete="off">
</header>
<main class="list" id="list">
${cards}
</main>
<script>
(function () {
  var input = document.getElementById('search');
  var cards = [].slice.call(document.querySelectorAll('.card'));
  var countEl = document.getElementById('count');
  var list = document.getElementById('list');
  var empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = '没有匹配的收藏';
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    var visible = 0;
    cards.forEach(function (card) {
      var hit = !q || (card.dataset.search || '').indexOf(q) > -1;
      card.style.display = hit ? '' : 'none';
      if (hit) visible += 1;
    });
    countEl.textContent = String(visible);
    if (!visible && !empty.parentNode) list.appendChild(empty);
    if (visible && empty.parentNode) empty.remove();
  });
})();
</script>
</body>
</html>`;
    }

    /** 导出离线快照：单文件 HTML，无网络也能完整查看收藏内容 */
    async function exportOfflineSnapshot() {
        const list = await favGetAll();
        if (!list.length) {
            showFavToast('暂无收藏可导出');
            return;
        }
        const sorted = list.slice().sort((a, b) => toTimestamp(b.saved_at) - toTimestamp(a.saved_at));
        const toast = showFavProgress('正在打包离线内容…');
        try {
            const entries = await buildOfflineEntries(sorted, resolveAssetDataUrl, (done, total) => {
                toast.update(`正在打包离线内容… ${done}/${total}`);
            });

            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            const prefix = SITE === 'youtube' ? 'youtube-favorites' : (SITE === 'x' ? 'x-favorites' : FAV_EXPORT_PREFIX);
            const filename = `${prefix}-offline-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.html`;
            const html = offlinePageHtml(entries, d.toISOString());

            let saved = false;
            if (hasFsAccessApi()) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: FAV_OFFLINE_TYPES,
                    });
                    const writable = await handle.createWritable();
                    await writable.write(html);
                    await writable.close();
                    saved = true;
                    toast.done('已导出离线页面：' + handle.name);
                } catch (e) {
                    if (e && e.name === 'AbortError') { toast.close(); return; }
                }
            }
            if (!saved) {
                const blob = new Blob([html], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                toast.done('已导出离线页面：' + filename);
            }
        } catch (e) {
            toast.close();
            showFavToast('导出失败：' + ((e && e.message) || e));
        }
    }

    /** 收藏管理面板（查看 / 搜索 / 打开 / 删除） */
    function ensureFavPanel() {
        if (favPanelEl) return favPanelEl;
        const overlay = document.createElement('dialog');
        overlay.id = 'be-fav-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('aria-labelledby', 'be-fav-title-text');
        setHtml(overlay, `
            <div id="be-fav-panel">
                <div class="be-fav-header">
                    <div class="be-fav-heading">
                        <span class="be-fav-heading-icon" aria-hidden="true">${FAV_ICONS.bookmark}</span>
                        <div>
                            <h2 class="be-fav-title" id="be-fav-title-text">我的收藏</h2>
                        </div>
                        <span class="be-fav-count-pill" id="be-fav-count-pill">0</span>
                        <span class="be-fav-offline-pill" id="be-fav-offline-pill" title="当前离线，收藏内容来自本地缓存" hidden>离线</span>
                    </div>
                    <div class="be-fav-header-actions">
                        <button type="button" class="be-icon-btn" id="be-fav-offline" title="导出离线页面（无网络也能查看）" aria-label="导出离线页面">${FAV_ICONS.offline}</button>
                        <button type="button" class="be-icon-btn" id="be-fav-export" title="导出 JSON 备份" aria-label="导出 JSON 备份">${FAV_ICONS.download}</button>
                        <button type="button" class="be-icon-btn" id="be-fav-close" title="关闭" aria-label="关闭">${FAV_ICONS.close}</button>
                    </div>
                </div>
                <div class="be-fav-toolbar">
                    <div class="be-fav-search">
                        ${FAV_ICONS.search}
                        <input type="search" id="be-fav-search" placeholder="搜索视频或评论" autocomplete="off" />
                    </div>
                </div>
                <div id="be-fav-list" class="be-fav-list"></div>
                <div class="be-offline-menu" id="be-offline-menu" role="menu" hidden></div>
            </div>`);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeFavPanel();
        });
        overlay.querySelector('#be-fav-close').addEventListener('click', closeFavPanel);
        overlay.querySelector('#be-fav-export').addEventListener('click', () => {
            exportFavorites().catch(e => showFavToast('导出失败：' + ((e && e.message) || e)));
        });
        overlay.querySelector('#be-fav-offline').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleOfflineMenu();
        });
        overlay.querySelector('#be-offline-menu').addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target instanceof Element ? e.target.closest('.be-offline-item') : null;
            if (!item) return;
            runOfflineAction(item.getAttribute('data-action'))
                .catch(err => showFavToast('离线副本失败：' + ((err && err.message) || err)));
        });
        overlay.addEventListener('click', (e) => {
            const menu = document.getElementById('be-offline-menu');
            if (!menu || menu.hasAttribute('hidden')) return;
            if (e.target instanceof Element && e.target.closest('#be-offline-menu')) return;
            toggleOfflineMenu(false);
        });
        const searchInput = overlay.querySelector('#be-fav-search');
        searchInput.addEventListener('input', () => {
            favSearchQuery = searchInput.value;
            renderFavoritesList();
        });

        overlay.querySelector('#be-fav-list').addEventListener('click', (e) => {
            const del = e.target instanceof Element ? e.target.closest('.be-fav-del') : null;
            if (!del) return;
            e.preventDefault();
            removeFavorite(del.getAttribute('data-id'));
        });

        overlay.addEventListener('close', cleanupFavPanel);
        overlay.addEventListener('cancel', (e) => {
            // 交给浏览器原生关闭流程，close 事件里统一做清理
            e.preventDefault();
            closeFavPanel();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const menu = document.getElementById('be-offline-menu');
            if (menu && !menu.hasAttribute('hidden')) {
                e.preventDefault();
                toggleOfflineMenu(false);
                return;
            }
            if (isFavPanelOpen()) closeFavPanel();
        });

        updateFavOfflineIndicator();
        favPanelEl = overlay;
        return overlay;
    }

    async function openFavoritesPanel() {
        const overlay = ensureFavPanel();
        favPanelOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        lockFavPageScroll();
        overlay.setAttribute('aria-hidden', 'false');

        // 使用原生 <dialog>.showModal() 进入 top layer，
        // 避免 B 站 html 上的 transform 让 fixed 定位以整页高度为参照。
        if (typeof overlay.showModal === 'function') {
            if (!overlay.open) overlay.showModal();
        } else {
            overlay.setAttribute('open', '');
            overlay.style.display = 'flex';
        }

        const fabWrap = document.getElementById('be-fab-wrap');
        if (fabWrap) fabWrap.classList.add('be-favorites-open');

        updateFavOfflineIndicator();
        updateOfflineSyncState();
        offlineDirRestore().then(() => {
            updateOfflineSyncState();
            // 同会话内权限仍有效时静默补齐，保证本地副本不过期
            if (offlineDirHandle) syncOfflineBundle({ toast: false }).catch(() => {});
        }).catch(() => {});

        if (!favoriteLoaded) {
            const listEl = overlay.querySelector('#be-fav-list');
            setHtml(listEl, '<div class="be-fav-empty"><div class="be-fav-empty-title">正在加载收藏…</div></div>');
        }

        await refreshFavoriteCache();
        await hydrateFavoriteAssets(favoriteRecords);
        renderFavoritesList();
        backfillFavoriteAssets(favoriteRecords)
            .then(() => { if (isFavPanelOpen()) renderFavoritesList(); })
            .catch(() => {});
        setTimeout(() => {
            if (!isFavPanelOpen()) return;
            const search = overlay.querySelector('#be-fav-search');
            if (search) search.focus({ preventScroll: true });
        }, 80);
    }

    function cleanupFavPanel() {
        const overlay = document.getElementById('be-fav-overlay');
        if (!overlay) return;
        toggleOfflineMenu(false);
        overlay.setAttribute('aria-hidden', 'true');
        unlockFavPageScroll();
        const fabWrap = document.getElementById('be-fab-wrap');
        if (fabWrap) fabWrap.classList.remove('be-favorites-open');

        favSearchQuery = '';
        const search = overlay.querySelector('#be-fav-search');
        if (search) search.value = '';

        if (favPanelOpener && typeof favPanelOpener.focus === 'function') {
            favPanelOpener.focus({ preventScroll: true });
        }
        favPanelOpener = null;
    }

    function closeFavPanel() {
        const overlay = document.getElementById('be-fav-overlay');
        if (!overlay) return;
        if (typeof overlay.close === 'function' && overlay.open) {
            overlay.close(); // 触发 close 事件 → cleanupFavPanel
        } else {
            overlay.removeAttribute('open');
            overlay.style.display = 'none';
            cleanupFavPanel();
        }
    }

    function renderVideoFavoriteItem(record) {
        const id = escapeHtml(record.id || '');
        const site = record.site || 'bilibili';
        const siteLabel = SITE_LABELS[site] || site;
        const isPost = record.type === 'post';
        const kindLabel = isPost ? '推文' : '视频';
        const authorLabel = site === 'bilibili' ? 'UP 主' : (site === 'youtube' ? '频道' : '作者');
        const title = record.content || ('未命名' + kindLabel);
        const uname = record.uname || ('未知' + authorLabel);
        const page = safeUrl(record.page);
        const cover = cachedAssetSrc(record.cover);
        const coverFallback = record.cover_fallback ? cachedAssetSrc(record.cover_fallback) : '';
        const duration = formatVideoDuration(record.duration);
        const publishedAt = record.ctime ? formatDateTime(record.ctime * 1000) : (record.time_text || '未知时间');
        const savedAt = formatRelativeTime(record.saved_at ? new Date(record.saved_at).getTime() : 0);
        const showThumb = !!cover || !isPost;
        const fallbackAttr = coverFallback ? ` data-fallback="${escapeHtml(coverFallback)}"` : '';
        const thumbInner = cover
            ? `<img class="be-fav-video-cover-img" src="${escapeHtml(cover)}"${fallbackAttr} alt="" loading="lazy" referrerpolicy="no-referrer"><span class="be-fav-video-cover-fallback" style="display:none">${FAV_ICONS.video}</span>`
            : `<span class="be-fav-video-cover-fallback">${FAV_ICONS.video}</span>`;
        const durationTag = duration ? `<span class="be-fav-video-duration">${escapeHtml(duration)}</span>` : '';
        const thumb = showThumb
            ? (page
                ? `<a class="be-fav-video-thumb" href="${escapeHtml(page)}" target="_blank" rel="noopener noreferrer" aria-label="打开${kindLabel}">${thumbInner}${durationTag}</a>`
                : `<div class="be-fav-video-thumb">${thumbInner}${durationTag}</div>`)
            : '';
        const itemClass = 'be-fav-item be-fav-video-item' + (isPost && !cover ? ' be-fav-video-item--text' : '');
        const titleEl = page
            ? `<a class="be-fav-video-title" href="${escapeHtml(page)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
            : `<span class="be-fav-video-title">${escapeHtml(title)}</span>`;
        const openLink = page
            ? `<a class="be-fav-original-link" href="${escapeHtml(page)}" target="_blank" rel="noopener noreferrer">打开${kindLabel} ${FAV_ICONS.open}</a>`
            : '';

        return `<article class="${itemClass}" data-id="${id}">
            <div class="be-fav-video-main">
                ${thumb}
                <div class="be-fav-video-info">
                    ${titleEl}
                    <span class="be-fav-video-uploader" title="${escapeHtml(uname)}">${authorLabel}：${escapeHtml(uname)}</span>
                    <div class="be-fav-video-meta">
                        <span class="be-fav-tag">${escapeHtml(siteLabel)}</span>
                        <span class="be-fav-tag">${kindLabel}</span>
                        <span>发布于 ${escapeHtml(publishedAt)}</span>
                    </div>
                </div>
                <button type="button" class="be-fav-del" data-id="${id}" title="删除收藏" aria-label="删除收藏">${FAV_ICONS.trash}</button>
            </div>
            <div class="be-fav-item-foot">
                <span class="be-fav-saved">收藏于 ${escapeHtml(savedAt)}</span>
                ${openLink}
            </div>
        </article>`;
    }

    function renderFavoriteItem(record) {
        if (record && (record.type === 'video' || record.type === 'post')) return renderVideoFavoriteItem(record);
        const id = escapeHtml(record.id || '');
        const site = record.site || 'bilibili';
        const siteLabel = SITE_LABELS[site] || site;
        const uname = record.uname || '匿名用户';
        const initial = escapeHtml(Array.from(uname)[0] || '?');
        const content = escapeHtml(record.content || '（无文字内容）');
        const avatarUrl = record.face ? cachedAssetSrc(record.face) : '';
        const ctime = record.ctime ? formatDateTime(record.ctime * 1000) : (record.time_text || '未知时间');
        const savedAt = formatRelativeTime(record.saved_at ? new Date(record.saved_at).getTime() : 0);
        const page = safeUrl(normalizeRecordUrl(record));
        const siteTag = `<span class="be-fav-tag">${escapeHtml(siteLabel)}</span>`;
        const ipTag = record.ip ? `<span class="be-fav-tag">IP ${escapeHtml(record.ip)}</span>` : '';
        const avatar = avatarUrl
            ? `<img class="be-fav-avatar be-fav-avatar-img" src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="be-fav-avatar be-fav-avatar-fallback" style="display:none">${initial}</span>`
            : `<span class="be-fav-avatar be-fav-avatar-fallback">${initial}</span>`;
        const openLink = page
            ? `<a class="be-fav-original-link" href="${escapeHtml(page)}" target="_blank" rel="noopener noreferrer">打开原评论 ${FAV_ICONS.open}</a>`
            : '';

        return `<article class="be-fav-item" data-id="${id}">
            <div class="be-fav-item-head">
                <div class="be-fav-avatar-wrap">${avatar}</div>
                <div class="be-fav-item-info">
                    <span class="be-fav-uname" title="${escapeHtml(uname)}">${escapeHtml(uname)}</span>
                    <div class="be-fav-meta">
                        ${siteTag}
                        <span>评论于 ${escapeHtml(ctime)}</span>
                        ${ipTag}
                    </div>
                </div>
                <button type="button" class="be-fav-del" data-id="${id}" title="删除收藏" aria-label="删除收藏">${FAV_ICONS.trash}</button>
            </div>
            <p class="be-fav-item-content">${content}</p>
            <div class="be-fav-item-foot">
                <span class="be-fav-saved">收藏于 ${escapeHtml(savedAt)}</span>
                ${openLink}
            </div>
        </article>`;
    }

    function renderFavoritesList() {
        const overlay = ensureFavPanel();
        const listEl = overlay.querySelector('#be-fav-list');
        const countPill = overlay.querySelector('#be-fav-count-pill');
        const query = favSearchQuery.trim().toLowerCase();
        const filtered = query
            ? favoriteRecords.filter(r => `${r.uname || ''}\n${r.content || ''}\n${r.bvid || ''}\n${r.page || ''}\n${r.site || ''}`.toLowerCase().includes(query))
            : favoriteRecords;

        countPill.textContent = String(favoriteCount);

        if (!favoriteRecords.length) {
            setHtml(listEl, `
                <div class="be-fav-empty">
                    <div class="be-fav-empty-icon" aria-hidden="true">${FAV_ICONS.bookmark}</div>
                    <div class="be-fav-empty-title">还没有收藏</div>
                    <div class="be-fav-empty-desc">点击评论书签，或在视频页收藏当前视频</div>
                </div>`);
            return;
        }

        if (!filtered.length) {
            setHtml(listEl, `
                <div class="be-fav-empty">
                    <div class="be-fav-empty-icon" aria-hidden="true">${FAV_ICONS.search}</div>
                    <div class="be-fav-empty-title">没有匹配的收藏</div>
                </div>`);
            return;
        }

        setHtml(listEl, filtered.map(renderFavoriteItem).join(''));
        listEl.querySelectorAll('.be-fav-avatar-img').forEach(img => {
            img.addEventListener('error', () => {
                img.style.display = 'none';
                const fallback = img.nextElementSibling;
                if (fallback) fallback.style.display = 'flex';
            }, { once: true });
        });
        listEl.querySelectorAll('.be-fav-video-cover-img').forEach(img => {
            img.addEventListener('error', function onCoverError() {
                const fallbackUrl = img.getAttribute('data-fallback');
                if (fallbackUrl && img.getAttribute('src') !== fallbackUrl) {
                    img.removeAttribute('data-fallback');
                    img.setAttribute('src', fallbackUrl);
                    return;
                }
                img.removeEventListener('error', onCoverError);
                img.style.display = 'none';
                const fallback = img.nextElementSibling;
                if (fallback) fallback.style.display = 'flex';
            });
        });
    }

    async function removeFavorite(id) {
        if (!id) return;
        try {
            await favDelete(id);
            favoriteIdSet.delete(id);
            favoriteRecords = favoriteRecords.filter(r => r && r.id !== id);
            favoriteCount = favoriteRecords.length;
            updateFavCountBadge();
            updateVideoFavoriteMenuItem();
            renderFavoritesList();
            scheduleOfflineSync();
            showFavToast('已删除收藏');
        } catch (e) {
            showFavToast('删除失败：' + ((e && e.message) || e));
        }
    }

    /** 设置收藏按钮的已收藏视觉状态 */
    function setFavButtonState(btn, faved) {
        const svg = btn.querySelector('svg');
        const idleColor = isDarkTheme() ? '#aeb3bb' : '#9499a0';
        const color = faved ? '#f6c344' : idleColor;
        btn.classList.toggle('be-faved', faved);
        btn.title = faved ? '取消收藏' : '收藏评论';
        if (svg) {
            svg.style.stroke = color;
            svg.style.fill = faved ? color : 'none';
        }
        btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
    }

    /** 轻量提示条 */
    function ensureFavToastEl() {
        let el = document.getElementById('be-fav-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'be-fav-toast';
            document.body.appendChild(el);
        }
        return el;
    }

    function showFavToast(msg) {
        const el = ensureFavToastEl();
        el.textContent = msg;
        el.classList.add('be-show');
        clearTimeout(el._t);
        // 需要用户动手处理的提示（关标签页 / 重新授权等）多留一会儿
        const text = String(msg == null ? '' : msg);
        const duration = /标签页|占用|权限/.test(text) ? 6000 : 2200;
        el._t = setTimeout(() => el.classList.remove('be-show'), duration);
    }

    /** 带进度的常驻提示（长任务用，如打包离线页面） */
    function showFavProgress(initial) {
        const el = ensureFavToastEl();
        clearTimeout(el._t);
        el.textContent = initial || '';
        el.classList.add('be-show');
        const finish = (msg) => {
            el.textContent = msg;
            el.classList.add('be-show');
            clearTimeout(el._t);
            el._t = setTimeout(() => el.classList.remove('be-show'), 2600);
        };
        return {
            update(msg) { el.textContent = msg; el.classList.add('be-show'); },
            done: finish,
            close() { clearTimeout(el._t); el.classList.remove('be-show'); },
        };
    }

    function addFavoriteButton(root, data, replyControlRoot) {
        if (!settings.enableFavorite) return;
        if (!data.mid) return;
        if (replyControlRoot.querySelector('.be-fav-btn')) return;
        if (!replyControlRoot.children || replyControlRoot.children.length === 0) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'be-fav-btn';
        btn.setAttribute('data-rpid', commentUniqueId(data));
        btn.setAttribute('aria-label', '收藏评论');
        setHtml(btn,
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' +
            '</svg>');

        const s = btn.style;
        s.display = 'var(--be-show-fav, inline-flex)';
        s.alignItems = 'center';
        s.justifyContent = 'center';
        s.height = '22px';
        s.width = '22px';
        s.padding = '0';
        s.marginRight = '6px';
        s.marginLeft = '2px';
        s.border = 'none';
        s.borderRadius = '6px';
        s.background = 'transparent';
        s.cursor = 'pointer';
        s.flexShrink = '0';
        s.verticalAlign = 'middle';
        s.transition = 'background .2s ease';

        const svg = btn.querySelector('svg');
        if (svg) {
            svg.style.width = '14px';
            svg.style.height = '14px';
            svg.style.fill = 'none';
            svg.style.stroke = isDarkTheme() ? '#aeb3bb' : '#9499a0';
            svg.style.strokeWidth = '1.8';
            svg.style.strokeLinecap = 'round';
            svg.style.strokeLinejoin = 'round';
            svg.style.transition = 'stroke .2s ease, fill .2s ease';
        }

        setFavButtonState(btn, favoriteIdSet.has(commentUniqueId(data)));

        btn.addEventListener('mouseenter', () => {
            const c = btn.classList.contains('be-faved') ? '#f6c344' : '#ffb300';
            btn.style.background = isDarkTheme() ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)';
            if (svg) svg.style.stroke = c;
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'transparent';
            setFavButtonState(btn, btn.classList.contains('be-faved'));
        });

        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                const res = await toggleFavorite(data);
                if (res.ok) {
                    setFavButtonState(btn, res.action === 'added');
                    showFavToast(res.action === 'added' ? '已收藏' : '已取消收藏');
                } else if (res.error === 'no-file') {
                    showFavToast('此浏览器不支持文件系统保存');
                } else {
                    showFavToast('收藏失败：' + res.error);
                }
            } catch (err) {
                showFavToast('收藏失败：' + ((err && err.message) || err));
            } finally {
                btn.disabled = false;
            }
        });

        // 插入：放在点赞按钮之前，或追加到操作栏末尾
        if (replyControlRoot.children.like) {
            replyControlRoot.insertBefore(btn, replyControlRoot.children.like);
        } else {
            replyControlRoot.appendChild(btn);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 8.6: 多站点采集适配（B站 / YouTube / X）
    // ═══════════════════════════════════════════════════════════════

    const COLLECT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V21l-6-4-6 4z"/></svg>';

    function simpleHash(input) {
        let hash = 0;
        const text = String(input || '');
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
    }

    function siteCollectLabel(site) {
        return site === 'x' ? '收藏当前推文' : '收藏当前视频';
    }

    function siteCollectDoneLabel(site) {
        return site === 'x' ? '取消收藏推文' : '取消收藏视频';
    }

    function setSiteCollectButtonState(btn, faved) {
        if (!btn) return;
        btn.classList.toggle('be-collected', faved);
        btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
        const label = btn.querySelector('.be-site-collect-label');
        if (label) {
            const site = btn.getAttribute('data-site') || SITE;
            label.textContent = faved ? '已收藏' : '临时收藏';
            btn.title = faved ? siteCollectDoneLabel(site) : siteCollectLabel(site);
        } else {
            const site = btn.getAttribute('data-site') || SITE;
            btn.title = faved ? siteCollectDoneLabel(site) : siteCollectLabel(site);
        }
    }

    function updateSiteCollectButtonStates() {
        document.querySelectorAll('.be-site-collect').forEach(btn => {
            const id = btn.getAttribute('data-record-id');
            if (id) setSiteCollectButtonState(btn, favoriteIdSet.has(id));
        });
        updatePrimaryFavoriteMenuItem();
    }

    /** 「评论收藏」开关：控制 YouTube/X 评论采集按钮的显隐 */
    function applySiteCollectVisibility() {
        const enabled = settings.enableFavorite;
        document.querySelectorAll('.be-yt-comment-collect, .be-x-collect').forEach(btn => {
            btn.style.display = enabled ? '' : 'none';
        });
    }

    // ── 统一记录读写 ──

    async function toggleRecordById(record) {
        if (!record || !record.id) return { ok: false, error: 'invalid-record' };
        if (!favoriteLoaded) await initFavoriteState();

        try {
            if (favoriteIdSet.has(record.id)) {
                await favDelete(record.id);
                favoriteIdSet.delete(record.id);
                favoriteRecords = favoriteRecords.filter(r => r && r.id !== record.id);
                favoriteCount = favoriteRecords.length;
                updateFavCountBadge();
                updateSiteCollectButtonStates();
                if (isFavPanelOpen()) renderFavoritesList();
                scheduleOfflineSync();
                return { ok: true, action: 'removed' };
            }

            await favPut(record);
            cacheFavoriteAssets(record).catch(() => {});
            scheduleOfflineSync();
            favoriteIdSet.add(record.id);
            favoriteRecords = favoriteRecords.filter(r => r && r.id !== record.id);
            favoriteRecords.unshift(record);
            favoriteCount = favoriteRecords.length;
            updateFavCountBadge();
            updateSiteCollectButtonStates();
            if (isFavPanelOpen()) renderFavoritesList();
            return { ok: true, action: 'added' };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    // ── 当前页主内容（视频 / 推文） ──

    function getCurrentPrimaryRef() {
        if (SITE === 'bilibili') {
            const ref = getCurrentVideoRef();
            return ref ? { id: videoFavoriteId(ref), site: 'bilibili', type: 'video', ref } : null;
        }
        if (SITE === 'youtube') {
            const ref = getYoutubePrimaryRef();
            return ref ? { id: ref.id, site: 'youtube', type: 'video', ref } : null;
        }
        if (SITE === 'x') {
            const ref = getXPrimaryRef();
            // getXPrimaryRef 返回 { id, statusId, ref: article }，这里要取内层的 article，
            // 否则 extractXTweetRecord 会拿到普通对象并抛错。
            return ref ? { id: ref.id, site: 'x', type: 'post', ref: ref.ref } : null;
        }
        return null;
    }

    async function buildPrimaryRecord(primary) {
        if (!primary) return null;
        if (primary.site === 'bilibili') return buildVideoFavoriteRecord(primary.ref);
        if (primary.site === 'youtube') return buildYoutubeRecord(primary.ref);
        if (primary.site === 'x') return extractXTweetRecord(primary.ref);
        return null;
    }

    async function togglePrimaryFavorite() {
        const primary = getCurrentPrimaryRef();
        if (!primary) return { ok: false, error: 'not-collectable' };
        if (!favoriteLoaded) await initFavoriteState();
        if (favoriteIdSet.has(primary.id)) {
            return toggleRecordById({ id: primary.id });
        }
        if (primary.site === 'bilibili') showFavToast('正在收藏视频…');
        const record = await buildPrimaryRecord(primary);
        if (!record) return { ok: false, error: 'not-collectable' };
        return toggleRecordById(record);
    }

    function updatePrimaryFavoriteMenuItem() {
        const btn = document.getElementById('be-fab-video-fav');
        if (!btn) return;
        const primary = getCurrentPrimaryRef();
        if (!primary) {
            btn.hidden = true;
            return;
        }
        const faved = favoriteIdSet.has(primary.id);
        btn.hidden = false;
        btn.classList.toggle('be-faved', faved);
        btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
        btn.title = faved ? siteCollectDoneLabel(primary.site) : siteCollectLabel(primary.site);
        const label = btn.querySelector('span');
        if (label) label.textContent = faved ? siteCollectDoneLabel(primary.site) : siteCollectLabel(primary.site);
    }

    // ── B 站视频工具栏按钮 ──

    function findBilibiliToolbar() {
        return document.querySelector('.video-toolbar-left') ||
            document.querySelector('.arc_toolbar_report') ||
            document.querySelector('.video-toolbar');
    }

    function ensureBilibiliVideoCollectButton() {
        const ref = getCurrentVideoRef();
        if (!ref) return;
        const toolbar = findBilibiliToolbar();
        if (!toolbar) return;

        let btn = document.getElementById('be-bili-video-collect');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'be-bili-video-collect';
            btn.className = 'be-site-collect';
            btn.setAttribute('data-site', 'bilibili');
            setHtml(btn, COLLECT_ICON + '<span class="be-site-collect-label">临时收藏</span>');
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (btn.disabled) return;
                btn.disabled = true;
                try {
                    const res = await togglePrimaryFavorite();
                    updateSiteCollectButtonStates();
                    if (res.ok) showFavToast(res.action === 'added' ? '已收藏' : '已取消收藏');
                    else showFavToast('收藏失败：' + res.error);
                } catch (err) {
                    showFavToast('收藏失败：' + ((err && err.message) || err));
                } finally {
                    btn.disabled = false;
                }
            });

            const share = toolbar.querySelector('.share, .share-btn-outer') ||
                [...toolbar.querySelectorAll('.video-toolbar-left-item, .tool-item, [class*="tool"]')]
                    .find(el => (el.textContent || '').includes('分享'));
            if (share && share.parentElement) share.insertAdjacentElement('afterend', btn);
            else toolbar.appendChild(btn);
        }

        btn.setAttribute('data-record-id', videoFavoriteId(ref));
        setSiteCollectButtonState(btn, favoriteIdSet.has(videoFavoriteId(ref)));
    }

    // ── YouTube ──

    function getYoutubeVideoId() {
        try {
            const url = new URL(location.href);
            if (url.pathname === '/watch') return url.searchParams.get('v');
            const shorts = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
            return shorts ? shorts[1] : null;
        } catch (_) {
            return null;
        }
    }

    function getYoutubePrimaryRef() {
        const videoId = getYoutubeVideoId();
        if (!videoId) return null;
        return { id: 'yt:' + videoId, videoId, site: 'youtube', type: 'video' };
    }

    function parseYoutubeDuration() {
        const text = document.querySelector('.ytp-time-duration')?.textContent?.trim();
        if (!text) return null;
        const parts = text.split(':').map(Number);
        if (parts.some(n => isNaN(n))) return null;
        return parts.reduce((acc, n) => acc * 60 + n, 0);
    }

    function youtubeThumbScore(url) {
        if (!url || /no_thumbnail/i.test(url) || /(?:^|\/)default\.jpg/i.test(url)) return -1;
        if (/maxresdefault/i.test(url)) return 5;
        if (/sddefault/i.test(url)) return 4;
        if (/hq720/i.test(url)) return 3;
        if (/hqdefault/i.test(url)) return 2;
        if (/mqdefault/i.test(url)) return 1;
        return 0;
    }

    /** 优先取页面里的高清封面；没有则用 maxres/shorts 高分辨率地址 */
    function getYoutubeCover(videoId) {
        const candidates = [
            document.querySelector('meta[property="og:image"]')?.content,
            document.querySelector('link[rel="image_src"]')?.href,
            document.querySelector('ytd-watch-metadata #thumbnail img')?.src,
            document.querySelector('ytd-thumbnail img')?.src,
            document.querySelector('#movie_player video')?.poster,
        ].filter(Boolean);

        let best = null;
        let bestScore = -1;
        for (const url of candidates) {
            const score = youtubeThumbScore(url);
            if (score > bestScore) {
                best = url;
                bestScore = score;
            }
        }
        if (best && bestScore >= 0) return best;

        const isShorts = location.pathname.startsWith('/shorts/');
        return isShorts
            ? `https://i.ytimg.com/vi/${videoId}/hq720_2.jpg`
            : `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    }

    function buildYoutubeRecord(ref) {
        const videoId = ref.videoId;
        const title = (document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent ||
            document.querySelector('meta[name="title"]')?.content ||
            document.title.replace(/\s*-\s*YouTube$/, '') || '').trim();
        const owner = (document.querySelector('#owner #channel-name a')?.textContent ||
            document.querySelector('ytd-channel-name a')?.textContent || '').trim();
        const avatar = document.querySelector('#owner #avatar img')?.src || null;
        const isShorts = location.pathname.startsWith('/shorts/');
        const cover = getYoutubeCover(videoId);
        const coverFallback = isShorts
            ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        return {
            id: ref.id,
            type: 'video',
            site: 'youtube',
            mid: null,
            uname: owner || 'YouTube',
            face: avatar,
            content: title || videoId,
            ctime: null,
            ip: null,
            fans: null,
            page: 'https://www.youtube.com/watch?v=' + videoId,
            cover,
            cover_fallback: coverFallback,
            duration: parseYoutubeDuration(),
            saved_at: new Date().toISOString(),
        };
    }

    function findYoutubeActionBar() {
        return document.querySelector('#top-level-buttons-computed') ||
            document.querySelector('#actions-inner #top-level-buttons-computed') ||
            document.querySelector('#actions-inner') ||
            document.querySelector('#actions');
    }

    function ensureYoutubeCollectButton() {
        const ref = getYoutubePrimaryRef();
        if (!ref) return;
        const bar = findYoutubeActionBar();
        if (!bar) return;

        let btn = document.getElementById('be-yt-primary-collect');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'be-yt-primary-collect';
            btn.className = 'be-site-collect be-yt-collect';
            btn.setAttribute('data-site', 'youtube');
            setHtml(btn, COLLECT_ICON + '<span class="be-site-collect-label">临时收藏</span>');
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (btn.disabled) return;
                btn.disabled = true;
                try {
                    const res = await togglePrimaryFavorite();
                    updateSiteCollectButtonStates();
                    if (res.ok) showFavToast(res.action === 'added' ? '已收藏' : '已取消收藏');
                    else showFavToast('收藏失败：' + res.error);
                } catch (err) {
                    showFavToast('收藏失败：' + ((err && err.message) || err));
                } finally {
                    btn.disabled = false;
                }
            });
            bar.appendChild(btn);
        }

        btn.setAttribute('data-record-id', ref.id);
        setSiteCollectButtonState(btn, favoriteIdSet.has(ref.id));
    }

    function extractYoutubeComment(el) {
        const author = (el.querySelector('#author-text')?.textContent || '').trim();
        const content = (el.querySelector('#content-text')?.textContent || '').trim();
        const timeText = (el.querySelector('#published-time-text')?.textContent || '').trim();
        const permalinkEl = el.querySelector('#published-time-text a[href*="lc="]') ||
            el.querySelector('a[href*="lc="]');
        const permalink = permalinkEl ? new URL(permalinkEl.getAttribute('href'), location.origin).href : location.href;
        let commentId = '';
        try {
            commentId = new URL(permalink).searchParams.get('lc') || '';
        } catch (_) { /* ignore */ }
        if (!commentId) commentId = simpleHash(author + content + timeText);
        return {
            id: 'ytc:' + commentId,
            type: 'comment',
            site: 'youtube',
            mid: null,
            uname: author || 'YouTube 用户',
            face: el.querySelector('#author-thumbnail img')?.src || null,
            content,
            ctime: null,
            time_text: timeText || null,
            ip: null,
            fans: null,
            page: permalink,
            saved_at: new Date().toISOString(),
        };
    }

    function ensureYoutubeCommentButton(el) {
        if (!settings.enableFavorite) return;
        const actionBar = el.querySelector('#action-menu') ||
            el.querySelector('ytd-comment-actions') ||
            el.querySelector('#toolbar');
        if (!actionBar) return;
        if (el.querySelector('.be-yt-comment-collect')) return;

        const record = extractYoutubeComment(el);
        if (!record.content && !record.uname) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'be-site-collect be-yt-comment-collect';
        btn.setAttribute('data-site', 'youtube');
        btn.setAttribute('data-record-id', record.id);
        setHtml(btn, COLLECT_ICON);
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                const res = await toggleRecordById(extractYoutubeComment(el));
                updateSiteCollectButtonStates();
                if (res.ok) showFavToast(res.action === 'added' ? '已收藏评论' : '已取消收藏评论');
                else showFavToast('评论收藏失败：' + res.error);
            } catch (err) {
                showFavToast('评论收藏失败：' + ((err && err.message) || err));
            } finally {
                btn.disabled = false;
            }
        });

        const reply = actionBar.querySelector('#reply-button-end, ytd-button-renderer#reply-button-end, #reply-button');
        if (reply && reply.parentElement) reply.insertAdjacentElement('beforebegin', btn);
        else actionBar.appendChild(btn);
        setSiteCollectButtonState(btn, favoriteIdSet.has(record.id));
    }

    function scanYoutubeContent() {
        ensureYoutubeCollectButton();
        document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-reply-renderer').forEach(ensureYoutubeCommentButton);
        updatePrimaryFavoriteMenuItem();
    }

    // ── X / Twitter ──

    /** 只在当前 tweet 自己的 DOM 内查找，避免命中引用推文的媒体 / 链接 */
    function findOwnedElement(article, selector) {
        if (!article) return null;
        const els = article.querySelectorAll(selector);
        for (const el of els) {
            if (el.closest('article[data-testid="tweet"]') === article) return el;
        }
        return null;
    }

    function getXTweetId(article) {
        if (!article) return null;
        const timeLink = findOwnedElement(article, 'time')?.closest('a[href*="/status/"]');
        const link = timeLink || findOwnedElement(article, 'a[href*="/status/"]');
        const match = link?.getAttribute('href')?.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
    }

    function extractXTweetRecord(article) {
        const statusId = getXTweetId(article);
        if (!statusId) return null;

        const textEl = findOwnedElement(article, '[data-testid="tweetText"]');
        const content = (textEl?.innerText || '').trim();
        const userNameEl = findOwnedElement(article, '[data-testid="User-Name"]');
        const uname = (userNameEl?.innerText || '').replace(/\n+/g, ' ').trim();
        const avatar = findOwnedElement(article, '[data-testid="Tweet-User-Avatar"] img')?.src || null;

        // 只使用当前推文自己的媒体，避免引用推文的视频/图片串到封面
        const video = findOwnedElement(article, '[data-testid="videoPlayer"] video, [data-testid="videoComponent"] video');
        const photo = findOwnedElement(article, '[data-testid="tweetPhoto"] img');
        const cover = video?.poster || photo?.src || null;

        const timeEl = findOwnedElement(article, 'time');
        const datetime = timeEl?.getAttribute('datetime');
        const ctime = datetime ? Math.floor(new Date(datetime).getTime() / 1000) : null;
        const timeLink = timeEl?.closest('a[href*="/status/"]');
        const permalink = timeLink?.href ||
            findOwnedElement(article, `a[href*="/status/${statusId}"]`)?.href ||
            ('https://x.com/i/status/' + statusId);

        return {
            id: 'x:' + statusId,
            type: 'post',
            site: 'x',
            mid: null,
            uname: uname || 'X 用户',
            face: avatar,
            content: content || '（无文字内容）',
            ctime: isNaN(ctime) ? null : ctime,
            time_text: null,
            ip: null,
            fans: null,
            page: permalink,
            cover,
            duration: null,
            saved_at: new Date().toISOString(),
        };
    }

    function getXPrimaryRef() {
        const match = location.pathname.match(/\/status\/(\d+)/);
        if (!match) return null;
        const statusId = match[1];
        // 详情页会同时渲染"被回复的上下文推文"，DOM 里的第一个 article 未必是当前这条，
        // 因此以 URL 的 status id 为准，并且只接受 id 对得上的 article（内容和 id 必须同源）。
        const article = [...document.querySelectorAll('article[data-testid="tweet"]')]
            .find(a => getXTweetId(a) === statusId);
        return article ? { id: 'x:' + statusId, statusId, site: 'x', type: 'post', ref: article } : null;
    }

    function ensureXTweetCollectButton(article) {
        if (!settings.enableFavorite) return;
        const groups = [...article.querySelectorAll('[role="group"]')];
        const group = groups.find(g => g.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="retweet"], [data-testid="bookmark"]')) ||
            groups[groups.length - 1];
        if (!group) return;
        if (article.querySelector('.be-x-collect')) return;
        const record = extractXTweetRecord(article);
        if (!record) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'be-site-collect be-x-collect';
        btn.setAttribute('data-site', 'x');
        btn.setAttribute('data-record-id', record.id);
        setHtml(btn, COLLECT_ICON);
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                const latest = extractXTweetRecord(article) || record;
                const res = await toggleRecordById(latest);
                updateSiteCollectButtonStates();
                if (res.ok) showFavToast(res.action === 'added' ? '已收藏推文' : '已取消收藏推文');
                else showFavToast('推文收藏失败：' + res.error);
            } catch (err) {
                showFavToast('推文收藏失败：' + ((err && err.message) || err));
            } finally {
                btn.disabled = false;
            }
        });
        group.appendChild(btn);
        setSiteCollectButtonState(btn, favoriteIdSet.has(record.id));
    }

    function scanXContent() {
        document.querySelectorAll('article[data-testid="tweet"]').forEach(ensureXTweetCollectButton);
        updatePrimaryFavoriteMenuItem();
    }

    // ── 统一调度 ──

    function ensurePrimaryCollectButton() {
        if (SITE === 'bilibili') ensureBilibiliVideoCollectButton();
        else if (SITE === 'youtube') ensureYoutubeCollectButton();
    }

    function scanSiteContent() {
        if (SITE === 'youtube') scanYoutubeContent();
        else if (SITE === 'x') scanXContent();
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 9: 悬浮球 UI（拖拽 / 边缘半隐藏 / hover 菜单）
    // ═══════════════════════════════════════════════════════════════

    const FAB_POSITION_KEY = 'bili-enhancer-fab-position';
    const FAB_SIZE = 48;
    const FAB_EDGE_SNAP = 24;
    const FAB_MARGIN = 8;
    const FAB_DEFAULT_Y_RATIO = 0.45;

    let fabWrapEl = null;
    let fabBallEl = null;
    let fabMenuEl = null;
    let fabMenuHideTimer = null;
    let fabSuppressClick = false;

    function clamp01(value) {
        return Math.min(1, Math.max(0, value));
    }

    /** 查找 B 站右侧固定工具栏（小窗 / 客服 / 顶部），用于默认位置避让 */
    function findBiliSideRail() {
        const direct = document.querySelector('.fixed-sidenav-storage');
        if (direct) {
            const rect = direct.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.right > window.innerWidth - 220) {
                return direct;
            }
        }

        const candidates = document.querySelectorAll('[class*="sidenav"], [class*="fixed"]');
        for (const el of candidates) {
            const text = (el.textContent || '').trim();
            if (text !== '顶部' && text !== '客服' && text !== '小窗') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.right <= window.innerWidth - 220) continue;
            return el.closest('[class*="sidenav"]') || el.parentElement || el;
        }
        return null;
    }

    function loadFabPosition() {
        try {
            const raw = localStorage.getItem(FAB_POSITION_KEY);
            if (!raw) return null;
            const saved = JSON.parse(raw);
            return saved && typeof saved === 'object' ? saved : null;
        } catch (_) {
            return null;
        }
    }

    function saveFabPosition() {
        if (!fabWrapEl) return;
        const rect = fabWrapEl.getBoundingClientRect();
        const side = fabWrapEl.getAttribute('data-side') || null;
        const payload = side
            ? { side, yRatio: clamp01((rect.top + FAB_SIZE / 2) / window.innerHeight) }
            : {
                side: null,
                xRatio: clamp01((rect.left + FAB_SIZE / 2) / window.innerWidth),
                yRatio: clamp01((rect.top + FAB_SIZE / 2) / window.innerHeight),
            };
        try {
            localStorage.setItem(FAB_POSITION_KEY, JSON.stringify(payload));
        } catch (_) { /* ignore */ }
    }

    /** 给 hover 菜单预留上下空间，避免菜单超出视口 */
    function clampFabY(y) {
        const menuReserve = Math.min(180, Math.max(80, window.innerHeight * 0.24));
        const maxY = Math.max(menuReserve, window.innerHeight - FAB_SIZE - menuReserve);
        return Math.min(Math.max(y, menuReserve), maxY);
    }

    function updateFabMenuSide(side) {
        if (fabWrapEl) fabWrapEl.setAttribute('data-menu', side);
    }

    function applyFabPosition(pos) {
        if (!fabWrapEl) return;
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        const saved = pos || loadFabPosition();

        if (saved && saved.side === 'left') {
            const y = clampFabY((saved.yRatio ?? FAB_DEFAULT_Y_RATIO) * viewportH - FAB_SIZE / 2);
            fabWrapEl.setAttribute('data-side', 'left');
            fabWrapEl.style.left = '0px';
            fabWrapEl.style.top = `${Math.round(y)}px`;
            updateFabMenuSide('right');
            return;
        }

        if (saved && saved.side === 'right') {
            const y = clampFabY((saved.yRatio ?? FAB_DEFAULT_Y_RATIO) * viewportH - FAB_SIZE / 2);
            fabWrapEl.setAttribute('data-side', 'right');
            fabWrapEl.style.left = `${Math.round(viewportW - FAB_SIZE)}px`;
            fabWrapEl.style.top = `${Math.round(y)}px`;
            updateFabMenuSide('left');
            return;
        }

        if (saved && typeof saved.xRatio === 'number' && typeof saved.yRatio === 'number') {
            const x = Math.min(Math.max(saved.xRatio * viewportW - FAB_SIZE / 2, FAB_MARGIN), viewportW - FAB_SIZE - FAB_MARGIN);
            const y = Math.min(Math.max(saved.yRatio * viewportH - FAB_SIZE / 2, FAB_MARGIN), viewportH - FAB_SIZE - FAB_MARGIN);
            fabWrapEl.removeAttribute('data-side');
            fabWrapEl.style.left = `${Math.round(x)}px`;
            fabWrapEl.style.top = `${Math.round(y)}px`;
            updateFabMenuSide(x + FAB_SIZE / 2 < viewportW / 2 ? 'right' : 'left');
            return;
        }

        // 默认贴右侧；如果检测到 B 站原生工具栏，就放在它上方
        const rail = findBiliSideRail();
        let defaultY = viewportH * FAB_DEFAULT_Y_RATIO - FAB_SIZE / 2;
        if (rail) {
            const railRect = rail.getBoundingClientRect();
            defaultY = railRect.top - FAB_SIZE - 12;
        }
        fabWrapEl.setAttribute('data-side', 'right');
        fabWrapEl.style.left = `${Math.round(viewportW - FAB_SIZE)}px`;
        fabWrapEl.style.top = `${Math.round(clampFabY(defaultY))}px`;
        updateFabMenuSide('left');
    }

    function resetFabPosition() {
        try { localStorage.removeItem(FAB_POSITION_KEY); } catch (_) { /* ignore */ }
        applyFabPosition(null);
        closeFabMenu();
        showFavToast('悬浮球位置已重置');
    }

    function positionFabMenu() {
        if (!fabWrapEl || !fabMenuEl) return;
        const wrapRect = fabWrapEl.getBoundingClientRect();
        const menuRect = fabMenuEl.getBoundingClientRect();
        const halfMenu = menuRect.height / 2;
        const centerY = wrapRect.top + wrapRect.height / 2;
        const clampedCenter = Math.min(Math.max(centerY, halfMenu + 12), window.innerHeight - halfMenu - 12);
        fabMenuEl.style.top = `${Math.round(clampedCenter - wrapRect.top)}px`;
    }

    function openFabMenu() {
        if (!fabWrapEl || fabWrapEl.classList.contains('be-dragging')) return;
        clearTimeout(fabMenuHideTimer);
        fabWrapEl.classList.add('be-menu-open');
        fabBallEl?.setAttribute('aria-expanded', 'true');
        positionFabMenu();
    }

    function closeFabMenu() {
        if (!fabWrapEl) return;
        fabWrapEl.classList.remove('be-menu-open');
        fabBallEl?.setAttribute('aria-expanded', 'false');
    }

    function scheduleCloseFabMenu() {
        clearTimeout(fabMenuHideTimer);
        fabMenuHideTimer = setTimeout(closeFabMenu, 140);
    }

    function snapFabToEdge() {
        if (!fabWrapEl) return;
        const rect = fabWrapEl.getBoundingClientRect();
        const viewportW = window.innerWidth;
        const y = clampFabY(rect.top);

        if (rect.left <= FAB_EDGE_SNAP) {
            fabWrapEl.setAttribute('data-side', 'left');
            fabWrapEl.style.left = '0px';
            fabWrapEl.style.top = `${Math.round(y)}px`;
            updateFabMenuSide('right');
            return;
        }

        if (viewportW - rect.right <= FAB_EDGE_SNAP) {
            fabWrapEl.setAttribute('data-side', 'right');
            fabWrapEl.style.left = `${Math.round(viewportW - FAB_SIZE)}px`;
            fabWrapEl.style.top = `${Math.round(y)}px`;
            updateFabMenuSide('left');
            return;
        }

        fabWrapEl.removeAttribute('data-side');
        fabWrapEl.style.left = `${Math.round(Math.min(Math.max(rect.left, FAB_MARGIN), viewportW - FAB_SIZE - FAB_MARGIN))}px`;
        fabWrapEl.style.top = `${Math.round(y)}px`;
        updateFabMenuSide(rect.left + FAB_SIZE / 2 < viewportW / 2 ? 'right' : 'left');
    }

    function createFloatingUI() {
        if (document.getElementById('be-fab-wrap')) return;

        const wrap = document.createElement('div');
        wrap.id = 'be-fab-wrap';
        setHtml(wrap, `
            <button type="button" id="be-fab-ball" aria-label="评论增强，拖拽移动，悬停打开菜单" aria-expanded="false">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="be-fab-count" aria-hidden="true"></span>
            </button>
            <div id="be-fab-menu" role="menu" aria-label="评论增强菜单">
                <button type="button" class="be-fab-menu-item" id="be-fab-video-fav" role="menuitem" aria-pressed="false" hidden>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>
                    <span>收藏当前视频</span>
                </button>
                <button type="button" class="be-fab-menu-item" id="be-fab-favorites" role="menuitem">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                    <span>我的收藏</span>
                    <span class="be-fab-count" aria-hidden="true"></span>
                </button>
                <div class="be-row be-bili-only">
                    <span class="be-row-label">IP 属地</span>
                    <label class="be-toggle">
                        <input type="checkbox" id="be-toggle-ip" ${settings.showIp ? 'checked' : ''}>
                        <span class="be-toggle-track"><span class="be-toggle-thumb"></span></span>
                    </label>
                </div>
                <div class="be-row be-bili-only">
                    <span class="be-row-label">粉丝数量</span>
                    <label class="be-toggle">
                        <input type="checkbox" id="be-toggle-fans" ${settings.showFans ? 'checked' : ''}>
                        <span class="be-toggle-track"><span class="be-toggle-thumb"></span></span>
                    </label>
                </div>
                <div class="be-row">
                    <span class="be-row-label">评论收藏</span>
                    <label class="be-toggle">
                        <input type="checkbox" id="be-toggle-fav" ${settings.enableFavorite ? 'checked' : ''}>
                        <span class="be-toggle-track"><span class="be-toggle-thumb"></span></span>
                    </label>
                </div>
                <div class="be-fab-menu-divider"></div>
                <div class="be-fab-menu-footer">
                    <button type="button" class="be-fab-icon-btn" id="be-fab-reset" title="重置悬浮球位置" aria-label="重置悬浮球位置">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
                    </button>
                </div>
            </div>`);

        document.body.appendChild(wrap);
        if (SITE !== 'bilibili') {
            wrap.querySelectorAll('.be-bili-only').forEach(el => { el.hidden = true; });
        }
        fabWrapEl = wrap;
        fabBallEl = wrap.querySelector('#be-fab-ball');
        fabMenuEl = wrap.querySelector('#be-fab-menu');

        applyFabPosition();
        updateFavCountBadge();
        updateVideoFavoriteMenuItem();

        // ── hover / focus 菜单 ──
        wrap.addEventListener('mouseenter', openFabMenu);
        wrap.addEventListener('mouseleave', scheduleCloseFabMenu);
        fabBallEl.addEventListener('focus', openFabMenu);
        wrap.addEventListener('focusout', (e) => {
            if (!wrap.contains(e.relatedTarget)) scheduleCloseFabMenu();
        });
        wrap.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeFabMenu();
        });

        // ── 菜单项 ──
        wrap.querySelector('#be-fab-video-fav').addEventListener('click', async function () {
            if (this.disabled) return;
            this.disabled = true;
            try {
                const res = await toggleCurrentVideoFavorite();
                updateVideoFavoriteMenuItem();
                if (res.ok) {
                    showFavToast(res.action === 'added' ? '已收藏' : '已取消收藏');
                } else if (res.error === 'not-collectable') {
                    showFavToast('当前页面没有可收藏的内容');
                } else {
                    showFavToast('收藏失败：' + res.error);
                }
            } catch (e) {
                showFavToast('收藏失败：' + ((e && e.message) || e));
            } finally {
                this.disabled = false;
            }
        });
        wrap.querySelector('#be-fab-favorites').addEventListener('click', () => {
            closeFabMenu();
            openFavoritesPanel();
        });
        wrap.querySelector('#be-fab-reset').addEventListener('click', resetFabPosition);

        // ── 开关 ──
        wrap.querySelector('#be-toggle-ip').addEventListener('change', function () {
            settings.showIp = this.checked;
            saveSettings(settings);
            applyVisibility();
        });
        wrap.querySelector('#be-toggle-fans').addEventListener('change', function () {
            settings.showFans = this.checked;
            saveSettings(settings);
            applyVisibility();
        });
        wrap.querySelector('#be-toggle-fav').addEventListener('change', function () {
            settings.enableFavorite = this.checked;
            saveSettings(settings);
            applyVisibility();
            scanSiteContent();
        });

        // ── 拖拽（用 window 监听，确保指针移出悬浮球后仍能继续拖动） ──
        let drag = null;

        const onDragMove = (e) => {
            if (!drag || e.pointerId !== drag.pointerId) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
            if (!drag.moved) return;
            e.preventDefault();

            const maxX = window.innerWidth - FAB_SIZE - FAB_MARGIN;
            const maxY = window.innerHeight - FAB_SIZE - FAB_MARGIN;
            const left = Math.min(Math.max(drag.originLeft + dx, FAB_MARGIN), maxX);
            const top = Math.min(Math.max(drag.originTop + dy, FAB_MARGIN), maxY);

            wrap.removeAttribute('data-side');
            updateFabMenuSide(left + FAB_SIZE / 2 < window.innerWidth / 2 ? 'right' : 'left');
            wrap.style.left = `${Math.round(left)}px`;
            wrap.style.top = `${Math.round(top)}px`;
        };

        const onDragEnd = (e) => {
            if (!drag || (e && e.pointerId !== drag.pointerId)) return;
            const moved = drag.moved;
            drag = null;
            window.removeEventListener('pointermove', onDragMove);
            window.removeEventListener('pointerup', onDragEnd);
            window.removeEventListener('pointercancel', onDragEnd);
            wrap.classList.remove('be-dragging');

            if (moved) {
                fabSuppressClick = true;
                snapFabToEdge();
                saveFabPosition();
                return;
            }

            if (window.matchMedia('(hover: hover)').matches) {
                openFavoritesPanel();
            } else {
                const open = !wrap.classList.contains('be-menu-open');
                wrap.classList.toggle('be-menu-open', open);
                fabBallEl.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (open) positionFabMenu();
            }
        };

        fabBallEl.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const rect = wrap.getBoundingClientRect();
            drag = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                originLeft: rect.left,
                originTop: rect.top,
                moved: false,
            };
            fabSuppressClick = false;
            wrap.classList.add('be-dragging');
            closeFabMenu();
            window.addEventListener('pointermove', onDragMove, { passive: false });
            window.addEventListener('pointerup', onDragEnd);
            window.addEventListener('pointercancel', onDragEnd);
            e.preventDefault();
        });

        fabBallEl.addEventListener('dragstart', (e) => e.preventDefault());
        fabBallEl.addEventListener('click', (e) => {
            if (!fabSuppressClick) return;
            e.preventDefault();
            e.stopPropagation();
            fabSuppressClick = false;
        });

        // 点击外部关闭菜单
        document.addEventListener('pointerdown', (e) => {
            if (!wrap.contains(e.target)) closeFabMenu();
        });

        // 视口变化时重新计算位置
        window.addEventListener('resize', () => {
            applyFabPosition();
            positionFabMenu();
        }, { passive: true });

        // 原生工具栏异步出现时，如果用户还没自定义位置，重新校准默认位置
        setTimeout(() => {
            if (!loadFabPosition()) applyFabPosition();
        }, 1200);
    }

    // ═══════════════════════════════════════════════════════════════
    // Module 10: 入口 & 编排
    // ═══════════════════════════════════════════════════════════════

    let commentObserver = null;
    let labelScheduled = false;

    /** 合并同一帧内的 DOM 变化，避免动态页高频 MutationObserver 抖动 */
    function scheduleLabelAllComments() {
        if (labelScheduled) return;
        labelScheduled = true;
        requestAnimationFrame(() => {
            labelScheduled = false;
            if (commentObserver) labelAllComments(commentObserver);
            ensurePrimaryCollectButton();
            updatePrimaryFavoriteMenuItem();
        });
    }

    /** YouTube / X 的 DOM 变化合并扫描 */
    function scheduleSiteScan() {
        if (labelScheduled) return;
        labelScheduled = true;
        requestAnimationFrame(() => {
            labelScheduled = false;
            scanSiteContent();
        });
    }

    async function init() {
        // 隐藏 iframe 只负责跨子域读写收藏，不注入任何 UI
        if (isFavBridgeFrame()) {
            initFavBridgeFrame();
            return;
        }

        // 浮窗 UI 与评论区增强解耦：主站首页 / 动态页没有评论时也能查看收藏
        if (!shouldInjectUI()) return;

        refreshTheme();          // 先写入 data-be-theme，CSS 变量立即生效
        injectStyles();
        applyVisibility();       // 应用初始可见性设置
        createFloatingUI();
        observeThemeChanges();   // 监听 B 站深色 / 浅色切换

        // 后台加载收藏缓存，不阻塞评论渲染；完成后刷新角标和按钮状态
        initFavoriteState()
            .then(() => {
                updateFavCountBadge();
                updatePrimaryFavoriteMenuItem();
                refreshFavoriteButtonStates();
                updateSiteCollectButtonStates();
                ensurePrimaryCollectButton();
                scanSiteContent();
            })
            .catch(() => {});

        // 按站点启动扫描：B 站评论区 / YouTube 评论 / X 推文
        if (SITE === 'bilibili' && matchPage(CONFIG.enabledPages)) {
            commentObserver = new MutationObserver(scheduleLabelAllComments);
            commentObserver.observe(document.body, {
                childList: true,
                subtree: true,
            });

            labelAllComments(commentObserver);
            ensurePrimaryCollectButton();
        } else if (SITE === 'youtube' || SITE === 'x') {
            commentObserver = new MutationObserver(scheduleSiteScan);
            commentObserver.observe(document.body, {
                childList: true,
                subtree: true,
            });
            scanSiteContent();
        }
    }

    // ── 启动 ──

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init().catch(console.error);
        });
    } else {
        init().catch(console.error);
    }
})();
