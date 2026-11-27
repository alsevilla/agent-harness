export function parseOption(args, name) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value && !value.startsWith("-") ? value : undefined;
}
