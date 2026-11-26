import { parseOption } from "./options.mjs";

const args = process.argv.slice(2);
const format = parseOption(args, "--format") ?? "json";
const destination = args[0];
if (!destination || destination.startsWith("-")) {
  console.error("Supply a destination");
  process.exit(1);
}
console.log(`${format} -> ${destination}`);
