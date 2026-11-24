import type { ConfigEntry } from "../../types";

export function configMatches(entry: ConfigEntry, query: string): boolean {
  return `${entry.aliases.join(" ")} ${entry.path}`.toLowerCase().includes(query);
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function configFilename({ kind }: Pick<ConfigEntry, "kind">, name: string): string {
  return kind === "claude" ? `settings.${name}.json` : `config.${name}.toml`;
}

export function configPath(entry: ConfigEntry, name: string): string {
  const separator = Math.max(entry.path.lastIndexOf("\\"), entry.path.lastIndexOf("/"));
  return entry.path.slice(0, separator + 1) + configFilename(entry, name);
}

export function configName(entry: ConfigEntry): string {
  const prefix = entry.kind === "claude" ? "settings." : "config.";
  return fileName(entry.path).slice(prefix.length, -5);
}
