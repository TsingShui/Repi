/**
 * Which engine analyses this file.
 *
 * The choice is deliberately visible rather than automatic-and-silent. A native
 * binary goes to Kuna and an APK or DEX goes to Rasc, when that engine is
 * installed here; a file neither engine handles goes to the mock, and a file one
 * of them should have handled but cannot — because the engine was never built
 * into this deployment — says so. Quietly falling back to the mock would put
 * invented classes on screen and let the page take credit for an engine that
 * never ran.
 *
 * The `?engine=` seam exists for the check suite, like the mock's own seams. The
 * engines answer different questions, so the existing workspace assertions need
 * to be able to pin the one they were written against.
 *
 *   ?engine=mock   force the mock, whatever the file is
 *   ?engine=kuna   force Kuna, and fail loudly when it is not installed
 *   ?engine=rasc   force Rasc, and fail loudly when it is not installed
 */

import { createMockSource } from "./mock-source";
import { createKunaSource, kunaCanAnalyze } from "./kuna/adapter";
import { createRascSource, rascCanAnalyze } from "./rasc/adapter";
import type { FormatMatch } from "../detect-format";
import type { AnalysisSource } from "./types";

export type EngineChoice = "mock" | "kuna" | "rasc";

export interface ChosenSource {
  readonly source: AnalysisSource | null;
  readonly engine: EngineChoice;
  /**
   * Why there is no source, in one sentence for the screen. Null when a source
   * was chosen, and null when the file simply cannot be opened at all — that is
   * the home screen's business, not the workspace's.
   */
  readonly unavailable: string | null;
}

function overrideFromLocation(): EngineChoice | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("engine");
  return value === "mock" || value === "kuna" || value === "rasc" ? value : null;
}

export async function chooseSource(file: File, format: FormatMatch): Promise<ChosenSource> {
  const override = overrideFromLocation();
  const wanted: EngineChoice = override ?? format.engine ?? "mock";

  if (wanted === "mock") {
    return { source: createMockSource(file, format), engine: "mock", unavailable: null };
  }

  if (wanted === "rasc") {
    if (format.engine !== "rasc") {
      // The seam exists for the check suite, and a forced pairing that cannot work
      // should say what is wrong with it rather than blame the build.
      return {
        source: null,
        engine: "rasc",
        unavailable: `Rasc analyses APK and DEX files; this file is ${format.label}.`,
      };
    }
    const installed = await rascCanAnalyze(format);
    if (!installed) {
      return {
        source: null,
        engine: "rasc",
        unavailable:
          "The Rasc engine is not installed in this build, so this APK or DEX cannot be " +
          "analysed. Run `npm run build:rasc` against a Rasc checkout, then reload.",
      };
    }
    return { source: createRascSource(file, format), engine: "rasc", unavailable: null };
  }

  if (format.engine !== "kuna") {
    return {
      source: null,
      engine: "kuna",
      unavailable: `Kuna analyses native executables; this file is ${format.label}.`,
    };
  }

  const installed = await kunaCanAnalyze(format);
  if (!installed) {
    return {
      source: null,
      engine: "kuna",
      unavailable:
        "The Kuna engine is not installed in this build, so this binary cannot be analysed. " +
        "Run `npm run build:kuna` against a Kuna checkout, then reload.",
    };
  }

  return { source: createKunaSource(file, format), engine: "kuna", unavailable: null };
}
