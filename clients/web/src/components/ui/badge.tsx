import * as React from "react";

import { cn } from "@/lib/utils";
import "./controls.css";

type BadgeVariant = "neutral" | "outline" | "success" | "warning" | "danger";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const Badge = ({ className, variant = "neutral", ...props }: BadgeProps) => (
  <span className={cn("ui-badge", className)} data-variant={variant} {...props} />
);

export { Badge };
