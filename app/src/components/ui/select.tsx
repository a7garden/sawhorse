import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  size?: "default" | "sm";
  variant?: "default" | "sidebar";
  leadingIcon?: React.ReactNode;
  /** Layout classes for the wrapper (`w-full`, `flex-1`, margins...). */
  className?: string;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

const MAX_LIST_HEIGHT = 288;

const sizeClasses = {
  default: { control: "h-9 px-3 text-sm", chevron: "size-3.5" },
  sm: { control: "h-8 px-2.5 text-xs", chevron: "size-3" },
} as const;

function optionText(option: SelectOption): string {
  if (typeof option.label === "string") return option.label;
  if (typeof option.label === "number") return String(option.label);
  return "";
}

/**
 * Fully custom combobox — no native `<select>`, so both the closed control and
 * the open list are ours to style (dark mode, radius, motion) consistently.
 *
 * WAI-ARIA combobox pattern: focus never leaves the trigger; the open list is
 * driven via `aria-activedescendant` over `role="listbox"` options. Keyboard:
 * Enter/Space/ArrowDown/ArrowUp open, arrows/Home/End navigate, typeahead
 * jumps, Enter selects, Escape closes (and does not bubble to dialogs).
 *
 * The list is portaled to `document.body` with fixed positioning so it never
 * clips inside dialogs or scroll containers; it repositions on scroll/resize
 * and flips above the trigger when there is no room below.
 */
