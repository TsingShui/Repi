/**
 * What the app knows about a model — its thinking levels and its window — checked where it can be
 * wrong without anyone noticing.
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
 *   node ./scripts/run-analysis-check.mjs model-facts-check
 */
import { discoverOpenAIModels } from "../src/lib/agent/discover-models";
import { modelLimits, thinkingOptions } from "../src/features/models/model-facts";
import { contextPercent, contextUsed, formatTokens } from "../src/features/chat/context-usage";
import type { Message } from "@earendil-works/pi-ai";
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

// 5. The window: known for a catalog model, admitted when it is this app's own guess.
{
  const limits = await modelLimits(custom(), "plain");
  check("a custom model's window is the assumed one", limits.contextWindow === 128_000, String(limits.contextWindow));
  check("and it is reported as assumed", limits.assumed, String(limits.assumed));
  const missing = await modelLimits(custom(), "not-in-any-catalog");
  check("a model nobody knows still reports the assumed window", missing.assumed && missing.contextWindow > 0);
}

// 6. Occupancy: what the meter shows, and the arithmetic under it.
{
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", usage: { totalTokens: 12_480 } },
    { role: "user", content: "again" },
    { role: "assistant", usage: { totalTokens: 40_000 } },
  ] as unknown as Message[];
  check("the last exchange is the one that counts", contextUsed(messages) === 40_000, String(contextUsed(messages)));
  check("a conversation with no answer yet uses nothing", contextUsed([]) === 0);
  check("and so does one whose provider reported nothing", contextUsed(messages.slice(0, 2).concat({ role: "user", content: "x" } as unknown as Message)) === 12_480);
  check("the bar is a percentage", Math.round(contextPercent(64_000, 128_000)) === 50);
  check("a conversation past the window is pinned, not drawn beyond it", contextPercent(200_000, 128_000) === 100);
  check("a window of zero divides nothing", contextPercent(1000, 0) === 0);
  check("numbers read the same way at every size", [0, 950, 12_480, 128_000, 1_200_000].map(formatTokens).join(" ") === "0 950 12.5K 128K 1.2M", [0, 950, 12_480, 128_000, 1_200_000].map(formatTokens).join(" "));
}

console.log(`\n${failures === 0 ? "all model fact checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
