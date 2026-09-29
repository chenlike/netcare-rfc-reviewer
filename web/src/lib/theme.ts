import { ref, watch } from "vue";
import { save } from "../api";
export type Theme = "light" | "dark" | "system";
export const theme = ref<Theme>("dark");
export const resolvedTheme = ref<"light" | "dark">("dark");
const media = window.matchMedia("(prefers-color-scheme: dark)");
function apply() {
  resolvedTheme.value =
    theme.value === "system" ? (media.matches ? "dark" : "light") : theme.value;
  document.documentElement.classList.toggle(
    "dark",
    resolvedTheme.value === "dark",
  );
  document.documentElement.style.colorScheme = resolvedTheme.value;
}
export function initializeTheme(value: Theme = "dark") {
  theme.value = value;
  apply();
}
export async function setTheme(value: Theme) {
  const previous = theme.value;
  theme.value = value;
  try {
    await save("/preferences", { theme: value });
  } catch (error) {
    theme.value = previous;
    throw error;
  }
}
watch(theme, apply, { flush: "sync" });
media.addEventListener("change", apply);
apply();
