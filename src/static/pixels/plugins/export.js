// Export: downloads the board (not the zoomed viewport) as a PNG rendered at 8x scale.
export const EXPORT_SCALE = 8;

const pad = (n) => String(n).padStart(2, "0");

// pixels-<YYYYMMDD-HHmmss>.png in local time.
export function exportFilename(date = new Date()) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `pixels-${day}-${time}.png`;
}

function renderBoard(board) {
  const out = document.createElement("canvas");
  out.width = board.width * EXPORT_SCALE;
  out.height = board.height * EXPORT_SCALE;
  const ctx = out.getContext("2d");
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      ctx.fillStyle = board.colorAt(x, y);
      ctx.fillRect(x * EXPORT_SCALE, y * EXPORT_SCALE, EXPORT_SCALE, EXPORT_SCALE);
    }
  }
  return out;
}

export function mount({ board, toolbar }) {
  const button = document.createElement("button");
  button.id = "pixels-export";
  button.type = "button";
  button.textContent = "Export";

  button.addEventListener("click", () => {
    renderBoard(board).toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename();
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  });

  toolbar.append(button);
  return () => button.remove();
}
