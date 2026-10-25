import test from "node:test";
import assert from "node:assert/strict";
import {
  checkApp,
  deploy,
  parseDevices,
  parseOptions,
  selectDevice,
} from "./quest-deploy.mjs";

test("device selection requires a single authorized device or an explicit selection", () => {
  const devices = parseDevices(
    "List of devices attached\nQUEST_A\tdevice product:hollywood\nQUEST_B\tunauthorized\n",
  );
  assert.equal(selectDevice(devices, "QUEST_A"), "QUEST_A");
  assert.throws(() => selectDevice(devices), /Multiple devices/);
  assert.throws(() => selectDevice(devices, "QUEST_B"), /unauthorized/);
  assert.throws(() => selectDevice([], "missing"), /not connected/);
  assert.throws(() => selectDevice([]), /No headset/);
  assert.throws(() => selectDevice(parseDevices("QUEST_A offline")), /offline/);
});

test("deployment opens only the validated app port through metavr and Quest Browser", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("devices"))
      return "List of devices attached\nQUEST_A device";
    if (args.includes("getprop")) return "Quest 3";
    return "OK";
  };
  await deploy(
    { command: "deploy", port: 5173 },
    {
      run,
      check: async (port) => {
        assert.equal(port, 5173);
        return "http://localhost:5173";
      },
      log: () => {},
    },
  );
  assert.deepEqual(calls.at(-2), [
    "--device",
    "QUEST_A",
    "adb",
    "reverse",
    "tcp:5173",
    "tcp:5173",
  ]);
  assert.deepEqual(calls.at(-1), [
    "--device",
    "QUEST_A",
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "http://localhost:5173/",
    "-p",
    "com.oculus.browser",
  ]);
});

test("readiness failures and checks never alter the device", async () => {
  for (const scenario of [
    "check",
    "unauthorized",
    "non-quest",
    "server-down",
  ]) {
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args.includes("devices"))
        return `List of devices attached\nQUEST_A ${scenario === "unauthorized" ? "unauthorized" : "device"}`;
      if (args.includes("getprop"))
        return scenario === "non-quest" ? "Pixel 9" : "Quest 3S";
      return "OK";
    };
    const request = deploy(
      { command: scenario === "check" ? "check" : "deploy", port: 3001 },
      {
        run,
        log: () => {},
        check: async () => {
          if (scenario === "server-down") throw new Error("offline");
          return "http://localhost:3001";
        },
      },
    );
    if (scenario === "check") await request;
    else await assert.rejects(request);
    assert.ok(
      !calls.some((args) => args.includes("reverse") || args.includes("start")),
    );
  }
});

test("an Android intent error is reported even when the shell exits successfully", async () => {
  await assert.rejects(
    deploy(
      { command: "deploy", port: 3001 },
      {
        run: async (args) =>
          args.includes("devices")
            ? "QUEST_A device"
            : args.includes("getprop")
              ? "Quest 3"
              : args.includes("start")
                ? "Error: Activity not started, unable to resolve Intent"
                : "OK",
        check: async () => "http://localhost:3001",
        log: () => {},
      },
    ),
    /Browser did not open/,
  );
});

test("the deployed origin must serve both Again and a working backend", async () => {
  assert.equal(
    await checkApp(3001, async (url) =>
      url.endsWith("health")
        ? Response.json({ ok: true })
        : new Response("<title>Again</title>"),
    ),
    "http://localhost:3001",
  );
  await assert.rejects(
    checkApp(3001, async () => new Response("<title>Another server</title>")),
    /must both be running/,
  );
  await assert.rejects(
    checkApp(5173, async (url) =>
      url.endsWith("health")
        ? Response.json({ ok: false })
        : new Response("<title>Again</title>"),
    ),
    /npm run dev/,
  );
});

test("CLI accepts an explicit device and port, but rejects malformed shell inputs", () => {
  assert.deepEqual(
    parseOptions(["deploy", "--port", "5173", "--device", "QUEST_A"]),
    { command: "deploy", port: 5173, device: "QUEST_A" },
  );
  for (const args of [
    ["--port", "0"],
    ["--port", "3001;echo"],
    ["--device", "a;echo"],
    ["--url", "http://example.com"],
    ["--device"],
  ])
    assert.throws(() => parseOptions(args));
});
