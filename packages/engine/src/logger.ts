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
import { redactEngineValue } from './log-redaction.js';

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

  const logger = pino({
    level,
    // Sanitize before Pino serializes either records or interpolation arguments.
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((arg) => redactEngineValue(arg)) as Parameters<typeof method>);
      },
    },
    // Child bindings are serialized outside logMethod and need their own boundary.
    formatters: { bindings: (bindings) => redactEngineValue(bindings) as Record<string, unknown> },
    transport: {
      targets,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return protectBindings(logger);
}

function protectBindings(logger: pino.Logger, childMethod: pino.Logger['child'] = logger.child, setMethod: pino.Logger['setBindings'] = logger.setBindings): pino.Logger {
  const child = childMethod.bind(logger);
  logger.child = ((bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => protectBindings(child(redactEngineValue(bindings) as pino.Bindings, options), childMethod, setMethod)) as unknown as pino.Logger['child'];
  const setBindings = setMethod.bind(logger);
  logger.setBindings = (bindings) => setBindings(redactEngineValue(bindings) as pino.Bindings);
  return logger;
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
