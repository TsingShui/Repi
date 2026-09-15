import { onCleanup } from "solid-js";
import "./structure-field.css";

/**
 * An abstract view of an address space being read on this device.
 *
 * Sparse cells form a memory map; a slow band sweeps down and resolves cells in
 * the accent colour, leaving short fragments of hex and mnemonics behind. It is
 * decoration, but it is honest decoration: it depicts exactly what Repi does —
 * read bytes locally, and show structure.
 *
 * Rendering rules that keep it from becoming noise:
 *   - hairline cells only, no glow, no blur, no rounded shapes;
 *   - one accent colour, everything else is the muted ink;
 *   - the loop pauses when the tab is hidden and never starts at all when the
 *     visitor asks for reduced motion.
 */

const PITCH = 10;
const CELL = 6;
const PARALLAX_MARGIN = 14;
const PARALLAX_AMPLITUDE = 6;
const SWEEP_SECONDS = 13;
/** Starts the first sweep above the middle so the field never opens on an empty top edge. */
const SWEEP_PHASE = 0.26;
const BAND_RATIO = 0.22;
const LIT_ALPHA = 0.8;
/** Cells keep a decaying glow after the band has passed, which reads as a trail. */
const TRAIL_STRENGTH = 0.34;
const TRAIL_LENGTH = 2.4;
/** Alpha of the thin read head that leads the sweep. */
const HEAD_ALPHA = 0.34;
/**
 * The motion is slow, so half the frame rate is invisible and halves the cost
 * of a canvas that now covers the whole viewport.
 */
const FRAME_INTERVAL = 1000 / 30;
const IMPULSE_MS = 1400;
const FRAGMENT_LIFE = 2100;
const FRAGMENT_INTERVAL = 430;
const MAX_FRAGMENTS = 7;

/** Level 0 cells are left empty so the field reads as data, not graph paper. */
const BASE_LEVELS = [0, 0, 0, 0, 1, 1, 1, 2, 3];

const FRAGMENTS = [
  "48 8b 05",
  "e8 9a 02 00 00",
  "ff 25",
  "55 48 89 e5",
  "push rbp",
  "mov rax, [rbx+8]",
  "test eax, eax",
  "call",
  "ret",
  "0x102bd0",
  "0x4013a0",
  ".text",
  ".rodata",
  ".data.rel.ro",
  ".symtab",
  ".dynstr",
  "main",
  "strcmp",
  "pthread_create",
  "size_t",
  "unsigned int",
];

interface LitCell {
  readonly x: number;
  readonly y: number;
  readonly phase: number;
}

interface Fragment {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly born: number;
  readonly life: number;
}

export interface StructureFieldApi {
  /** Sends one bright pass down the field, used when a file is accepted. */
  pulse: () => void;
}

export interface StructureFieldProps {
  onReady?: (api: StructureFieldApi) => void;
  /** A lower-motion treatment for surfaces where the field is not the subject. */
  variant?: "full" | "quiet";
}

/**
 * Integer hash with a murmur3 finalizer.
 *
 * A naive `x * a + y * b` mix overflows into float precision and leaves visible
 * column structure in the lattice, so every step stays in int32 via Math.imul.
 */
