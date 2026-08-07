# MonkeyCode Node Pool

This project is the first deployable phase of a lightweight application pool for long-running MonkeyCode development environments.

The controller keeps worker and job state, selects an eligible worker from declared capacity and labels, and leases work with expiry recovery. Each worker only manages projects listed in its local configuration. Remote requests cannot provide shell commands.

## Current scope

- Persistent controller state with atomic writes
- Per-node HMAC worker credentials and a separate admin credential
- Worker registration, heartbeat, resource reporting, and stale-node detection
- Capacity-aware placement by CPU, memory, disk availability, and labels
- Leased `deploy`, `start`, `stop`, and `restart` jobs
- Managed Git checkout, build, process startup, local health checks, and logs
- Desired-state recovery after process exits or repeated health-check failures
- Background Worker supervision with persisted per-node credentials
- Public application URL reporting from Worker or project URL templates
- Per-worker authenticated bundle download for repeatable node onboarding
- Management APIs for workers, resource status, job submission, cancellation, and Worker token generation

MonkeyCode environments that expose ports through public HTTPS do not require FRP for application traffic. Configure `publicUrlTemplate` with a `{port}` placeholder or set a project-specific `publicUrl`.
Deployments stop the existing process before updating its managed checkout, so there is still a short deployment outage. If checkout, install, build, startup, or health verification fails, the Worker restores the previous commit and its prior running state. Zero-downtime switching is not implemented yet.

On Linux, `resourceControl.mode` defaults to `auto`. The Worker uses a transient `systemd --user` scope when available to enforce each project's declared CPU, memory, and process limits, and reports `none` when the environment cannot provide that isolation. Set the mode to `required` to refuse startup without enforcement, or `off` to disable probing explicitly.

## Docker controller deployment

The controller image is built by the repository-level GitHub Actions workflow and deployed by the repository-level `compose.yaml`. Browser management lives in the main MonkeyCode panel, which calls this controller over the Docker network without exposing the admin token to the browser. The controller image includes the authenticated Worker download bundle, and MonkeyCode workers continue to run directly with Node.js.

Set `MK_MANAGEMENT_URL` to the main panel deployment page. The main panel exposes the allowlisted Worker API under `https://mk.pxyb.cn/node-pool/`; the controller's admin API remains on the internal Docker network, while browser management stays at `https://mk.pxyb.cn/#deployments`.

## Controller

Requires Node.js 20 or newer. Generate two independent secrets:

```bash
export MK_ADMIN_TOKEN="$(openssl rand -hex 32)"
export MK_WORKER_SECRET="$(openssl rand -hex 32)"
export MK_CONTROLLER_HOST=127.0.0.1
export MK_CONTROLLER_PORT=4191
npm run controller
```

Keep both values outside the repository. Put the controller behind HTTPS before connecting remote workers.

## Worker

Copy `worker.config.example.json` to the ignored `worker.config.json` and edit only projects allowed on that environment. Use SSH deploy keys or a local Git credential helper for private repositories; do not put credentials in repository URLs.

Derive a token for that node on the controller host:

```bash
export MK_WORKER_SECRET="the-controller-worker-secret"
npm run token -- monkey-env-01
```

Install the background service with the per-node token:

```bash
export MK_WORKER_TOKEN="the-derived-worker-token"
export MK_WORKER_CONFIG=/workspace/worker.config.json
npm run service -- install
npm run service -- status
```

The service stores the scoped Worker token in `worker.token` with mode `0600`, survives terminal closure, and restarts the Worker after unexpected exits. Use `npm run service -- restart`, `stop`, or `start` for maintenance. When the Worker starts again, projects whose desired state is `running` are restored from the runtime state below `rootDir`. A complete environment replacement still requires the service installation command to be run again.

## Submit work

From an administrator machine:

```bash
export MK_CONTROLLER_URL=https://mk.pxyb.cn/node-pool
export MK_ADMIN_TOKEN="the-admin-token"

npm run job -- deploy example-api main --cpu 0.5 --memory 512 --labels node
npm run status
```

The controller selects the healthiest eligible worker. `--worker node-id` can pin a maintenance operation to one node.

## Deployment boundaries

- Keep databases, Redis, uploaded files, and backups on stable infrastructure.
- Treat worker checkouts and build outputs as replaceable cache.
- Do not expose a worker repository root through an HTTP file server.
- Run the controller only behind HTTPS and keep its state file private.
- Public URLs are only advertised when explicitly configured; the Worker never guesses an environment identifier.
- A later phase should add zero-downtime deployment through a stable local proxy and parallel release ports.
