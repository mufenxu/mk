import { readFile } from "node:fs/promises";
import path from "node:path";

function cleanWebUrl(value, name, template = false) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (template && !raw.includes("{port}")) throw new Error(`${name} must contain {port}`);

  let url;
  try {
    url = new URL(template ? raw.replaceAll("{port}", "39080") : raw);
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL without credentials, query, or fragment`);
  }
  return raw.replace(/\/+$/, "");
}

function cleanPort(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}

function cleanProject(name, project) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(name)) throw new Error(`Invalid project name: ${name}`);
  if (!project?.repo || !project?.start) throw new Error(`Project ${name} requires repo and start fields`);
  const healthPath = project.healthPath == null ? null : String(project.healthPath).trim();
  if (healthPath && (!healthPath.startsWith("/") || healthPath.length > 500)) {
    throw new Error(`Project ${name} healthPath must start with / and contain at most 500 characters`);
  }
  const restartPolicy = project.restartPolicy ?? "unless-stopped";
  if (!["unless-stopped", "never"].includes(restartPolicy)) throw new Error(`Invalid restartPolicy for project ${name}`);

  return {
    ...project,
    repo: String(project.repo),
    start: String(project.start),
    port: cleanPort(project.port, `Project ${name} port`),
    healthPath,
    publicUrl: cleanWebUrl(project.publicUrl, `Project ${name} publicUrl`),
    restartPolicy,
  };
}

export function cleanWorkerConfig(config) {
  if (config?.version !== 1) throw new Error("Unsupported worker config version");
  const nodeId = String(config.nodeId ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(nodeId)) throw new Error("Invalid worker node id");
  const controllerUrl = new URL(config.controllerUrl);
  if (!["http:", "https:"].includes(controllerUrl.protocol)) throw new Error("Controller URL must use HTTP or HTTPS");
  if (!config.rootDir || !path.isAbsolute(config.rootDir)) throw new Error("Worker rootDir must be an absolute path");
  if (!config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) {
    throw new Error("Worker projects must be an object");
  }

  const projects = Object.fromEntries(Object.entries(config.projects).map(([name, project]) => [name, cleanProject(name, project)]));
  const recoveryInitialDelaySeconds = Math.max(1, Number(config.recovery?.initialDelaySeconds) || 5);
  const resourceControlMode = config.resourceControl?.mode ?? "auto";
  if (!["auto", "required", "off"].includes(resourceControlMode)) {
    throw new Error("Worker resource control mode must be auto, required, or off");
  }
  return {
    ...config,
    nodeId,
    controllerUrl: controllerUrl.toString().replace(/\/$/, ""),
    publicUrlTemplate: cleanWebUrl(config.publicUrlTemplate, "publicUrlTemplate", true),
    capacity: {
      cpu: Math.max(0.1, Number(config.capacity?.cpu) || 1),
      memoryMb: Math.max(128, Math.round(Number(config.capacity?.memoryMb) || 512)),
      diskMb: Math.max(512, Math.round(Number(config.capacity?.diskMb) || 1024)),
    },
    labels: [...new Set((Array.isArray(config.labels) ? config.labels : []).map(String).map((item) => item.trim()).filter(Boolean))],
    pollIntervalSeconds: Math.max(1, Number(config.pollIntervalSeconds) || 5),
    heartbeatIntervalSeconds: Math.max(5, Number(config.heartbeatIntervalSeconds) || 15),
    reconcileIntervalSeconds: Math.max(5, Number(config.reconcileIntervalSeconds) || 15),
    resourceControl: {
      mode: resourceControlMode,
      maxProcesses: Math.min(4096, Math.max(8, Math.round(Number(config.resourceControl?.maxProcesses) || 128))),
    },
    recovery: {
      initialDelaySeconds: recoveryInitialDelaySeconds,
      maxDelaySeconds: Math.max(recoveryInitialDelaySeconds, Number(config.recovery?.maxDelaySeconds) || 300),
      healthFailureThreshold: Math.min(10, Math.max(1, Math.round(Number(config.recovery?.healthFailureThreshold) || 3))),
    },
    projects,
  };
}

export async function loadWorkerConfig(configPath) {
  return cleanWorkerConfig(JSON.parse(await readFile(configPath, "utf8")));
}

export function projectPublicUrl(config, project) {
  if (project.publicUrl) return project.publicUrl;
  if (!config.publicUrlTemplate || !project.port) return null;
  return config.publicUrlTemplate.replaceAll("{port}", String(project.port));
}
