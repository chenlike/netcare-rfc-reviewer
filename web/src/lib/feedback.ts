import { shallowRef } from "vue";
import { toast } from "vue-sonner";
type Message = string | { message: string; duration?: number };
const show = (
  kind: "success" | "error" | "warning" | "info",
  value: Message,
) => {
  const text = typeof value === "string" ? value : value.message;
  return toast[kind](text, {
    duration: typeof value === "string" ? 4500 : value.duration,
  });
};
export const notify = {
  success: (v: Message) => show("success", v),
  error: (v: Message) => show("error", v),
  warning: (v: Message) => show("warning", v),
  info: (v: Message) => show("info", v),
};
export const confirmation = shallowRef<{
  title: string;
  message: string;
  action: string;
  resolve: () => void;
  reject: () => void;
}>();
export function confirmAction(
  message: string,
  title: string,
  options?: {
    type?: string;
    confirmButtonText?: string;
    cancelButtonText?: string;
  },
) {
  return new Promise<void>((resolve, reject) => {
    confirmation.value?.reject();
    confirmation.value = {
      title,
      message,
      action: options?.confirmButtonText || "确认",
      resolve,
      reject: () => reject("cancel"),
    };
  });
}
export function settleConfirmation(accepted: boolean) {
  const current = confirmation.value;
  confirmation.value = undefined;
  if (accepted) current?.resolve();
  else current?.reject();
}
