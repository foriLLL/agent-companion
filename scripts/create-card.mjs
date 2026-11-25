#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createCard } from "../src/platform/cards/scaffold.mjs";

export { createCard };
const HELP = "用法：node scripts/create-card.mjs <id> [--title 名称] [--dir cards根目录] [--service]";

export function parseArgs(argv) {
  const options = {};
  const seen = new Set();
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--service") {
      if (seen.has(arg)) throw new Error(`重复参数：${arg}`);
      options.service = true;
      seen.add(arg);
    } else if (arg === "--title" || arg === "--dir") {
      if (seen.has(arg)) throw new Error(`重复参数：${arg}`);
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`${arg} 必须提供值`);
      options[arg === "--title" ? "title" : "cardsDir"] = value;
      seen.add(arg);
    } else if (arg.startsWith("-") || options.id !== undefined) throw new Error(`未知参数：${arg}`);
    else options.id = arg;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(options.help ? HELP : JSON.stringify(await createCard(options)));
  } catch (error) {
    console.error(error.code === "EEXIST" ? "目标已存在，未覆盖任何文件。" : error.message);
    process.exitCode = 1;
  }
}
