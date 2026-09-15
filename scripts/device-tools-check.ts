/**
 * The device tools, checked without a device.
 *
 * The Android path needs hardware, a user gesture and root, which is a bad price for checking
 * that a tool result says what happened. What the tools actually depend on is small: a bridge
 * with three methods, and the shared filesystem. Both are easy to fake, and faking them is how
 * the interesting cases get exercised at all — a command that times out, output that was cut
 * off, a file that lands under a path derived from the device's own, and the error a model sees
 * when there is no device at all.
 *
 *   node ./scripts/run-analysis-check.mjs device-tools-check
 */
import { deviceParagraph, deviceTools } from "../src/lib/agent/device-tools";
import type { DeviceBridge } from "../src/lib/agent/device-bridge";
import type { AgentTool } from "@earendil-works/pi-agent-core";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

/** A device that records what it was asked and answers from a script. */
function fakeDevice(options: {
  stdout?: string;
  stderr?: string;
  code?: number;
  truncated?: boolean;
  timedOut?: boolean;
  file?: Uint8Array;
}): DeviceBridge & { calls: string[]; pushed: { remote: string; bytes: number }[] } {
  const calls: string[] = [];
  const pushed: { remote: string; bytes: number }[] = [];
  return {
    calls,
    pushed,
    describe: () => "Fake Phone (SERIAL123) — Android 14, arm64-v8a, build UP1A, SELinux Enforcing, root available",
    shell: async (command, input) => {
      calls.push(input === undefined ? command : `${command} <<< ${input}`);
      return {
        stdout: options.stdout ?? "",
        stderr: options.stderr ?? "",
        code: options.code ?? 0,
        truncated: options.truncated ?? false,
        timedOut: options.timedOut ?? false,
      };
    },
    pull: async () => options.file ?? new Uint8Array([1, 2, 3]),
    push: async (remote, bytes) => {
      pushed.push({ remote, bytes: bytes.byteLength });
    },
  };
}

/** The shared filesystem, as the tools use it. */
function fakeVfs(files: { path: string; bytes: Uint8Array }[] = []) {
  const saved: { path: string; bytes: number; conversationId: string }[] = [];
  return {
    saved,
    list: async () => files,
    save: async (path: string, bytes: Uint8Array, conversationId: string) => {
      saved.push({ path, bytes: bytes.byteLength, conversationId });
    },
  };
}

