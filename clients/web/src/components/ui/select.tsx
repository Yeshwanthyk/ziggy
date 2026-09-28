import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import "./controls.css";

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  size?: never;
  controlSize?: "sm" | "md";
  variant?: "outline" | "ghost";
  wrapperClassName?: string;
}

/** Native select with shared height, border, and chevron. Keeps the combobox role. */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, controlSize = "md", variant = "outline", wrapperClassName, ...props }, ref) => (
    <span
      className={cn("ui-select", wrapperClassName)}
      data-size={controlSize}
      data-variant={variant}
    >
      <select className={className} ref={ref} {...props} />
      <ChevronDown aria-hidden="true" />
    </span>
  ),
);
Select.displayName = "Select";

export { Select };
