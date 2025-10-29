import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({ className = "", ...props }: DialogPrimitive.DialogOverlayProps) {
  return (
    <DialogPrimitive.Overlay
      className={
        "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in " +
        "data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out " +
        className
      }
      {...props}
    />
  );
}

export function DialogContent({ className = "", children, ...props }: DialogPrimitive.DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={
          "fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-md " +
          "bg-white p-6 shadow-lg outline-none dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 " +
          className
        }
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className = "", children }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={"mb-4 " + className}>{children}</div>;
}

export function DialogTitle({ className = "", children }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={"text-lg font-semibold " + className}>{children}</h2>;
}

export function DialogDescription({ className = "", children }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={"text-sm text-neutral-600 dark:text-neutral-300 " + className}>{children}</p>;
}

export function DialogFooter({ className = "", children }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={"mt-6 flex items-center justify-end gap-3 " + className}>{children}</div>;
}