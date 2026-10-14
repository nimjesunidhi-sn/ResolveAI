import "dotenv/config";
import { buildPolicyIndex } from "./rag.js";

try {
  const result = await buildPolicyIndex();
  console.info("Policy RAG index ready:", JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Could not build the local semantic policy index.");
  console.error(error instanceof Error ? error.message : error);
  console.error("Install @huggingface/transformers in the server workspace and retry. The first run downloads the configured ONNX model.");
  process.exitCode = 1;
}
