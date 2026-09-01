import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-white/70 bg-white/55 backdrop-blur-md placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-primary/30 focus-visible:bg-white/75 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-2xl border px-3 py-2 text-base shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-[color,box-shadow,background-color] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
