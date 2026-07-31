const [type, project, refOrFlag, ...rest] = process.argv.slice(2);
if (!type || !project) {
  console.error("Usage: npm run job -- <deploy|start|stop|restart> <project> [ref] [--cpu N] [--memory MB] [--labels a,b] [--worker id]");
  process.exit(1);
}

const deployRef = type === "deploy" && refOrFlag && !refOrFlag.startsWith("--") ? refOrFlag : undefined;
const args = deployRef ? rest : [refOrFlag, ...rest].filter(Boolean);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid option: ${key ?? "missing"}`);
  options[key.slice(2)] = value;
}

const controllerUrl = (process.env.MK_CONTROLLER_URL ?? "http://127.0.0.1:4191").replace(/\/$/, "");
const token = process.env.MK_ADMIN_TOKEN ?? "";
if (token.length < 24) throw new Error("MK_ADMIN_TOKEN is missing or invalid");

const body = {
  type,
  project,
  ref: deployRef,
  preferredWorkerId: options.worker,
  priority: options.priority ? Number(options.priority) : undefined,
  requirements: {
    cpu: options.cpu ? Number(options.cpu) : undefined,
    memoryMb: options.memory ? Number(options.memory) : undefined,
    labels: options.labels ? options.labels.split(",").filter(Boolean) : undefined,
  },
};

const response = await fetch(`${controllerUrl}/api/jobs`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30_000),
});
const result = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Controller returned HTTP ${response.status}: ${result.error ?? "unknown error"}`);
console.log(JSON.stringify(result, null, 2));
