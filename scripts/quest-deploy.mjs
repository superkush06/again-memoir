import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const setupHint =
  "Connect Quest with a USB data cable, enable Developer Mode, and accept USB debugging inside the headset. Then run this command again.";

export function parseDevices(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line
      .trim()
      .match(/^(\S+)\s+(device|unauthorized|offline|no permissions)(?:\s|$)/);
    return match ? [{ id: match[1], state: match[2] }] : [];
  });
}

export function selectDevice(devices, requested) {
  if (requested) {
    const device = devices.find((item) => item.id === requested);
    if (!device)
      throw new Error(
        `Requested headset ${requested} is not connected. ${setupHint}`,
      );
    if (device.state !== "device")
      throw new Error(`Headset ${requested} is ${device.state}. ${setupHint}`);
    return device.id;
  }
  // Never choose another connected device silently when one is still awaiting consent.
  if (devices.length > 1)
    throw new Error(
      "Multiple devices are connected. Choose one with --device <ID> (see npm run vr:devices).",
    );
  if (!devices.length)
    throw new Error(`No headset detected by metavr. ${setupHint}`);
  return selectDevice(devices, devices[0].id);
}

export function parseOptions(args) {
  const options = {
    command: "deploy",
    port: 3001,
    device: process.env.HZDB_DEVICE,
  };
  if (args[0] && !args[0].startsWith("--")) options.command = args.shift();
  if (!["deploy", "check", "devices"].includes(options.command))
    throw new Error(
      "Use deploy, check, or devices. Options: --port <port> --device <ID>.",
    );
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    if (
      !["--port", "--device"].includes(key) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("Options: --port <port> --device <ID>.");
    if (key === "--port") options.port = Number(value);
    else options.device = value;
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new Error("Port must be an integer from 1 to 65535.");
  if (options.device && !/^[a-zA-Z0-9._:\[\]-]+$/.test(options.device))
    throw new Error("Invalid device ID. Copy it from npm run vr:devices.");
  return options;
}

async function findMetavr() {
  if (process.env.METAVR_BIN) return process.env.METAVR_BIN;
  const native = path.join(
    process.env.METAVR_HOME || path.join(homedir(), ".metavr"),
    "bin",
    process.platform === "win32" ? "metavr.exe" : "metavr",
  );
  try {
    await access(native);
    return native;
  } catch {
    return "metavr";
  }
}

export async function checkApp(port, fetcher = fetch) {
  const origin = `http://localhost:${port}`;
  try {
    const [page, health] = await Promise.all([
      fetcher(`${origin}/`, { signal: AbortSignal.timeout(10000) }),
      fetcher(`${origin}/api/health`, { signal: AbortSignal.timeout(10000) }),
    ]);
    if (
      !page.ok ||
      !health.ok ||
      !(await page.text()).includes("Again") ||
      (await health.json()).ok !== true
    )
      throw new Error("Application or API is not ready.");
  } catch {
    throw new Error(
      `Again and its API must both be running at ${origin}. ${port === 5173 ? "Start npm run dev in another terminal." : "Build with npm run build and start npm start in another terminal."} Keep the server running while using Quest.`,
    );
  }
  return origin;
}

export async function deploy(
  options,
  { run, check = checkApp, log = console.log },
) {
  log((await run(["--version"])).trim());
  // metavr adb devices preserves ADB's documented text format, including authorization state.
  const inventory = await run(["adb", "devices"]);
  if (options.command === "devices") {
    log(inventory.trim());
    return;
  }
  const origin = await check(options.port);
  log(`App and API ready: ${origin}`);
  const device = selectDevice(parseDevices(inventory), options.device);
  const target = ["--device", device];
  const model = (
    await run([...target, "shell", "getprop", "ro.product.model"])
  ).trim();
  if (!/quest|oculus/i.test(model))
    throw new Error(
      `Selected device is ${model || "unrecognized"}, not a recognized Quest. No ports or apps were changed.`,
    );
  log(`Quest ready: ${model} (${device})`);
  if (options.command === "check") return;
  await run([
    ...target,
    "adb",
    "reverse",
    `tcp:${options.port}`,
    `tcp:${options.port}`,
  ]);
  // Only a fixed localhost URL reaches the device shell. Do not interpolate arbitrary URLs.
  const launch = await run([
    ...target,
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `${origin}/`,
    "-p",
    "com.oculus.browser",
  ]);
  if (
    /\b(?:Error|Exception)\b|unable to resolve|permission denial/i.test(launch)
  )
    throw new Error(
      `Port forwarding succeeded, but Quest Browser did not open: ${launch.trim()}`,
    );
  log(
    `Opened ${origin}/ in Quest Browser. Open a memory, choose Step inside, then ENTER VR in the headset.`,
  );
  log(
    "Keep this computer and server running. Left stick: walk. Right stick: snap turn. Trigger: teleport. Use the same room code on laptop/phone to join.",
  );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const executable = await findMetavr();
  const run = async (args) => {
    try {
      const { stdout, stderr } = await execute(executable, args, {
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      // Native metavr versions can write successful command output to either stream.
      return `${stdout}\n${stderr}`;
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(
          "Meta VR CLI was not found. Install metavr using https://developers.meta.com/vr/essentials/metavr-install/ or set METAVR_BIN to its executable path.",
        );
      throw new Error(
        `metavr ${args.includes("shell") ? "device command" : args.join(" ")} failed: ${error.stderr?.trim() || error.message}`,
      );
    }
  };
  await deploy(options, { run });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`\nQuest deployment: ${error.message}`);
    process.exitCode = 1;
  });
}
