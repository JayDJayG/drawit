import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SuggestionPlan } from '../../src/core/suggestions';
import type {
  InterpretRequest,
  InterpretUsage,
} from '../../src/perception/interpret';

export type InterpretCaptureOutcome = {
  status: 200 | 422;
  code: 'ok' | 'invalid-answer';
  errors?: string[];
};

export type InterpretCaptureSettings = {
  model: string;
  images: boolean;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: 'low' | 'high' | 'max';
  maxTokens: number;
  timeoutMs: number;
};

export type InterpretCaptureRecord = {
  version: 1;
  capturedAt: string;
  outcome: InterpretCaptureOutcome;
  latencyMs: number;
  usage: InterpretUsage | null;
  finishReason: string | null;
  model: string;
  settings: InterpretCaptureSettings;
  request: InterpretRequest;
  rawContent: string;
  plan?: SuggestionPlan;
};

export type InterpretCaptureWriter = (
  record: InterpretCaptureRecord,
) => Promise<void> | void;

export const createInterpretCaptureWriter = (
  captureDir: string,
): InterpretCaptureWriter => {
  return async (record) => {
    await mkdir(captureDir, { recursive: true });
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const baseName = `${captureTimestamp(record.capturedAt)}-${record.outcome.code}`;
    let suffix = 1;
    while (true) {
      const suffixText = suffix === 1 ? '' : `-${suffix}`;
      const filePath = join(captureDir, `${baseName}${suffixText}.json`);
      try {
        await writeFile(filePath, content, {
          encoding: 'utf8',
          flag: 'wx',
        });
        break;
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          suffix += 1;
          continue;
        }
        throw error;
      }
    }
    await retainNewestCaptures(captureDir);
  };
};

const captureTimestamp = (capturedAt: string): string => {
  const value = new Date(capturedAt);
  if (!Number.isFinite(value.getTime())) {
    throw new Error('Invalid capture timestamp.');
  }
  return value.toISOString().replace(/[-:.]/g, '');
};

const retainNewestCaptures = async (captureDir: string): Promise<void> => {
  const entries = await readdir(captureDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const stale = files.slice(0, Math.max(0, files.length - 50));
  await Promise.all(stale.map((file) => unlink(join(captureDir, file))));
};

const isErrno = (error: unknown, code: string): boolean => {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
};
