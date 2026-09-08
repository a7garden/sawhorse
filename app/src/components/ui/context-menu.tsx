import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ContextMenuAction {
  type?: "item";
  label: string;
  icon?: React.ReactNode;
  /** Shows a check mark on the right — for "current value" rows in submenus. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
export interface ContextMenuLabel {
  type: "label";
  label: string;
}
export interface ContextMenuSeparator {
  type: "separator";
}
export interface ContextMenuSubmenu {
  type: "submenu";
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** One level only — a submenu cannot contain another submenu. */
  items: Array<ContextMenuAction | ContextMenuLabel | ContextMenuSeparator | false | null | undefined>;
}
export type ContextMenuEntry =
  | ContextMenuAction
  | ContextMenuSubmenu
  | ContextMenuLabel
  | ContextMenuSeparator;
/** Falsy members are allowed so callers can build menus with `condition && item`. */
export type ContextMenuInput = Array<ContextMenuEntry | false | null | undefined>;

type Anchor = { x: number; y: number };
type MenuState = { anchor: Anchor; entries: ContextMenuEntry[]; restore: HTMLElement | null };

const isEntry = <T,>(entry: T | false | null | undefined): entry is T => Boolean(entry);
const isSelectable = (entry: ContextMenuEntry | undefined) =>
  !!entry && entry.type !== "separator" && entry.type !== "label" && !entry.disabled;

/**
 * Right-click menu controller. One instance per surface:
 *
 *   const menu = useContextMenu();
 *   <article onContextMenu={(event) => menu.open(event, [...])} />
 *   {menu.element}
 *
 * `open` ignores Shift+right-click so the native browser menu stays reachable,
 * and does nothing when every entry is disabled or filtered out.
 */
export function useContextMenu() {
  const [state, setState] = React.useState<MenuState | null>(null);
  const close = React.useCallback(() => {
    setState((current) => {
      if (current?.restore?.isConnected) current.restore.focus({ preventScroll: true });
      return null;
    });
  }, []);
  const open = React.useCallback((event: React.MouseEvent, input: ContextMenuInput) => {
    if (event.shiftKey) return;
    const entries = input.filter(isEntry);
    if (!entries.some((entry) => isSelectable(entry))) return;
    event.preventDefault();
    event.stopPropagation();
    // The keyboard menu key reports (0,0) — anchor those on the element instead.
    let { clientX: x, clientY: y } = event;
    if (x === 0 && y === 0) {
      const rect = event.currentTarget.getBoundingClientRect();
      x = rect.left + Math.min(24, rect.width / 2);
      y = rect.top + rect.height / 2;
    }
    const active = document.activeElement;
    setState({ anchor: { x, y }, entries, restore: active instanceof HTMLElement ? active : null });
  }, []);
  return {
    open,
    close,
    isOpen: state !== null,
    element: state ? <ContextMenuPopup key={`${state.anchor.x}:${state.anchor.y}`} state={state} onClose={close} /> : null,
  };
}

function place(anchor: Anchor, size: { width: number; height: number }): React.CSSProperties {
  const margin = 8;
  let left = anchor.x;
  let top = anchor.y;
  if (left + size.width > window.innerWidth - margin) left = Math.max(margin, anchor.x - size.width);
  if (top + size.height > window.innerHeight - margin) top = Math.max(margin, anchor.y - size.height);
  return { left, top };
}