function noise(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function readPalette() {
  const styles = getComputedStyle(document.documentElement);
  return {
    ink: styles.getPropertyValue("--ink-faint").trim() || "#9aa1ab",
    muted: styles.getPropertyValue("--ink-muted").trim() || "#6b7280",
    accent: styles.getPropertyValue("--accent").trim() || "#4d6bfe",
  };
}

export function StructureField(props: StructureFieldProps) {
  let started = false;
  const quiet = props.variant === "quiet";

  function start(host: HTMLDivElement) {
    if (started) return;
    started = true;

    const canvas = document.createElement("canvas");
    canvas.className = "structure-field-canvas";
    host.append(canvas);

    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const palette = readPalette();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 1;
    let height = 1;
    let dpr = 1;
    let base: HTMLCanvasElement | null = null;
    let headGradient: CanvasGradient | null = null;
    let lit: LitCell[] = [];
    let fragments: Fragment[] = [];
    let lastSpawn = 0;
    let impulseAt = Number.NEGATIVE_INFINITY;
    let frame = 0;
    let lastDraw = 0;
    let running = false;
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };

    function build() {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const textureWidth = width + PARALLAX_MARGIN * 2;
      const textureHeight = height + PARALLAX_MARGIN * 2;

      base = document.createElement("canvas");
      base.width = Math.round(textureWidth * dpr);
      base.height = Math.round(textureHeight * dpr);
      const baseContext = base.getContext("2d");
      if (!baseContext) return;
      baseContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      baseContext.fillStyle = palette.ink;

      lit = [];

      // Rebuilt on resize so the read head keeps its soft ends.
      headGradient = ctx.createLinearGradient(0, 0, width, 0);
      headGradient.addColorStop(0, "rgba(0, 0, 0, 0)");
      headGradient.addColorStop(0.12, palette.accent);
      headGradient.addColorStop(0.88, palette.accent);
      headGradient.addColorStop(1, "rgba(0, 0, 0, 0)");

      const columns = Math.ceil(textureWidth / PITCH);
      const rows = Math.ceil(textureHeight / PITCH);
      const inset = (PITCH - CELL) / 2;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x = column * PITCH + inset;
          const y = row * PITCH + inset;

          const level = BASE_LEVELS[Math.floor(noise(column, row, 1) * BASE_LEVELS.length)];
          if (level !== undefined && level > 0) {
            baseContext.globalAlpha = level * 0.04;
            baseContext.fillRect(x, y, CELL, CELL);
          }

          // Lit cells are chosen independently of the base texture, so the band
          // keeps its density while the resting field stays sparse.
          if (noise(column, row, 7) > 0.58) {
            lit.push({ x, y, phase: noise(column, row, 13) * Math.PI * 2 });
          }
        }
      }
    }

    function draw(now: number) {
      if (!base) return;

      const seconds = now / 1000;
      const bandHalf = (height * BAND_RATIO) / 2;
      const travel = height + height * BAND_RATIO;
      const sweepY = reduceMotion
        ? height * 0.42
        : (((seconds / (quiet ? SWEEP_SECONDS * 1.55 : SWEEP_SECONDS) + SWEEP_PHASE) % 1) * travel) -
          height * BAND_RATIO * 0.5;
      const trailLength = bandHalf * TRAIL_LENGTH;

      pointer.x += (pointer.targetX - pointer.x) * 0.06;
      pointer.y += (pointer.targetY - pointer.y) * 0.06;

      const offsetX = pointer.x - PARALLAX_MARGIN;
      const offsetY = pointer.y - PARALLAX_MARGIN;

      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(base, offsetX, offsetY, base.width / dpr, base.height / dpr);

      const impulseProgress = (now - impulseAt) / IMPULSE_MS;
      const impulseActive = impulseProgress >= 0 && impulseProgress <= 1;
      const impulseFront = impulseProgress * height;
      const impulseReach = height * 0.22;

      ctx.fillStyle = palette.accent;
      for (const cell of lit) {
        const drift = reduceMotion ? 0 : Math.sin(seconds * 0.6 + cell.phase) * 1.1;
        const x = cell.x + offsetX;
        const y = cell.y + offsetY + drift;

        let alpha = 0;

        const distance = Math.abs(y - sweepY);
        if (distance < bandHalf) {
          const influence = 1 - distance / bandHalf;
          alpha = Math.pow(influence, 1.6) * LIT_ALPHA;
        }

        // Afterglow: the band leaves a decaying trail behind it.
        const behind = sweepY - y;
        if (behind > 0 && behind < trailLength) {
          const tail = 1 - behind / trailLength;
          alpha = Math.max(alpha, tail * tail * TRAIL_STRENGTH);
        }

        if (impulseActive) {
          const impulseDistance = Math.abs(y - impulseFront);
          if (impulseDistance < impulseReach) {
            alpha = Math.min(0.85, alpha + (1 - impulseDistance / impulseReach) * 0.7);
          }
        }

        if (alpha < 0.005) continue;
        ctx.globalAlpha = quiet ? alpha * 0.42 : alpha;
        ctx.fillRect(x, y, CELL, CELL);
      }

      // The read head: one hairline that leads the sweep and names what it is.
      if (headGradient) {
        ctx.globalAlpha = quiet ? HEAD_ALPHA * 0.35 : HEAD_ALPHA;
        ctx.fillStyle = headGradient;
        ctx.fillRect(0, sweepY - 0.5, width, 1);
      }

      if (reduceMotion || quiet) {
        ctx.globalAlpha = 1;
        return;
      }

      if (now - lastSpawn > FRAGMENT_INTERVAL && fragments.length < MAX_FRAGMENTS) {
        lastSpawn = now;
        const text = FRAGMENTS[Math.floor(Math.random() * FRAGMENTS.length)];
        if (text !== undefined) {
          fragments.push({
            x: 10 + Math.random() * Math.max(1, width - 90),
            y: sweepY + (Math.random() - 0.45) * bandHalf,
            text,
            born: now,
            life: FRAGMENT_LIFE * (0.7 + Math.random() * 0.6),
          });
        }
      }

      ctx.font = '11px ui-monospace, "SFMono-Regular", Menlo, monospace';
      ctx.textBaseline = "middle";
      ctx.fillStyle = palette.muted;

      for (const fragment of fragments) {
        const age = (now - fragment.born) / fragment.life;
        if (age >= 1) continue;

        const fade = age < 0.16 ? age / 0.16 : age > 0.62 ? (1 - age) / 0.38 : 1;
        ctx.globalAlpha = fade * 0.62;
        ctx.fillText(fragment.text, fragment.x, fragment.y - age * 12);
      }

      fragments = fragments.filter((fragment) => now - fragment.born < fragment.life);
      ctx.globalAlpha = 1;
    }

    function tick(now: number) {
      if (!running) return;
      frame = window.requestAnimationFrame(tick);
      if (now - lastDraw < FRAME_INTERVAL - 1) return;
      lastDraw = now;
      draw(now);
    }

    function play() {
      if (running) return;
      running = true;
      frame = window.requestAnimationFrame(tick);
    }

    function stop() {
      running = false;
      window.cancelAnimationFrame(frame);
    }

    function onPointerMove(event: PointerEvent) {
      const rect = host.getBoundingClientRect();
      pointer.targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2 * PARALLAX_AMPLITUDE;
      pointer.targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2 * PARALLAX_AMPLITUDE;
    }

    function onVisibilityChange() {
      if (document.hidden) stop();
      else play();
    }

    build();

    if (reduceMotion) {
      draw(performance.now());
    } else {
      play();
    }

    const observer = new ResizeObserver(() => {
      build();
      if (reduceMotion) draw(performance.now());
    });
    observer.observe(host);

    if (!quiet) host.addEventListener("pointermove", onPointerMove);
    document.addEventListener("visibilitychange", onVisibilityChange);

    props.onReady?.({
      pulse: () => {
        impulseAt = performance.now();
        play();
      },
    });

    onCleanup(() => {
      stop();
      observer.disconnect();
      if (!quiet) host.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.remove();
    });
  }

  return (
    <div
      class="structure-field"
      data-variant={props.variant ?? "full"}
      aria-hidden="true"
      ref={start}
    />
  );
}
