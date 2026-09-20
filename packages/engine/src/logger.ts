/**
 * @module logger
 *
 * Structured logging via pino.
 *
 * Every log line includes: timestamp, level, component, and structured data.
 * Optional fields: walletIndex, txHash, chain, event.
 *
 * Logs to stdout + optional file (configured in MintJobConfig).
 *
 * This is a P0 observability requirement — you cannot operate
 * a money-spending autonomous bot blind (§6 correction #10).
 */

import pino from 'pino';
import type { SupportedChainId } from './types.js';

export interface LogContext {
  component: string;
  walletIndex?: number;
  txHash?: string;
  chain?: string;
  chainId?: SupportedChainId;
  event?: string;
  [key: string]: unknown;
}

/**
 * Create a structured logger instance.
 *
 * @param level - Log level (debug, info, warn, error)
 * @param logFile - Optional file path for log output
 */
export function createLogger(
  level: string = 'info',
  logFile?: string,
): pino.Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      options: { destination: 1 },  // stdout
      level,
    },
  ];

  if (logFile) {
    targets.push({
      target: 'pino/file',
      options: { destination: logFile, mkdir: true },
      level,
    });
  }

  return pino({
    level,
    redact: {
      paths: [
        '**.privateKey', '**.mnemonic', '**.seed', '**.passphrase', '**.password',
        '**.token', '**.authorization', '**.apiKey', '**.calldata', '**.rawTx',
        '**.rawTransaction', '**.payload', '**.providerUrl', '**.endpointUrl',
      ],
      censor: '[REDACTED]',
    },
    transport: {
      targets,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Create a child logger with a component context.
 * All subsequent logs include the component name.
 */
export function childLogger(
  logger: pino.Logger,
  component: string,
  extra?: Record<string, unknown>,
): pino.Logger {
  return logger.child({ component, ...extra });
}
