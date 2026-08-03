import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

/** 事件目标所在的外层 <a href> 元素（含链接内的嵌套子元素），非链接返回 null */
function anchorFromTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest("a[href]");
}

/** 仅把 http/https 视为"外部链接"；相对路径、#hash、mailto: 等一律放行 */
function isExternalUrl(href: string | null): href is string {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 经 Rust 命令用系统默认浏览器打开（Rust 侧再次校验只允许 http/https） */
function openInBrowser(url: string): void {
  void invoke("open_external_url", { url }).catch((error: unknown) => {
    console.error("打开外部链接失败", error);
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 受限 webview 环境回退到 execCommand
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

interface LinkMenuState {
  url: string;
  x: number;
  y: number;
}

const MENU_WIDTH = 166;
const MENU_HEIGHT = 88;

/**
 * 对话/面板内所有外部链接的统一守门人，兜底于任何渲染路径
 * （react-markdown、MCP 返回内容、未来新增组件）：
 *
 * - 左键点击：阻止 webview 顶层导航，改走系统默认浏览器（对应 Rust
 *   on_navigation 白名单，构成双层防御）；
 * - 右键：自定义菜单，支持复制链接 / 在浏览器中打开；
 * - window.open：同样改走系统浏览器。
 */
export function LinkGuard() {
  const [menu, setMenu] = useState<LinkMenuState | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 事件监听只用 ref 读菜单状态，避免每次开合菜单都重新注册监听器
  const menuStateRef = useRef<LinkMenuState | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const openMenu = useCallback((next: LinkMenuState) => {
    menuStateRef.current = next;
    setCopied(false);
    setMenu(next);
  }, []);

  const closeMenu = useCallback(() => {
    menuStateRef.current = null;
    setCopied(false);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setMenu(null);
  }, []);

  const handleCopy = useCallback(
    async (url: string) => {
      const ok = await copyText(url);
      if (!ok) {
        console.error("复制链接失败");
        closeMenu();
        return;
      }
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    },
    [closeMenu],
  );

  useEffect(() => {
    const handleClickCapture = (event: MouseEvent) => {
      // 菜单开着时：点击菜单内部不处理；点击外部先关闭菜单
      if (menuStateRef.current) {
        if (menuRef.current?.contains(event.target as Node)) return;
        closeMenu();
      }
      if (event.button !== 0) return;
      const anchor = anchorFromTarget(event.target);
      const href = anchor?.getAttribute("href") ?? null;
      if (!isExternalUrl(href)) return;
      event.preventDefault();
      event.stopPropagation();
      openInBrowser(href);
    };

    const handleContextMenuCapture = (event: MouseEvent) => {
      const anchor = anchorFromTarget(event.target);
      const href = anchor?.getAttribute("href") ?? null;
      if (!isExternalUrl(href)) return;
      event.preventDefault();
      event.stopPropagation();
      const x = Math.min(event.clientX, window.innerWidth - MENU_WIDTH);
      const y = Math.min(event.clientY, window.innerHeight - MENU_HEIGHT);
      openMenu({ url: href, x: Math.max(0, x), y: Math.max(0, y) });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuStateRef.current) {
        closeMenu();
      }
    };

    const handleBlur = () => closeMenu();
    const handleScroll = () => closeMenu();

    // window.open 兜底：任何路径用 window.open 打开外部链接都改走系统浏览器
    const originalOpen = window.open;
    window.open = (url?: string | URL, target?: string, features?: string) => {
      if (url) {
        const href = typeof url === "string" ? url : url.href;
        if (isExternalUrl(href)) {
          openInBrowser(href);
          return null;
        }
      }
      return originalOpen.call(window, url, target, features);
    };

    document.addEventListener("click", handleClickCapture, true);
    document.addEventListener("contextmenu", handleContextMenuCapture, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("click", handleClickCapture, true);
      document.removeEventListener("contextmenu", handleContextMenuCapture, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("scroll", handleScroll, true);
      window.open = originalOpen;
    };
  }, [closeMenu, openMenu]);

  return (
    <>
      {menu ? (
        <div
          ref={menuRef}
          className="context-menu link-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label="链接操作"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopy(menu.url)}
          >
            <Copy size={15} />
            {copied ? "已复制" : "复制链接"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openInBrowser(menu.url);
              closeMenu();
            }}
          >
            <ExternalLink size={15} />
            在浏览器中打开
          </button>
        </div>
      ) : null}
    </>
  );
}
