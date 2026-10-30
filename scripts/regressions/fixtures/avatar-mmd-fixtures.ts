// Source-authored PMX/VMD fixtures: one triangle, a bone and a smile morph. No third-party model assets.
import { Buffer } from "node:buffer";

function writer() {
  const parts: Buffer[] = [];
  const bytes = (value: Uint8Array) => parts.push(Buffer.from(value));
  const number = (size: number, write: (part: Buffer) => void) => {
    const part = Buffer.alloc(size);
    write(part);
    parts.push(part);
  };
  const i32 = (value: number) => number(4, (part) => part.writeInt32LE(value));
  return {
    bytes,
    u8: (value: number) => number(1, (part) => part.writeUInt8(value)),
    i8: (value: number) => number(1, (part) => part.writeInt8(value)),
    u16: (value: number) => number(2, (part) => part.writeUInt16LE(value)),
    i32,
    u32: (value: number) => number(4, (part) => part.writeUInt32LE(value)),
    floats: (...values: number[]) => values.forEach((value) => number(4, (part) => part.writeFloatLE(value))),
    text: (value: string) => {
      const data = Buffer.from(value);
      i32(data.length);
      bytes(data);
    },
    fixed: (value: string, size: number) => {
      const data = Buffer.alloc(size);
      data.write(value, "ascii");
      bytes(data);
    },
    finish: () => Buffer.concat(parts),
  };
}

/** A PMX2.0 model, optionally referring to a texture bundled beside it. */
export function mmdPmx({ texture = "", morphName = "笑い" } = {}): Buffer {
  const w = writer();
  w.bytes(Buffer.from("PMX "));
  w.floats(2);
  w.u8(8);
  w.bytes(new Uint8Array([1, 0, 1, 1, 1, 1, 1, 1]));
  for (const value of ["Fixture", "Fixture", "Source-authored regression model", ""]) w.text(value);
  w.i32(3);
  for (const [x, y, u, v] of [
    [-0.5, 0, 0, 0],
    [0.5, 0, 1, 0],
    [0, 2, 0.5, 1],
  ]) {
    w.floats(x!, y!, 0, 0, 0, 1, u!, v!);
    w.u8(0); // BDEF1, entirely attached to the center bone.
    w.i8(0);
    w.floats(1);
  }
  w.i32(3);
  w.bytes(new Uint8Array([0, 1, 2]));
  w.i32(texture ? 1 : 0);
  if (texture) w.text(texture);
  w.i32(1);
  w.text("surface");
  w.text("surface");
  w.floats(0.6, 0.3, 0.8, 1, 0, 0, 0, 1, 0.3, 0.2, 0.4);
  w.u8(1); // Double-sided.
  w.floats(0, 0, 0, 1, 0);
  w.i8(texture ? 0 : -1);
  w.i8(-1);
  w.u8(0);
  w.u8(1); // Shared toon texture0.
  w.u8(0);
  w.text("");
  w.i32(3);
  w.i32(1);
  w.text("center");
  w.text("center");
  w.floats(0, 0, 0);
  w.i8(-1);
  w.i32(0);
  w.u16(0);
  w.floats(0, 1, 0);
  w.i32(1);
  w.text(morphName);
  w.text("happy");
  w.u8(2);
  w.u8(1); // Vertex morph.
  w.i32(1);
  w.u8(2);
  w.floats(0.25, 0, 0);
  w.i32(0); // Display frames.
  w.i32(0); // Rigid bodies.
  w.i32(0); // Joints.
  return w.finish();
}

/** One-second VMD bone motion; the second frame shifts the triangle horizontally. */
export function mmdVmd(): Buffer {
  const w = writer();
  w.fixed("Vocaloid Motion Data 0002", 30);
  w.fixed("Fixture", 20);
  w.u32(2);
  for (const frame of [0, 30]) {
    w.fixed("center", 15);
    w.u32(frame);
    w.floats(frame ? 0.3 : 0, 0, 0, 0, 0, 0, 1);
    w.bytes(new Uint8Array(64).fill(20));
  }
  for (let section = 0; section < 5; section += 1) w.u32(0);
  return w.finish();
}
