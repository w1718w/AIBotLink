// Product copy is a locale resource; local overrides stay outside Git.
import zhCN from "./locales/zh-CN.json" with { type: "json" };
export const defaultMessages = zhCN;


export type MessageKey = keyof typeof defaultMessages;
let overrides: Partial<Record<MessageKey, string>> = {};
export function configureMessages(value: Record<string, string> = {}) {
  for (const [key, text] of Object.entries(value)) {
    if (!Object.hasOwn(defaultMessages, key) || typeof text !== 'string') throw new Error(defaultMessages['config.invalidMessageOverride'].replace('{key}', key));
  }
  overrides = value;
}
export function t(key: MessageKey, values: Record<string, unknown> = {}) {
  return (overrides[key] ?? defaultMessages[key]).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
