/**
 * The device, as tools.
 *
 * Three verbs and one paragraph. They live apart from the model provider and the sandbox
 * because a phone is neither: it answers asynchronously, it can be unplugged mid-conversation,
 * and using it at all is a decision the user already made by attaching it. Keeping them in one
 * file is what lets them be checked without a browser, a model or a phone — the bridge in, tool
 * results out.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { DeviceBridge } from "./device-bridge";

/** A tool result is text; this is the one place that turns a value into it, bounded. */
function toolText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const limit = 80_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[tool result truncated]`;
}

/** What the device tools need from the runtime: the device, and the shared filesystem. */
export interface DeviceToolContext {
  readonly device?: DeviceBridge;
  readonly vfs: {
    list(): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>;
    save(path: string, bytes: Uint8Array, conversationId: string): Promise<void>;
  };
}

/** What the model is told about the device's three verbs. */
const DEVICE_DESCRIPTION = `Run a command on the connected Android device, over the same ADB link the app uses.

A command is a plain string and it runs as the device's \`shell\` user; \`su -c '…'\` reaches
root where the device allows it. Nothing is escaped or rewritten: write the command you mean,
and expect the device's own tools (toybox, toolbox, whatever is installed) to answer.

  device('getprop ro.product.model')
  device('pm list packages -3')
  device('ls -la /data/app/*/lib/arm64')
  device('cat /proc/version')
  device("su -c 'ls /data/data/com.example/app_flutter'")

Long output is cut off and a command that runs longer than two minutes is killed, both of
which are reported back — a truncated answer is still an answer, so narrow the command instead
of repeating it.

\`input\` is written to the command's stdin and then closed, which is how a program that reads a
script from stdin is driven — a shell (\`sh -s\`), a REPL, a tool that takes its instructions on
stdin. It means a script can be run without first being written to the device's disk, and it is
the only channel here that carries something other than arguments and a file: there is no
stdin to a command you run any other way. Whatever runs on the device is the device's business
and yours to know — this tool only promises a shell, an exit code and a pipe.`;

const PULL_DESCRIPTION = `Copy one file from the device into the shared filesystem, and say where it landed.

This is the door between the two halves of this app: a file on the device becomes a file the
analysers can read. An installed APK, a vendor library, a firmware blob, a log — all of them
are just files once they are here, and run_js can hand them to rasc or Kuna.

  device_pull('/system/framework/framework.jar')
  device_pull('/data/app/~~x/com.example/lib/arm64/libfoo.so')

Directories cannot be pulled; list them with device() first. A path is kept as it was on the
device (minus the leading slash) so two files of the same name stay two files.`;

const PUSH_DESCRIPTION = `Copy a file onto the device, either from text or from the shared filesystem.

\`content\` writes text (a script, a config); \`source\` copies a file that is already here (an
attached binary, an engine's output). Give one of them.

  device_push('/data/local/tmp/hook.js', { content: 'send("from a file");' })
  device_push('/data/local/tmp/tool', { source: 'tool-android-arm64' })

Files land as the device user can read them, not executable: run \`chmod 755\` with device() for
anything you intend to execute.`;
/** The device paragraph, written from what is true this turn rather than what was true at load. */
export function deviceParagraph(device: string | null): string {
  if (device === null) {
    return `

No Android device is connected. One can be attached from the app's sidebar, but only by the
user: it is Chrome's USB picker and it opens from a click, so ask them instead of retrying.
If the work needs a device, say what you would do with one.`;
  }
  return `

An Android device is connected: ${device}.

You can run commands on it with device(), take a file off it with device_pull() (which lands in
the same shared filesystem the analysers read, so an installed APK or a native library on the
device can be pulled and then decompiled with run_js), and put a file on it with device_push().
Everything you run there is visible to the user, and a command that hangs is killed rather than
waited on.`;
}

/** The device's three verbs, as tools the model can call. */
export function deviceTools(context: DeviceToolContext, conversationId: string): AgentTool[] {
  return [
  {
    name: "device",
    label: "Run on device",
    description: DEVICE_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to run on the device" }),
      input: Type.Optional(
        Type.String({ description: "Text to write to the command's stdin, then close it" }),
      ),
    }),
    async execute(_toolCallId, input) {
      const params = input as { command: string; input?: string };
      if (!context.device) throw new Error("This build has no device support.");
      const result = await context.device.shell(params.command, params.input);
      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr) parts.push(`[stderr]\n${result.stderr.replace(/\n$/, "")}`);
      if (result.timedOut) parts.push("[killed after two minutes]");
      if (result.truncated) parts.push("[output truncated]");
      parts.push(`[exit ${result.code}]`);
      return { content: [{ type: "text", text: toolText(parts.join("\n\n")) }], details: result };
    },
  },
  {
    name: "device_pull",
    label: "Pull from device",
    description: PULL_DESCRIPTION,
    parameters: Type.Object({
      remote: Type.String({ description: "Absolute path on the device" }),
      path: Type.Optional(
        Type.String({ description: "Where to keep it here; defaults to the path without its lead" }),
      ),
    }),
    async execute(_toolCallId, input) {
      const params = input as { remote: string; path?: string };
      if (!context.device) throw new Error("This build has no device support.");
      const bytes = await context.device.pull(params.remote);
      const path = params.path ?? params.remote.replace(/^\/+/, "");
      await context.vfs.save(path, bytes, conversationId);
      return {
        content: [
          {
            type: "text",
            text: toolText(`${params.remote} → ${path} (${bytes.length} bytes)`),
          },
        ],
        details: { path, bytes: bytes.length },
      };
    },
  },
  {
    name: "device_push",
    label: "Push to device",
    description: PUSH_DESCRIPTION,
    parameters: Type.Object({
      remote: Type.String({ description: "Absolute path on the device" }),
      content: Type.Optional(Type.String({ description: "Text to write" })),
      source: Type.Optional(Type.String({ description: "A shared-filesystem path to copy instead" })),
    }),
    async execute(_toolCallId, input) {
      const params = input as { remote: string; content?: string; source?: string };
      if (!context.device) throw new Error("This build has no device support.");
      let bytes: Uint8Array;
      if (params.source !== undefined) {
        // The same mount the sandbox uses, so "a file that is here" means the same thing to
        // the device as it does to an engine. Loading them all to find one is the price of
        // that single namespace, and the sandbox already pays it when it opens.
        const files = await context.vfs.list();
        const found = files.find((file) => file.path === params.source);
        if (!found) throw new Error(`${params.source} is not in the shared filesystem.`);
        bytes = found.bytes;
      } else if (params.content !== undefined) {
        bytes = new TextEncoder().encode(params.content);
      } else {
        throw new Error("device_push needs either content or source.");
      }
      await context.device.push(params.remote, bytes);
      return {
        content: [{ type: "text", text: toolText(`${params.remote} (${bytes.length} bytes)`) }],
        details: { remote: params.remote, bytes: bytes.length },
      };
    },
  },
  ];
}