export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      options,
      value,
      onChange,
      placeholder,
      size = "default",
      variant = "default",
      leadingIcon,
      className,
      id,
      disabled,
      "aria-label": ariaLabel,
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(-1);
    const [popupStyle, setPopupStyle] = React.useState<React.CSSProperties>({});
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const popupRef = React.useRef<HTMLDivElement | null>(null);
    const typeahead = React.useRef({ text: "", at: 0 });
    const listId = React.useId();

    const selectedIndex = options.findIndex((option) => option.value === value);
    const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
    const sizes = sizeClasses[size];
    const Chevron = variant === "sidebar" ? ChevronsUpDown : ChevronDown;

    const placePopup = React.useCallback(() => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 4;
      const margin = 8;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const openUp = spaceAbove > spaceBelow && spaceBelow < 160;
      const maxHeight = Math.max(120, Math.min(MAX_LIST_HEIGHT, openUp ? spaceAbove : spaceBelow));
      // A collapsed sidebar has a narrow trigger, but project names need a readable menu.
      const width = Math.min(Math.max(rect.width, variant === "sidebar" ? 200 : 0), window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      setPopupStyle(
        openUp
          ? { left, bottom: window.innerHeight - rect.top + gap, width, maxHeight }
          : { left, top: rect.bottom + gap, width, maxHeight },
      );
    }, [variant]);

    const closeList = React.useCallback(() => {
      setOpen(false);
      setActiveIndex(-1);
      typeahead.current = { text: "", at: 0 };
    }, []);

    const openList = React.useCallback(() => {
      if (disabled || options.length === 0) return;
      setActiveIndex(selectedIndex);
      setOpen(true);
    }, [disabled, options.length, selectedIndex]);

    const selectIndex = React.useCallback(
      (index: number) => {
        const option = options[index];
        if (!option || option.disabled) return;
        onChange?.(option.value);
        closeList();
      },
      [closeList, onChange, options],
    );

    const moveActive = React.useCallback(
      (from: number, delta: 1 | -1) => {
        if (options.length === 0) return from;
        let index = from;
        for (let step = 0; step < options.length; step += 1) {
          index = (index + delta + options.length) % options.length;
          if (!options[index].disabled) return index;
        }
        return from;
      },
      [options],
    );

    const focusByPrefix = React.useCallback(
      (prefix: string, start: number) => {
        for (let step = 1; step <= options.length; step += 1) {
          const index = (start + step + options.length) % options.length;
          const option = options[index];
          if (option.disabled) continue;
          if (optionText(option).toLowerCase().startsWith(prefix)) return index;
        }
        return -1;
      },
      [options],
    );

    const handleKeyDown = (event: React.KeyboardEvent) => {
      if (disabled) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) openList();
        else setActiveIndex((index) => moveActive(index, event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        if (!open) return;
        event.preventDefault();
        const scan = event.key === "Home" ? 1 : -1;
        let index = event.key === "Home" ? -1 : options.length;
        for (let step = 0; step < options.length; step += 1) {
          index += scan;
          if (!options[index]?.disabled) break;
        }
        if (options[index]?.disabled === false) setActiveIndex(index);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!open) openList();
        else selectIndex(activeIndex);
        return;
      }
      if (event.key === "Escape") {
        if (open) {
          // Close only the list — dialogs must not react to this Escape.
          event.preventDefault();
          event.stopPropagation();
          closeList();
        }
        return;
      }
      if (event.key === "Tab") {
        if (open) closeList();
        return;
      }
      if (!open || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      const now = Date.now();
      const streak = now - typeahead.current.at < 500 ? typeahead.current.text : "";
      const prefix = (streak + event.key).toLowerCase();
      typeahead.current = { text: prefix, at: now };
      const hit = focusByPrefix(prefix, activeIndex);
      if (hit >= 0) setActiveIndex(hit);
    };

    React.useLayoutEffect(() => {
      if (open) placePopup();
    }, [open, placePopup]);

    React.useEffect(() => {
      if (!open) return;
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node;
        if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
        closeList();
      };
      document.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("resize", placePopup);
      document.addEventListener("scroll", placePopup, true);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("resize", placePopup);
        document.removeEventListener("scroll", placePopup, true);
      };
    }, [open, placePopup, closeList]);

    React.useEffect(() => {
      if (!open || activeIndex < 0) return;
      popupRef.current
        ?.querySelector(`[id="${listId}-opt-${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex, listId]);

    const setTriggerRef = (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    };

    return (
      <div className={cn("relative", className)}>
        <button
          ref={setTriggerRef}
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
          aria-label={ariaLabel}
          data-state={open ? "open" : "closed"}
          disabled={disabled}
          onClick={() => (open ? closeList() : openList())}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-input/70 bg-card text-card-foreground transition-colors",
            "hover:border-foreground/20 hover:bg-muted/40 data-[state=open]:border-foreground/25",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-50",
            sizes.control,
            variant === "sidebar" && "h-10 border-transparent bg-foreground/[0.04] px-2.5 font-medium hover:border-foreground/10 hover:bg-foreground/[0.07] data-[state=open]:border-foreground/15 data-[state=open]:bg-foreground/[0.07]",
          )}
        >
          {leadingIcon && <span aria-hidden className="flex shrink-0 items-center text-muted-foreground">{leadingIcon}</span>}
          <span className="min-w-0 flex-1 truncate text-left">
            {selected ? (
              selected.label
            ) : (
              placeholder && <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <Chevron
            aria-hidden
            className={cn("shrink-0 text-muted-foreground/70 transition-transform", sizes.chevron, open && variant !== "sidebar" && "rotate-180")}
          />
        </button>
        {open &&
          createPortal(
            <div
              ref={popupRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              style={popupStyle}
              // Keep focus on the trigger; click targets are the options below.
              onMouseDown={(event) => event.preventDefault()}
              className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-foreground/10 bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/15"
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${listId}-opt-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  data-active={index === activeIndex || undefined}
                  title={optionText(option) || undefined}
                  onMouseEnter={() => {
                    if (!option.disabled) setActiveIndex(index);
                  }}
                  onClick={() => selectIndex(index)}
                  className={cn(
                    "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors",
                    "data-active:bg-foreground/[0.07] aria-selected:font-medium",
                    size === "sm" && "text-xs",
                    option.disabled && "pointer-events-none opacity-50",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.value === value && <Check aria-hidden className="size-3.5 shrink-0" />}
                </div>
              ))}
            </div>,
            document.body,
          )}
      </div>
    );
  },
);
Select.displayName = "Select";
