import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Native `<select>` — OS popup is intentionally preserved (WebKit on macOS renders
 * a real native menu we cannot restyle). What we DO control is the closed control:
 * the chevron, padding, focus ring, and dark-mode treatment. Pairing it with
 * `truncate` lets long labels collapse inside the chip without forcing a wider
 * field.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className={cn("relative inline-block w-full", className)}>
    <select
      ref={ref}
      className={cn(
        "h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-2.5 pr-8 text-sm shadow-sm",
        "transition-colors",
        "hover:border-foreground/30",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // chevron sits over a clean gap; keep value text from touching the icon
        "truncate",
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      aria-hidden
      className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
    />
  </div>
));
Select.displayName = "Select";
