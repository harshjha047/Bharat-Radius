'use client';
import { sileo, type SileoOptions } from 'sileo';

const TITLE_MAX = 48;

/** First sentence becomes the toast title, the rest its description (sileo expands to show it). */
export function toastParts(message: string, fallback: string): Pick<SileoOptions, 'title' | 'description'> {
  const text = message.trim();
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(text);
  if (m && m[1]!.length <= TITLE_MAX) return { title: m[1]!.replace(/\.$/, ''), description: m[2]! };
  if (text.length <= TITLE_MAX) return { title: text.replace(/\.$/, '') };
  return { title: fallback, description: text };
}

export const toast = {
  success: (message: string) => sileo.success(toastParts(message, 'Done')),
  error: (message: string) => sileo.error(toastParts(message, 'Something went wrong')),
  info: (message: string) => sileo.info(toastParts(message, 'Note')),
  warning: (message: string) => sileo.warning(toastParts(message, 'Check this')),
};
