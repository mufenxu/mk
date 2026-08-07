export class NodePoolMonitor {
  constructor({ nodePool, notifications, intervalMs = 60_000, backlogMinutes = 10 }) {
    this.nodePool = nodePool;
    this.notifications = notifications;
    this.intervalMs = Math.max(15_000, Number(intervalMs) || 60_000);
    this.backlogMs = Math.max(1, Number(backlogMinutes) || 10) * 60_000;
    this.offlineWorkers = new Set();
    this.failedJobs = new Set();
    this.backlogActive = false;
    this.unavailable = false;
    this.timer = null;
  }

  async emit(event, context) {
    await this.notifications.notify(event, {
      ...context,
      at: new Date().toISOString(),
    });
  }

  async check(now = Date.now()) {
    let snapshot;
    try {
      snapshot = await this.nodePool.overview();
    } catch (error) {
      if (!this.unavailable) {
        await this.emit("node-pool-unavailable", {
          taskName: "节点池控制器",
          detail: String(error.message ?? error).slice(0, 500),
        });
      }
      this.unavailable = true;
      return;
    }
    this.unavailable = false;

    const offlineWorkers = new Set((snapshot.workers ?? []).filter((worker) => !worker.online).map((worker) => worker.id));
    for (const nodeId of offlineWorkers) {
      if (!this.offlineWorkers.has(nodeId)) {
        await this.emit("node-offline", {
          taskName: `节点 ${nodeId}`,
          detail: "Worker 心跳已超时，节点不会继续接收部署任务。",
        });
      }
    }
    this.offlineWorkers = offlineWorkers;

    const failedJobs = new Set();
    for (const job of (snapshot.jobs ?? []).filter((entry) => entry.status === "failed")) {
      failedJobs.add(job.id);
      if (!this.failedJobs.has(job.id)) {
        await this.emit("deployment-failed", {
          taskName: job.project || "项目部署",
          detail: String(job.error || `部署任务 ${job.id} 失败`).slice(0, 500),
        });
      }
    }
    this.failedJobs = failedJobs;

    const oldestQueuedAt = new Date(snapshot.oldestQueuedAt ?? "").getTime();
    const backlogActive = (snapshot.jobCounts?.queued ?? 0) > 0
      && Number.isFinite(oldestQueuedAt)
      && now - oldestQueuedAt >= this.backlogMs;
    if (backlogActive && !this.backlogActive) {
      await this.emit("deployment-backlog", {
        taskName: "部署队列",
        detail: `最早的排队任务已等待 ${Math.max(1, Math.floor((now - oldestQueuedAt) / 60_000))} 分钟。`,
      });
    }
    this.backlogActive = backlogActive;
  }

  start() {
    if (this.timer) return;
    this.check().catch((error) => console.error(`Node-pool monitor failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.check().catch((error) => console.error(`Node-pool monitor failed: ${error.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
