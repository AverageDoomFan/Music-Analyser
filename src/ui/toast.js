// Toasts live in a manual popover so they stay visible above modal dialogs
// (re-shown on each message to move to the top of the top layer).
export function toast(message, kind = "info", ms = 3500) {
  const host = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  if (host.showPopover) {
    if (host.matches(":popover-open")) host.hidePopover();
    host.showPopover();
  }
  setTimeout(() => {
    el.remove();
    if (!host.children.length && host.matches?.(":popover-open")) host.hidePopover();
  }, kind === "error" ? ms * 1.6 : ms);
}
