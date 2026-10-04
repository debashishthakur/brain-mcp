// Every check and eval runs against the bundled example vault, even after `npm run setup` has pointed the
// server at your own notes. Import this first; servers spawned with `{ ...process.env }` inherit it.
import { fileURLToPath } from "node:url";

process.env.BRAIN_MCP_CONFIG = fileURLToPath(new URL("../brain.config.json", import.meta.url));
