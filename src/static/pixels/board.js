// DOM-free board model: a row-major hex string (one palette index per pixel) plus the palette.
export class Board {
  constructor({ width, height, palette, pixels }) {
    if (pixels.length !== width * height) throw new Error("pixel data does not match the board size");
    this.width = width;
    this.height = height;
    this.palette = [...palette];
    this.colors = Uint8Array.from(pixels, (ch) => parseInt(ch, 16));
  }

  inRange(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  get(x, y) {
    return this.inRange(x, y) ? this.colors[y * this.width + x] : undefined;
  }

  set(x, y, color) {
    if (!this.inRange(x, y)) throw new RangeError("pixel out of range");
    if (!Number.isInteger(color) || color < 0 || color >= this.palette.length) throw new RangeError("colour out of range");
    this.colors[y * this.width + x] = color;
  }

  colorAt(x, y) {
    return this.palette[this.get(x, y)];
  }
}

export function parseBoard(data) {
  return new Board(data);
}
