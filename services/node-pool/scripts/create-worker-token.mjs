import { deriveWorkerToken } from "../src/security.mjs";

const nodeId = process.argv[2];
if (!nodeId) {
  console.error("Usage: npm run token -- <node-id>");
  process.exit(1);
}

console.log(deriveWorkerToken(process.env.MK_WORKER_SECRET ?? "", nodeId));
