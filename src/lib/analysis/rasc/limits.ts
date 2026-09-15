/**
 * Host policy for the engine's memory.
 *
 * Rasc's own default is 256 MiB per entry, which is a desktop's answer. Under wasm a failed
 * allocation does not raise — it kills the instance, and the user gets nothing at all instead
 * of a sentence — so a browser tab asks for less. Real DEX entries inflate to tens of MiB
 * (the largest in Rasc's 343 MiB sample APK is 11.4 MiB), so this stays an order of magnitude
 * above anything legitimate.
 *
 * It travels in the environment, not in the command line: the command line belongs to
 * whatever wrote it, and this is the host's budget.
 */
export const DEFAULT_MAX_INFLATED_ENTRY = 128 << 20;
