const MAX_INPUT_BYTES = 64 * 1024;

export async function readHookInput(fail) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) fail("hook input exceeds 64 KiB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("malformed hook input JSON");
  }
}
