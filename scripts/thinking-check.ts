/**
 * Thinking levels, checked where they can be wrong without anyone noticing.
 *
 * Two things matter and neither is visible by using the app:
 *
 *  - what goes out on the wire. A level the model does not accept is clamped, not sent, and a
 *    custom endpoint that never claimed to accept a reasoning effort must not be sent one — an
 *    unknown field is an error on some gateways and silently ignored on others, so "it seemed to
 *    work" is not evidence;
 *  - whether a catalog's own claim is read at all. Most endpoints say nothing about their models,
 *    and the ones that do describe reasoning in a field of their own invention; reading it is the
 *    difference between a model that thinks and a model that is not offered the choice.
 *
 *   node ./scripts/run-analysis-check.mjs thinking-check
 */
import { discoverOpenAIModels } from "../src/lib/agent/discover-models";
import { thinkingOptions } from "../src/features/models/thinking";
import type { ModelProvider } from "../src/features/models/types";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const custom = (extra: Partial<ModelProvider> = {}): ModelProvider =>
  ({
    id: "custom-1",
    kind: "custom",
    name: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    models: ["plain", "thinks"],
    createdAt: 0,
    ...extra,
  }) as ModelProvider;

// 1. A model that did not claim to reason stays at "off", whatever was asked for.
{
  const options = await thinkingOptions(custom({ reasoningModels: ["thinks"] }), "plain", "high");
  check("a model that does not think accepts only off", options.levels.join(",") === "off", options.levels.join(","));
  check("and high is folded away instead of sent", options.effective === "off", options.effective);
}

// 2. A model that did claim it gets pi's levels — and no further than a model without a map.
{
  const options = await thinkingOptions(custom({ reasoningModels: ["thinks"] }), "thinks", "high");
  check(
    "a model that thinks offers the levels pi knows for it",
    options.levels.join(",") === "off,minimal,low,medium,high",
    options.levels.join(","),
  );
  check("and the request is kept", options.effective === "high", options.effective);
  const beyond = await thinkingOptions(custom({ reasoningModels: ["thinks"] }), "thinks", "max");
  check(
    "a level above what it offers is clamped, not passed through",
    beyond.effective === "high",
    beyond.effective,
  );
  const silent = await thinkingOptions(custom({ reasoningModels: ["thinks"] }), "thinks", undefined);
  check("no stored choice means off", silent.effective === "off", silent.effective);
}

// 3. A model that is no longer in the catalog neither errors nor invents levels.
{
  const provider = custom({ reasoningModels: ["thinks"] });
  const options = await thinkingOptions(provider, "deleted-upstream", "high");
  check("a missing catalog entry reports off", options.effective === "off", options.effective);
}

// 4. Reading a catalog's own claims, through the real discovery path with a stubbed fetch.
{
  const catalog = {
    data: [
      { id: "openrouter-style", supported_parameters: ["tools", "reasoning"] },
      { id: "flagged", reasoning: true },
      { id: "capability", capabilities: { reasoning: { supported: true } } },
      { id: "plain-model" },
      { id: "only-tools", supported_parameters: ["tools", "temperature"] },
    ],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const found = await discoverOpenAIModels("http://127.0.0.1:9/v1", "");
    const reasoning = found.filter((model) => model.reasoning).map((model) => model.id).sort();
    check(
      "the catalog's reasoning claims are read",
      reasoning.join(",") === "capability,flagged,openrouter-style",
      reasoning.join(","),
    );
    check(
      "and a model that says nothing is left alone",
      found.find((model) => model.id === "plain-model")?.reasoning === false &&
        found.find((model) => model.id === "only-tools")?.reasoning === false,
    );
  } finally {
    globalThis.fetch = original;
  }
}

console.log(`\n${failures === 0 ? "all thinking checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
