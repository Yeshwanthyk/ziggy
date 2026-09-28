import * as React from "react";

import { cn } from "@/lib/utils";
import "./controls.css";

type SwitchProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "role">;

/** A styled checkbox exposed as a switch. `checked` and `onChange` work as for a checkbox. */
const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(({ className, ...props }, ref) => (
  <input
    className={cn("ui-switch", className)}
    ref={ref}
    role="switch"
    type="checkbox"
    {...props}
  />
));
Switch.displayName = "Switch";

export { Switch };