const toolNamed = (tools: AgentTool[], name: string): AgentTool => {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

/** Runs a tool and returns the text the model would read. */
async function run(tool: AgentTool, input: unknown): Promise<string> {
  const result = (await tool.execute("call", input, undefined)) as {
    content: { type: string; text: string }[];
  };
  return result.content.map((part) => part.text).join("\n");
}

// 1. The surface itself: three verbs, and the same three whatever the device is.
{
  const tools = deviceTools({ device: fakeDevice({}), vfs: fakeVfs() }, "conv");
  check(
    "the device adds three tools",
    tools.map((tool) => tool.name).join(",") === "device,device_pull,device_push",
    tools.map((tool) => tool.name).join(", "),
  );
  check(
    "each one says what it is for",
    tools.every((tool) => (tool.description ?? "").length > 200),
  );
  check(
    "and each one takes named arguments",
    tools.every((tool) => tool.parameters !== undefined),
  );
}

// 2. A command: output, exit code, and the two ways a command lies about being finished.
{
  const device = fakeDevice({
    stdout: "/system/bin/sh: no such tool\n",
    stderr: "sh: foo: inaccessible or not found\n",
    code: 127,
  });
  const text = await run(toolNamed(deviceTools({ device, vfs: fakeVfs() }, "conv"), "device"), {
    command: "foo",
  });
  check("a failed command reports its exit code", text.includes("[exit 127]"), text.split("\n").at(-1));
  check("stderr is kept apart from stdout", text.includes("[stderr]") && text.includes("not found"));
  check("the command that ran is the command given", device.calls[0] === "foo");
}
{
  const device = fakeDevice({ stdout: "partial", truncated: true, timedOut: true, code: 137 });
  const text = await run(toolNamed(deviceTools({ device, vfs: fakeVfs() }, "conv"), "device"), {
    command: "logcat",
  });
  check("a killed command says so", text.includes("[killed after two minutes]"));
  check("cut-off output says so", text.includes("[output truncated]"));
  check("and the partial answer is still there", text.includes("partial"));
}
{
  const device = fakeDevice({});
  const tools = deviceTools({ device, vfs: fakeVfs() }, "conv");
  await run(toolNamed(tools, "device"), { command: "cat", input: "script body" });
  check("stdin reaches the command", device.calls[0] === "cat <<< script body", device.calls[0]);
}

// 3. Pull: where a device file lands in the shared filesystem.
{
  const vfs = fakeVfs();
  const device = fakeDevice({ file: new Uint8Array(2048) });
  const text = await run(toolNamed(deviceTools({ device, vfs }, "conv"), "device_pull"), {
    remote: "/data/app/~~abc/com.example/lib/arm64/libfoo.so",
  });
  check(
    "a device path becomes a path here",
    vfs.saved[0]?.path === "data/app/~~abc/com.example/lib/arm64/libfoo.so",
    vfs.saved[0]?.path,
  );
  check("the bytes are the file's", vfs.saved[0]?.bytes === 2048);
  check("it lands in this conversation", vfs.saved[0]?.conversationId === "conv");
  check("and the answer says where", text.includes("libfoo.so (2048 bytes)"), text);
}
{
  const vfs = fakeVfs();
  await run(toolNamed(deviceTools({ device: fakeDevice({}), vfs }, "conv"), "device_pull"), {
    remote: "/system/framework/framework.jar",
    path: "firmware/framework.jar",
  });
  check("an explicit path wins", vfs.saved[0]?.path === "firmware/framework.jar");
}

// 4. Push: text, or a file that is already here.
{
  const device = fakeDevice({});
  const tools = deviceTools({ device, vfs: fakeVfs() }, "conv");
  await run(toolNamed(tools, "device_push"), { remote: "/data/local/tmp/x.js", content: "send(1)" });
  check("text is pushed as bytes", device.pushed[0]?.remote === "/data/local/tmp/x.js" && device.pushed[0]?.bytes === 7, JSON.stringify(device.pushed[0]));
}
{
  const device = fakeDevice({});
  const vfs = fakeVfs([{ path: "tools/frida-inject", bytes: new Uint8Array(4096) }]);
  await run(toolNamed(deviceTools({ device, vfs }, "conv"), "device_push"), {
    remote: "/data/local/tmp/frida-inject",
    source: "tools/frida-inject",
  });
  check("a shared file is pushed as it is", device.pushed[0]?.bytes === 4096);
}
{
  const device = fakeDevice({});
  const tools = deviceTools({ device, vfs: fakeVfs() }, "conv");
  let missing = "";
  try {
    await run(toolNamed(tools, "device_push"), { remote: "/data/local/tmp/x" });
  } catch (error) {
    missing = error instanceof Error ? error.message : "";
  }
  check("pushing nothing is refused", /content or source/.test(missing), missing);
}

// 5. No device: an error a model can act on, not a stack trace.
{
  const tools = deviceTools({ vfs: fakeVfs() }, "conv");
  let message = "";
  try {
    await run(toolNamed(tools, "device"), { command: "id" });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  check("no device is a sentence, not a crash", /no device support/i.test(message), message);
}

// 6. What the model is told, which is the part it cannot infer by calling anything.
{
  const connected = deviceParagraph("Pixel 8 (SERIAL) — Android 14, arm64-v8a, root available");
  check("a connected device is described", connected.includes("Pixel 8"), connected.slice(0, 60));
  check("and its verbs are named", ["device()", "device_pull()", "device_push()"].every((verb) => connected.includes(verb)));
  check("frida is not oversold", !/frida/i.test(connected));
  const absent = deviceParagraph(null);
  check("an absent device says who can fix that", /ask them|by the user|user/i.test(absent), absent.slice(0, 80));
  check("and does not describe a device that is not there", !/Android \d/.test(absent));
}

// 7. The boundary this surface is meant to hold: ADB, not the things people build on it.
//
// Repi owns an Android link — a shell, a pipe and a file channel. Tools that ride on ADB
// (injectors, patchers, hooking frameworks) are the Agent's knowledge and the user's choice,
// and a description that names one would be this app claiming a workflow it does not maintain
// and cannot keep current. The names are listed here so the claim is checked rather than
// remembered.
{
  const text = deviceTools({ device: fakeDevice({}), vfs: fakeVfs() }, "conv")
    .map((tool) => tool.description ?? "")
    .join("\n");
  const named = ["frida", "magisk", "objection", "xposed"].filter((name) => text.includes(name));
  check(
    "the tools describe the pipe, not a program on the far end of it",
    named.length === 0,
    named.join(", "),
  );
  check(
    "and stdin is offered as a channel rather than as a recipe",
    /stdin/.test(text) && !/-s -/.test(text),
  );
}

console.log(`\n${failures === 0 ? "all device tool checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