function ContextMenuPopup({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const { entries, anchor } = state;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const subRef = React.useRef<HTMLDivElement | null>(null);
  const subCloseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rootStyle, setRootStyle] = React.useState<React.CSSProperties>();
  const [subStyle, setSubStyle] = React.useState<React.CSSProperties>();
  const [active, setActive] = React.useState(-1);
  const [openSub, setOpenSub] = React.useState<number | null>(null);
  const [subActive, setSubActive] = React.useState(-1);
  const listId = React.useId();
  const submenu = openSub !== null && entries[openSub]?.type === "submenu" ? (entries[openSub] as ContextMenuSubmenu) : null;
  const subItems = React.useMemo(() => (submenu?.items ?? []).filter(isEntry), [submenu]);

  const cancelSubClose = () => {
    if (subCloseTimer.current) clearTimeout(subCloseTimer.current);
    subCloseTimer.current = null;
  };
  const closeSub = React.useCallback(() => {
    cancelSubClose();
    setOpenSub(null);
    setSubActive(-1);
    setSubStyle(undefined);
  }, []);
  // Leaving the submenu trigger closes the panel after a beat, so a diagonal
  // move toward the panel that grazes the next row does not slam it shut.
  const scheduleSubClose = () => {
    cancelSubClose();
    subCloseTimer.current = setTimeout(closeSub, 150);
  };
  React.useEffect(() => cancelSubClose, []);

  React.useLayoutEffect(() => {
    const node = rootRef.current;
    if (node) setRootStyle(place(anchor, node.getBoundingClientRect()));
  }, [anchor]);

  // Focus only after the panel is placed — a hidden element silently refuses
  // focus, and without it every key press falls through to the page.
  React.useLayoutEffect(() => {
    if (rootStyle) rootRef.current?.focus({ preventScroll: true });
  }, [rootStyle]);

  React.useLayoutEffect(() => {
    if (openSub === null) return;
    const item = rootRef.current?.querySelector(`[id="${CSS.escape(`${listId}-item-${openSub}`)}"]`);
    const panel = subRef.current;
    if (!item || !panel) return;
    const itemRect = item.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const margin = 8;
    const gap = 2;
    let left = itemRect.right + gap;
    if (left + size.width > window.innerWidth - margin) left = Math.max(margin, itemRect.left - size.width - gap);
    const top = Math.max(margin, Math.min(itemRect.top - 6, window.innerHeight - size.height - margin));
    setSubStyle({ left, top });
  }, [openSub, listId]);

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || subRef.current?.contains(target)) return;
      onClose();
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || subRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const select = (entry: ContextMenuEntry | undefined) => {
    if (!entry || entry.type === "separator" || entry.type === "label" || entry.disabled) return;
    if (entry.type === "submenu") return;
    onClose();
    entry.onSelect();
  };

  const move = (list: ContextMenuEntry[], from: number, delta: 1 | -1) => {
    let index = from;
    for (let step = 0; step < list.length; step += 1) {
      index = (index + delta + list.length) % list.length;
      if (isSelectable(list[index])) return index;
    }
    return from;
  };

  const enterSub = (index: number) => {
    cancelSubClose();
    setOpenSub(index);
    setSubActive(-1);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const inSub = submenu !== null && subActive >= 0;
    const list = inSub ? subItems : entries;
    const current = inSub ? subActive : active;
    const setCurrent = inSub ? setSubActive : setActive;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCurrent(move(list, current, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setCurrent(move(list, event.key === "Home" ? list.length - 1 : 0, event.key === "Home" ? 1 : -1));
      return;
    }
    if (event.key === "ArrowRight") {
      const entry = entries[active];
      if (!inSub && entry?.type === "submenu" && !entry.disabled) {
        event.preventDefault();
        enterSub(active);
        setSubActive(move(entry.items.filter(isEntry), -1, 1));
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (submenu) {
        event.preventDefault();
        closeSub();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = list[current];
      if (!inSub && entry?.type === "submenu") {
        if (!entry.disabled) {
          enterSub(active);
          setSubActive(move(entry.items.filter(isEntry), -1, 1));
        }
        return;
      }
      select(entry);
      return;
    }
    if (event.key === "Escape") {
      // The menu owns this Escape — a dialog underneath must stay open.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onClose();
    }
  };

  const renderEntry = (
    entry: ContextMenuEntry,
    index: number,
    options: { activeIndex: number; idPrefix: string; onHover: (index: number) => void; root: boolean },
  ) => {
    if (entry.type === "separator") return <div key={index} role="separator" className="mx-1 my-1 h-px bg-foreground/10" />;
    if (entry.type === "label")
      return (
        <div key={index} className="max-w-64 truncate px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
          {entry.label}
        </div>
      );
    const isSub = entry.type === "submenu";
    return (
      <div
        key={index}
        id={`${options.idPrefix}-item-${index}`}
        role="menuitem"
        aria-disabled={entry.disabled || undefined}
        aria-haspopup={isSub ? "menu" : undefined}
        aria-expanded={isSub && options.root ? openSub === index : undefined}
        data-active={index === options.activeIndex || (options.root && isSub && openSub === index) || undefined}
        onMouseEnter={() => options.onHover(index)}
        onMouseLeave={options.root && isSub && openSub === index ? scheduleSubClose : undefined}
        onClick={() => {
          if (isSub) {
            if (!entry.disabled) enterSub(index);
            return;
          }
          select(entry);
        }}
        className={cn(
          "flex min-h-8 max-w-72 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors",
          "data-active:bg-foreground/[0.07]",
          entry.disabled && "pointer-events-none opacity-50",
          !isSub && entry.danger && "text-destructive data-active:bg-destructive/10",
        )}
      >
        {entry.icon && <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4">{entry.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        {!isSub && entry.checked && <Check aria-hidden className="size-3.5 shrink-0" />}
        {isSub && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />}
      </div>
    );
  };

  const panelClass =
    "fixed z-[80] max-h-[70vh] min-w-44 overflow-y-auto overscroll-contain rounded-xl border border-foreground/10 bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/15";

  return createPortal(
    <>
      <div
        ref={rootRef}
        role="menu"
        tabIndex={-1}
        aria-activedescendant={
          submenu && subActive >= 0
            ? `${listId}-sub-item-${subActive}`
            : active >= 0
              ? `${listId}-item-${active}`
              : undefined
        }
        style={rootStyle ?? { left: anchor.x, top: anchor.y, visibility: "hidden" }}
        className={cn(panelClass, "outline-none")}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        {entries.map((entry, index) =>
          renderEntry(entry, index, {
            activeIndex: active,
            idPrefix: listId,
            root: true,
            onHover: (hovered) => {
              setActive(hovered);
              const target = entries[hovered];
              if (target?.type === "submenu" && !target.disabled) enterSub(hovered);
              else if (openSub !== null && openSub !== hovered) scheduleSubClose();
            },
          }),
        )}
      </div>
      {submenu && (
        <div
          ref={subRef}
          role="menu"
          aria-label={submenu.label}
          style={subStyle ?? { left: anchor.x, top: anchor.y, visibility: "hidden" }}
          className={panelClass}
          onMouseEnter={cancelSubClose}
          onContextMenu={(event) => event.preventDefault()}
          // Keep focus (and key handling) on the root panel.
          onMouseDown={(event) => event.preventDefault()}
        >
          {subItems.map((entry, index) =>
            renderEntry(entry, index, {
              activeIndex: subActive,
              idPrefix: `${listId}-sub`,
              root: false,
              onHover: setSubActive,
            }),
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
